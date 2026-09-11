'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { useTempDataDir } = require('./helpers/harness');
const { SAMPLE_IMAGE_PATH } = require('./fixtures/costco-sample');

// Redirect DATA_DIR to a temp folder BEFORE config/store load.
const tmp = useTempDataDir('store-test');
const store = require('../src/store');

before(() => {
  assert.ok(fs.existsSync(SAMPLE_IMAGE_PATH), `sample image missing: ${SAMPLE_IMAGE_PATH}`);
});
after(() => tmp.cleanup());

function sampleBuffer() {
  return fs.readFileSync(SAMPLE_IMAGE_PATH);
}

test('createReceipt persists the real sample image and an initial record', async () => {
  const buffer = sampleBuffer();
  const record = await store.createReceipt({
    buffer,
    mimeType: 'image/jpeg',
    originalName: 'costco-boca-raton-2026-05-26-original.jpg',
    source: 'cli',
  });

  // The id is the COMPOSITE id <tenant>:<user>:<cacheId>. With no identity
  // passed, it falls back to the configured default (main:main).
  assert.match(record.id, /^main:main:[0-9a-f]{16}$/, 'id is a composite tenant:user:cacheId token');
  assert.equal(record.tenantId, 'main');
  assert.equal(record.userId, 'main');
  assert.equal(record.status, 'queued', 'new receipts start queued');
  assert.equal(record.source, 'cli');
  assert.equal(record.image.size, buffer.length, 'stored size matches the upload');
  assert.match(record.image.file, /\.jpg$/, 'jpeg maps to a .jpg extension');
  assert.deepEqual(record.items, []);
  assert.equal(record.totals, null);

  // The bytes actually hit disk and round-trip intact.
  const onDisk = fs.readFileSync(store.imagePathFor(record));
  assert.equal(onDisk.length, buffer.length);
  assert.ok(onDisk.equals(buffer), 'persisted image is byte-identical to the sample');
});

test('get returns null for an unknown id (not a throw)', async () => {
  assert.equal(await store.get('deadbeefdeadbeef'), null);
});

test('save/get round-trips the full record', async () => {
  const record = await store.createReceipt({
    buffer: sampleBuffer(),
    mimeType: 'image/jpeg',
    originalName: 'r.jpg',
  });
  const fetched = await store.get(record.id);
  assert.equal(fetched.id, record.id);
  assert.equal(fetched.image.file, record.image.file);
});

test('update merges a patch and bumps updatedAt', async () => {
  const record = await store.createReceipt({
    buffer: sampleBuffer(),
    mimeType: 'image/jpeg',
    originalName: 'r.jpg',
  });
  const before = record.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const updated = await store.update(record.id, {
    status: 'done',
    items: [{ description: 'KS WATER GAL', price: 4.99 }],
  });
  assert.equal(updated.status, 'done');
  assert.equal(updated.items.length, 1);
  assert.equal(updated.image.file, record.image.file, 'untouched fields are preserved');
  assert.notEqual(updated.updatedAt, before, 'updatedAt advances on write');
});

test('update throws for a missing receipt', async () => {
  await assert.rejects(() => store.update('0000000000000000', { status: 'done' }), /not found/);
});

test('list returns records newest-first and respects the limit', async () => {
  const a = await store.createReceipt({ buffer: sampleBuffer(), mimeType: 'image/jpeg' });
  await new Promise((r) => setTimeout(r, 5));
  const b = await store.createReceipt({ buffer: sampleBuffer(), mimeType: 'image/jpeg' });

  const all = await store.list({ limit: 50 });
  const ids = all.map((r) => r.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id));
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), 'newer receipt sorts first');

  const limited = await store.list({ limit: 1 });
  assert.equal(limited.length, 1);
});

test('list orders by the date ON the receipt, not the date it was read', async () => {
  // The shape a retailer backfill produces: it walks the order history
  // newest-first, so the NEWEST purchase is the one created first and carries
  // the EARLIEST createdAt. Ordering by createdAt led with the oldest.
  const newestPurchase = await store.createReceipt({ buffer: sampleBuffer(), mimeType: 'image/jpeg' });
  const oldestPurchase = await store.createReceipt({ buffer: sampleBuffer(), mimeType: 'image/jpeg' });
  await store.update(newestPurchase.id, { store: { name: "Sam's Club", date: '2026-08-30' } });
  await store.update(oldestPurchase.id, { store: { name: "Sam's Club", date: '2020-03-01' } });

  const ids = (await store.list({ limit: 250 })).map((r) => r.id);
  assert.ok(
    ids.indexOf(newestPurchase.id) < ids.indexOf(oldestPurchase.id),
    'the more recent purchase leads, even though it was read first'
  );
});

test('a receipt date that cannot be read falls back to when it was read', async () => {
  const older = await store.createReceipt({ buffer: sampleBuffer(), mimeType: 'image/jpeg' });
  await new Promise((r) => setTimeout(r, 5));
  const newer = await store.createReceipt({ buffer: sampleBuffer(), mimeType: 'image/jpeg' });
  await store.update(older.id, { store: { name: 'Corner shop', date: 'CHECK #4417' } });

  const ids = (await store.list({ limit: 250 })).map((r) => r.id);
  assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id), 'junk in store.date does not reorder the list');
});

test('receiptDay reads the shapes store.date actually takes', () => {
  const day = (date) => store.receiptDay({ createdAt: '2025-01-02T10:00:00.000Z', store: { date } });

  assert.equal(day('2026-09-11'), '2026-09-11', "a retailer adapter's ISO day");
  assert.equal(day('9/11/2026'), '2026-09-11', "detectDate's US M/D/Y");
  assert.equal(day('11-9-26'), '2026-11-09', '...with a two-digit year');
  assert.equal(day('2026/9/1'), '2026-09-01', '...and unpadded Y/M/D');

  // Untrustworthy dates defer to createdAt rather than sorting on nonsense.
  assert.equal(day('2/31/2026'), '2025-01-02', 'no such day');
  assert.equal(day('1/1/1985'), '2025-01-02', 'before the product existed');
  assert.equal(day('not a date'), '2025-01-02', 'not a date at all');
  assert.equal(store.receiptDay({ createdAt: '2025-01-02T10:00:00.000Z', store: null }), '2025-01-02');
});

test('image extension follows the declared mime type', async () => {
  const png = await store.createReceipt({ buffer: Buffer.from('x'), mimeType: 'image/png' });
  assert.match(png.image.file, /\.png$/);
  const webp = await store.createReceipt({ buffer: Buffer.from('x'), mimeType: 'image/webp' });
  assert.match(webp.image.file, /\.webp$/);
});
