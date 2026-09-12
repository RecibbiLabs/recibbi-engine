'use strict';

// HTTP-surface tests for the REST API + web views. These drive the *real*
// Express app (built via createApp) over a loopback socket with the real global
// fetch — no external network. They stay hermetic the same way the rest of the
// suite does: a temp DATA_DIR, an in-memory fake Redis, and a stubbed queue so
// no BullMQ/Redis connection is ever opened.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('routes-test');
installFakeRedis(); // app /health -> ../redis cache().ping()

// Replace src/queue so requiring the routes never instantiates a BullMQ Queue
// (which would try to open a real Redis connection at module load).
const enqueued = [];
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async (id) => {
      enqueued.push(id);
      return { id: `receipt-${id}` };
    },
    receiptsQueue: {},
    connection: {},
  },
};

const config = require('../src/config');
// Small upload cap so we can exercise the 413 path with a tiny buffer. Must be
// set before requiring the app, since multer captures it at route-load time.
config.maxUploadBytes = 4096;
config.publicBaseUrl = 'http://localhost:8080';

const store = require('../src/store');
const { createApp } = require('../src/app');

let server;
let base;

// A few hundred bytes of "image" — store.createReceipt just persists the bytes,
// it doesn't decode them, so any buffer with an image/* mimetype is fine.
const smallImage = Buffer.alloc(256, 7);

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

function uploadForm(buffer, { field = 'receipt', type = 'image/png', name = 'r.png' } = {}) {
  const fd = new FormData();
  fd.append(field, new Blob([buffer], { type }), name);
  return fd;
}

test('POST /api/receipts with no file -> 400', async () => {
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: new FormData() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /receipt/i);
  assert.equal(enqueued.length, 0, 'nothing queued on a rejected upload');
});

test('POST /api/receipts rejects a non-image upload -> 400', async () => {
  const fd = new FormData();
  fd.append('receipt', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt');
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: fd });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /image/i);
});

test('POST /api/receipts over the size limit -> 413', async () => {
  const tooBig = Buffer.alloc(config.maxUploadBytes + 1, 9);
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: uploadForm(tooBig) });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.match(body.error, /too large|file size/i);
});

test('POST /api/receipts (field "receipt") -> 202, queues, persists', async () => {
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: uploadForm(smallImage) });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'queued');
  assert.ok(body.id, 'returns an id');
  assert.equal(body.statusUrl, `http://localhost:8080/api/receipts/${body.id}`);
  assert.equal(body.viewUrl, `http://localhost:8080/receipts/${body.id}/view`);

  // The job was enqueued with the new id, and the record is on disk.
  assert.ok(enqueued.includes(body.id), 'receipt id was enqueued');
  const persisted = await store.get(body.id);
  assert.equal(persisted.status, 'queued');
  assert.equal(persisted.source, 'api');
  assert.equal(persisted.image.size, smallImage.length);
});

test('POST /api/receipts accepts the alternate field name "image"', async () => {
  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    body: uploadForm(smallImage, { field: 'image' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.ok(body.id);
});

test('GET /api/receipts lists records with the summary shape', async () => {
  const res = await fetch(`${base}/api/receipts`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 2, 'earlier uploads show up');
  const row = list[0];
  for (const key of ['id', 'status', 'itemCount', 'createdAt', 'statusUrl', 'viewUrl']) {
    assert.ok(key in row, `row has ${key}`);
  }
  // Full per-record fields (e.g. image/items) are not leaked into the list.
  assert.ok(!('image' in row), 'list rows are summaries, not full records');
});

test('GET /api/receipts?limit clamps the page size', async () => {
  const res = await fetch(`${base}/api/receipts?limit=1`);
  const list = await res.json();
  assert.equal(list.length, 1, 'limit=1 returns a single row');

  // A bogus limit falls back to the default rather than erroring.
  const res2 = await fetch(`${base}/api/receipts?limit=not-a-number`);
  assert.equal(res2.status, 200);
});

test('GET /api/receipts/:id -> 404 for unknown, record + links when found', async () => {
  const missing = await fetch(`${base}/api/receipts/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not found' });

  const created = await store.createReceipt({
    buffer: smallImage,
    mimeType: 'image/png',
    originalName: 'x.png',
    source: 'cli',
  });
  const res = await fetch(`${base}/api/receipts/${created.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, created.id);
  assert.equal(body.source, 'cli');
  assert.equal(body.statusUrl, `http://localhost:8080/api/receipts/${created.id}`);
});

test('GET /receipts/:id/view -> 404 then HTML', async () => {
  const missing = await fetch(`${base}/receipts/nope/view`);
  assert.equal(missing.status, 404);

  const created = await store.createReceipt({
    buffer: smallImage,
    mimeType: 'image/png',
    originalName: 'x.png',
    source: 'api',
  });
  const res = await fetch(`${base}/receipts/${created.id}/view`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /<html|<!DOCTYPE/i);
});

test('GET /receipts/:id/image -> 404 then the original bytes', async () => {
  const missing = await fetch(`${base}/receipts/nope/image`);
  assert.equal(missing.status, 404);

  const created = await store.createReceipt({
    buffer: smallImage,
    mimeType: 'image/png',
    originalName: 'x.png',
    source: 'api',
  });
  const res = await fetch(`${base}/receipts/${created.id}/image`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/png/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.length, smallImage.length, 'serves the stored image byte-for-byte');
});

test('GET / renders the receipts list page', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.match(await res.text(), /<html|<!DOCTYPE/i);
});

test('GET /health reports ok with Redis up', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.redis, 'up');
  assert.ok('ocrProvider' in body);
  assert.ok('enrichment' in body);
});

// --- A page of the books, and the counts that say what it is a page of ------

// Four receipts with real shape on them, so the filters and the facets have
// something to be right about. Created last so nothing above sees them.
async function seedBooks() {
  const made = [];
  for (const patch of [
    {
      status: 'done',
      source: 'sync',
      store: { name: "Sam's Club", date: '2026-08-16' },
      items: [{ description: 'a' }, { description: 'b' }],
      totals: { subtotal: 90.4, tax: 5.42, total: 91.82, itemCount: 2, sumOfItems: 90.4 },
      reconciled: true,
      extraction: { provider: 'retailer', rawText: 'X'.repeat(5000) },
    },
    {
      status: 'done',
      source: 'telegram',
      store: { name: 'Aldi', date: '2026-08-24' },
      items: [{ description: 'c' }],
      totals: { subtotal: 13.47, tax: null, total: null, itemCount: 1, sumOfItems: 13.47 },
      extraction: { provider: 'vision', rawText: 'Y'.repeat(5000) },
    },
    {
      status: 'done',
      source: 'telegram',
      store: { name: 'Aldi', date: '2026-07-02' },
      items: [{ description: 'd' }, { description: 'e' }, { description: 'f' }],
      totals: { total: 240.5, itemCount: 3, sumOfItems: 240.5 },
    },
    // Still in the pipeline: no store date, no totals, no items.
    { status: 'processing', source: 'telegram' },
  ]) {
    const rec = await store.createReceipt({
      buffer: smallImage,
      mimeType: 'image/png',
      originalName: 'x.png',
      source: patch.source,
    });
    made.push(await store.update(rec.id, patch));
  }
  return made;
}

test('GET /api/receipts still answers with a bare array by default', async () => {
  // The shape three callers are pointed at -- the CLI, ux-main, and a test in
  // this suite. The envelope is opt-in precisely so none of them break.
  await seedBooks();
  const res = await fetch(`${base}/api/receipts?limit=500`);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.ok(!('records' in body));
});

test('a receipt nobody has read yet reports no item count, not zero', async () => {
  const res = await fetch(`${base}/api/receipts?limit=500&status=processing`);
  const rows = await res.json();
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.itemCount, null, 'an unread basket is unknown, not empty');
  }
});

test('envelope=1 answers with the page AND what it is a page of', async () => {
  const res = await fetch(`${base}/api/receipts?envelope=1&limit=2`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(Array.isArray(body.records));
  assert.equal(body.records.length, 2);
  assert.equal(body.limit, 2);
  assert.equal(body.offset, 0);
  // total is the books. It is NOT records.length, and that is the whole point:
  // a caller handed only rows says "2 receipts" to somebody who owns dozens.
  assert.ok(body.total > 2);
  assert.equal(body.matched, body.total, 'nothing is filtered');
  assert.equal(body.more, true);
});

test('offset pages through the list without re-ordering it', async () => {
  const all = await (await fetch(`${base}/api/receipts?envelope=1&limit=500`)).json();
  const first = await (await fetch(`${base}/api/receipts?envelope=1&limit=2&offset=0`)).json();
  const second = await (await fetch(`${base}/api/receipts?envelope=1&limit=2&offset=2`)).json();

  assert.deepEqual(
    [...first.records, ...second.records].map((r) => r.id),
    all.records.slice(0, 4).map((r) => r.id),
    'two pages are the first four of one list, in order'
  );
  // The last page says so rather than leaving the caller to infer it.
  const last = await (
    await fetch(`${base}/api/receipts?envelope=1&limit=500&offset=${all.total - 1}`)
  ).json();
  assert.equal(last.more, false);
});

test('a filter narrows `matched` and leaves `total` alone', async () => {
  const body = await (await fetch(`${base}/api/receipts?envelope=1&store=Aldi&limit=500`)).json();
  assert.equal(body.matched, 2, 'two Aldi receipts');
  assert.ok(body.total > body.matched, 'the books are bigger than the filter');
  for (const row of body.records) assert.equal(row.store.name, 'Aldi');
});

test('an amount range leaves out the receipts that have no amount yet', async () => {
  // "$0 and up" is not "everything": a receipt still being read has no total,
  // so no range can match it. Losing it quietly is the bug this guards.
  const body = await (
    await fetch(`${base}/api/receipts?envelope=1&amt_min=0&limit=500`)
  ).json();
  for (const row of body.records) {
    assert.notEqual(row.status, 'processing', 'an unread receipt has no number to test');
  }
  assert.ok(body.matched < body.total);
});

test('an unreadable date bound does not empty the books', async () => {
  // `amt_min=banana` was already dropped; `from=banana` was not, and it hid
  // every receipt the member owns behind a lexical compare. Both are no filter.
  const junk = await (await fetch(`${base}/api/receipts?envelope=1&from=banana&limit=500`)).json();
  const none = await (await fetch(`${base}/api/receipts?envelope=1&limit=500`)).json();
  assert.equal(junk.matched, none.total, 'an unreadable bound narrows nothing');
  assert.ok(junk.matched > 0, 'and the list is not silently empty');

  // A bound that IS a day still narrows, so this is not just a disabled filter.
  const real = await (await fetch(`${base}/api/receipts?envelope=1&from=2026-08-20&limit=500`)).json();
  assert.ok(real.matched < real.total, 'a real bound still does its job');
});

test('the facets describe the books, not the page that came back', async () => {
  const body = await (await fetch(`${base}/api/receipts?envelope=1&limit=1&store=Aldi`)).json();
  assert.equal(body.records.length, 1, 'one row came back');

  const fx = body.facets;
  // ...and the panel still knows about every store in the books.
  assert.ok(fx.options.store.includes("Sam's Club"));
  assert.ok(fx.options.store.includes('Aldi'));
  // Counted with the OTHER groups applied and this one ignored.
  assert.equal(fx.counts.store.Aldi, 2);
  assert.equal(fx.counts.store["Sam's Club"], 1, 'an unticked box must not read 0');
  assert.ok(fx.bounds.amount.hi >= 240, 'the slider ends where the books do');
  assert.ok(fx.pending >= 1, 'the receipts with no numbers yet are counted');
  assert.ok(fx.days.from && fx.days.to);
});

test('a card row carries what a list draws, and not the OCR dump', async () => {
  const body = await (
    await fetch(`${base}/api/receipts?envelope=1&limit=500&store=Sam%27s%20Club`)
  ).json();
  const row = body.records[0];

  // The four things a list card needs and the summary shape could not give it,
  // which is why ux-main was fetching every row's full record one at a time.
  assert.equal(row.source, 'sync');
  assert.equal(row.totals.total, 91.82);
  assert.equal(row.items.length, 2);
  assert.equal(row.reconciled, true);
  assert.equal(row.extraction.provider, 'retailer');

  // And not the parts a list has no use for. rawText alone can be larger than
  // everything else on the row combined.
  assert.ok(!('rawText' in row.extraction), 'the OCR dump does not ride along');
  assert.equal(row.image, true, 'whether there IS a photo, not where it is kept');
  assert.ok(!('timings' in row));
});
