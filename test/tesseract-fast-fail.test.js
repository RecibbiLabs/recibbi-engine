'use strict';

// Tesseract with its language data missing FAILS AT ONCE, and says why.
//
// It used to hang: tesseract.js leaves its startup promise unsettled when a
// traineddata file cannot be loaded, so a photo sat in "processing" for the
// whole TESSERACT_TIMEOUT_MS, three attempts over -- about six minutes -- for a
// file that was never going to appear. Now the missing file is checked before a
// worker is started, the failure is unrecoverable (the queue does not retry
// it), and the worker marks the receipt failed on that first attempt.
//
// tesseract.js itself is stubbed: these tests are about which workers get
// started, not about reading a photograph.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('tesseract-fast-fail-test');
installFakeRedis();

const started = [];
const tesseractPath = require.resolve('tesseract.js');
require.cache[tesseractPath] = {
  id: tesseractPath,
  filename: tesseractPath,
  loaded: true,
  exports: {
    createWorker: async (lang) => {
      started.push(lang);
      return {
        detect: async () => ({ data: { orientation_degrees: 0, orientation_confidence: 5 } }),
        recognize: async () => ({ data: { text: 'EGGS 4.99' } }),
        terminate: async () => {},
      };
    },
  },
};

const config = require('../src/config');
const store = require('../src/store');
const tesseract = require('../src/ocr/tesseract');
const { markFailedIfFinal } = require('../src/worker');

const dirs = [];
function tessdata(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessdata-'));
  dirs.push(dir);
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  tmp.cleanup();
});

const saved = { dir: config.tessdataDir, osd: config.tesseractOsd, timeout: config.tesseractTimeoutMs };
function restore() {
  config.tessdataDir = saved.dir;
  config.tesseractOsd = saved.osd;
  config.tesseractTimeoutMs = saved.timeout;
  started.length = 0;
}

async function photo() {
  return store.createReceipt({ buffer: Buffer.from('x'), mimeType: 'image/png', originalName: 'r.png', source: 'test' });
}

test('no eng.traineddata: an unrecoverable error at once, naming the file, and no worker started', async () => {
  config.tessdataDir = tessdata(['README.md', 'eng.traineddata.gz']);
  config.tesseractOsd = true;
  config.tesseractTimeoutMs = 60000;
  try {
    const t0 = Date.now();
    await assert.rejects(tesseract.extract(await photo()), (err) => {
      assert.equal(err.name, 'UnrecoverableError');
      assert.match(err.message, /eng\.traineddata is missing/);
      assert.match(err.message, /fetch-tessdata\.sh/);
      assert.match(err.message, /VISION_PROVIDER/);
      return true;
    });
    assert.ok(Date.now() - t0 < 1000, 'not a timeout');
    assert.deepEqual(started, []);
  } finally {
    restore();
  }
});

test('an empty eng.traineddata counts as missing', async () => {
  config.tessdataDir = tessdata([]);
  fs.writeFileSync(path.join(config.tessdataDir, 'eng.traineddata'), '');
  try {
    await assert.rejects(tesseract.extract(await photo()), { name: 'UnrecoverableError' });
  } finally {
    restore();
  }
});

test('eng present, osd missing: orientation is skipped rather than attempted, and the photo is read', async () => {
  config.tessdataDir = tessdata(['eng.traineddata']);
  config.tesseractOsd = true;
  try {
    const out = await tesseract.extract(await photo());
    assert.equal(out.rawText, 'EGGS 4.99');
    assert.deepEqual(started, ['eng']);
  } finally {
    restore();
  }
});

test('both present: orientation first, then recognition, as before', async () => {
  config.tessdataDir = tessdata(['eng.traineddata', 'osd.traineddata']);
  config.tesseractOsd = true;
  try {
    await tesseract.extract(await photo());
    assert.deepEqual(started, ['osd', 'eng']);
  } finally {
    restore();
  }
});

test('the worker marks a receipt failed on an unrecoverable first attempt, and waits out an ordinary one', async () => {
  const job = (id, attemptsMade) => ({ name: 'process-receipt', data: { receiptId: id }, attemptsMade, opts: { attempts: 3 } });
  const unrecoverable = Object.assign(new Error('tesseract OCR cannot run: eng.traineddata is missing'), { name: 'UnrecoverableError' });

  const a = await photo();
  assert.equal(await markFailedIfFinal(job(a.id, 1), unrecoverable), true);
  assert.deepEqual(
    (({ status, error }) => ({ status, error }))(await store.get(a.id)),
    { status: 'failed', error: unrecoverable.message }
  );

  const b = await photo();
  assert.equal(await markFailedIfFinal(job(b.id, 1), new Error('rate limited')), false);
  assert.notEqual((await store.get(b.id)).status, 'failed', 'an ordinary failure still gets its retries');
  assert.equal(await markFailedIfFinal(job(b.id, 3), new Error('rate limited')), true);
  assert.equal((await store.get(b.id)).status, 'failed');

  assert.equal(await markFailedIfFinal({ ...job(b.id, 1), name: 'applyProfile' }, unrecoverable), false);
});
