'use strict';

// The trash: a deleted receipt is out of the books and still on disk until its
// retention is up, and then the sweep purges it.
//
// What this file has to be able to fail on:
//   - a trashed receipt still counted anywhere in the books -- the page, the
//     `total`, the facets, the catalogue -- or still resolving by share link;
//   - a purge reachable in one step from the books;
//   - the sweep purging a receipt BEFORE its time, or one put back;
//   - a TRASH_RETENTION / TRASH_EMPTY_CRON typo silently meaning thirty days.
//
// Hermetic like the rest of the suite: temp DATA_DIR, fake Redis, stubbed
// queue, the real Express app over a loopback socket. The sweep is run by
// calling it -- scheduling it is BullMQ's, and src/trash/sweeper.js is thin.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('trash-test');
installFakeRedis();

const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: { enqueueReceipt: async () => ({ id: 'job' }), receiptsQueue: {}, connection: {} },
};

const config = require('../src/config');
config.publicBaseUrl = 'http://localhost:8080';

const store = require('../src/store');
const shares = require('../src/shares');
const catalogue = require('../src/catalogue');
const trash = require('../src/trash');
const schedule = require('../src/trash/schedule');
const { createApp } = require('../src/app');

const SCOPE = { tenantId: 'tr', userId: 'amy' };
const HEADERS = { 'x-tenant-id': SCOPE.tenantId, 'x-user-id': SCOPE.userId };

let server;
let base;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

async function receipt(name, { status = 'done', total = 4.59 } = {}) {
  const record = await store.createReceipt({
    buffer: Buffer.alloc(64, 5),
    mimeType: 'image/png',
    originalName: 'r.png',
    source: 'api',
    ...SCOPE,
  });
  const done = await store.update(record.id, {
    status,
    store: { name, date: '2026-09-01' },
    items: status === 'done' ? [{ description: `${name} oat milk`, qty: 1, price: total }] : [],
    totals: status === 'done' ? { total, sumOfItems: total, itemCount: 1 } : null,
  });
  await catalogue.indexReceipt(done);
  return done;
}

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers: HEADERS });
  return { status: res.status, body: await res.json() };
}

const enc = encodeURIComponent;

/* ------------------------------------------------------------- settings */

test('TRASH_RETENTION: unset is thirty days, and every unit reads', () => {
  assert.equal(config.trash.retentionMs, 30 * schedule.DAY, 'the suite runs on the default');
  assert.equal(schedule.parseRetention(undefined), 30 * schedule.DAY);
  assert.equal(schedule.parseRetention(''), 30 * schedule.DAY);
  assert.equal(schedule.parseRetention('30d'), 30 * schedule.DAY);
  assert.equal(schedule.parseRetention('30'), 30 * schedule.DAY, 'a bare number is days');
  assert.equal(schedule.parseRetention('5s'), 5000);
  assert.equal(schedule.parseRetention('5 seconds'), 5000);
  assert.equal(schedule.parseRetention('1 sec'), 1000);
  assert.equal(schedule.parseRetention('12h'), 12 * schedule.HOUR);
  assert.equal(schedule.parseRetention('2 weeks'), 14 * schedule.DAY);
  assert.equal(schedule.parseRetention('1.5d'), 36 * schedule.HOUR);
});

test('TRASH_RETENTION: a value that does not read is refused, not thirty days', () => {
  for (const bad of ['5 secnds', 'soon', '-3d', '0', '0s', '1 fortnight']) {
    assert.throws(() => schedule.parseRetention(bad), schedule.TrashSettingError, bad);
  }
});

test('a retention is described in the largest unit it divides into', () => {
  assert.equal(schedule.describe(30 * schedule.DAY), '30 days');
  assert.equal(schedule.describe(14 * schedule.DAY), '14 days');
  assert.equal(schedule.describe(schedule.DAY), '1 day');
  assert.equal(schedule.describe(36 * schedule.HOUR), '36 hours');
  assert.equal(schedule.describe(5000), '5 seconds');
  assert.equal(schedule.describe(1000), '1 second');
});

test('TRASH_EMPTY_CRON: nightly by default, five or six fields, `off`, and nothing else', () => {
  assert.equal(config.trash.cron, '0 3 * * *');
  assert.equal(schedule.parseCron(''), '0 3 * * *');
  assert.equal(schedule.parseCron('*/15 * * * *'), '*/15 * * * *');
  assert.equal(schedule.parseCron('* * * * * *'), '* * * * * *', 'six fields: every second');
  assert.equal(schedule.parseCron('off'), null);
  for (const bad of ['* * * *', 'every night', '61 * * * *', '* * * * * * *']) {
    assert.throws(() => schedule.parseCron(bad), schedule.TrashSettingError, bad);
  }
});

test('the next sweep is computed from the pattern', () => {
  const from = new Date('2026-09-29T10:00:00.400Z');
  assert.equal(schedule.nextRun('* * * * * *', from).toISOString(), '2026-09-29T10:00:01.000Z');
  assert.equal(schedule.nextRun(null, from), null);
});

/* ---------------------------------------------------- trash and restore */

test('a trashed receipt leaves the books, the totals, the facets and the catalogue', async () => {
  const keep = await receipt('Aldi', { total: 10 });
  const gone = await receipt('Costco', { total: 99 });

  const moved = await post(`/api/receipts/${enc(gone.id)}/trash`);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.deletedBy, 'member');
  assert.ok(moved.body.deletedAt);
  assert.ok(Date.parse(moved.body.purgeAt) - Date.parse(moved.body.deletedAt) === 30 * schedule.DAY);

  const books = await get('/api/receipts?envelope=1');
  assert.deepEqual(books.body.records.map((r) => r.id), [keep.id]);
  assert.equal(books.body.total, 1);
  assert.equal(books.body.spent, 10);
  assert.ok(!JSON.stringify(books.body.facets.options.store).includes('Costco'), 'Costco is not a store in the books any more');
  assert.ok(JSON.stringify(books.body.facets.options.store).includes('Aldi'));

  const bare = await get('/api/receipts');
  assert.deepEqual(bare.body.map((r) => r.id), [keep.id]);

  const products = await catalogue.products(SCOPE);
  assert.ok(!JSON.stringify(products).includes('Costco oat milk'), 'its products left the catalogue');
  assert.equal((await catalogue.verify(SCOPE)).ok, true, 'and verify agrees with that');

  // Still answered by id, carrying the trash fields.
  const one = await get(`/api/receipts/${enc(gone.id)}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.deletedBy, 'member');
  assert.ok(one.body.purgeAt);

  const list = await get('/api/trash');
  assert.deepEqual(list.body.records.map((r) => r.id), [gone.id]);
  assert.equal(list.body.records[0].store, 'Costco');
  assert.equal(list.body.records[0].total, 99);
  assert.equal(list.body.records[0].items, 1);
  assert.equal(list.body.retention.label, '30 days');
  assert.equal(list.body.retention.days, 30);
  assert.equal(list.body.sweep.cron, '0 3 * * *');

  // Put it back: into the books, the catalogue, and out of the trash.
  const back = await post(`/api/receipts/${enc(gone.id)}/restore`);
  assert.equal(back.status, 200);
  assert.equal((await get('/api/receipts?envelope=1')).body.total, 2);
  assert.equal((await get('/api/trash')).body.records.length, 0);
  const again = await get(`/api/receipts/${enc(gone.id)}`);
  assert.equal(again.body.deletedAt, undefined);
  assert.equal(again.body.purgeAt, undefined);
  assert.ok(JSON.stringify(await catalogue.products(SCOPE)).includes('Costco oat milk'));
  assert.equal((await catalogue.verify(SCOPE)).ok, true);
});

test('trashing twice does not buy a receipt more time', async () => {
  const r = await receipt('Twice');
  const first = await post(`/api/receipts/${enc(r.id)}/trash`);
  await new Promise((done) => setTimeout(done, 5));
  const second = await post(`/api/receipts/${enc(r.id)}/trash`);
  assert.equal(second.body.deletedAt, first.body.deletedAt);
  await post(`/api/receipts/${enc(r.id)}/restore`);
});

test('`recibbi` may put a receipt in the trash, and nobody else', async () => {
  const r = await receipt('Dupe');
  const bad = await post(`/api/receipts/${enc(r.id)}/trash`, { by: 'mallory' });
  assert.equal(bad.status, 400);
  const ok = await post(`/api/receipts/${enc(r.id)}/trash`, { by: 'recibbi' });
  assert.equal(ok.body.deletedBy, 'recibbi');
  await post(`/api/receipts/${enc(r.id)}/restore`);
});

test('a receipt still being read cannot go in the trash', async () => {
  const r = await receipt('Pending', { status: 'processing' });
  const res = await post(`/api/receipts/${enc(r.id)}/trash`);
  assert.equal(res.status, 409);
  assert.equal((await store.get(r.id)).deletedAt, undefined);
});

test('an unknown receipt is a 404 on every route', async () => {
  const id = `${SCOPE.tenantId}:${SCOPE.userId}:nope`;
  for (const act of ['trash', 'restore', 'purge']) {
    assert.equal((await post(`/api/receipts/${enc(id)}/${act}`)).status, 404, act);
  }
});

/* -------------------------------------------------------------- sharing */

test('a trashed receipt\'s link shuts, cannot be minted, and comes back with it', async () => {
  const r = await receipt('Shared');
  const minted = await post(`/api/receipts/${enc(r.id)}/share`);
  assert.equal(minted.status, 201);
  const token = minted.body.token;
  assert.equal((await fetch(`${base}/api/shares/${token}`)).status, 200);

  await post(`/api/receipts/${enc(r.id)}/trash`);
  assert.equal((await fetch(`${base}/api/shares/${token}`)).status, 404, 'the reader gets the shut door');
  assert.equal((await fetch(`${base}/r/${token}`)).status, 404);
  assert.equal((await post(`/api/receipts/${enc(r.id)}/share`)).status, 409, 'no new link from the trash');

  await post(`/api/receipts/${enc(r.id)}/restore`);
  assert.equal((await fetch(`${base}/api/shares/${token}`)).status, 200, 'the same link works again');
});

/* ---------------------------------------------------------------- purge */

test('purge is refused from the books: the only way to it is through the trash', async () => {
  const r = await receipt('Safe');
  const res = await post(`/api/receipts/${enc(r.id)}/purge`);
  assert.equal(res.status, 409);
  assert.ok(await store.get(r.id), 'still there');
});

test('purge removes the record, the photograph, the link and everything filed beside it', async () => {
  const r = await receipt('Doomed');
  const blob = store.blobPathFor(r);
  assert.ok(fs.existsSync(blob));
  const { token } = (await post(`/api/receipts/${enc(r.id)}/share`)).body;
  await post(`/api/receipts/${enc(r.id)}/trash`);

  const res = await post(`/api/receipts/${enc(r.id)}/purge`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: r.id, purged: true });

  assert.equal(await store.get(r.id), null);
  assert.equal(fs.existsSync(blob), false, 'the photograph is gone');
  assert.equal(await shares.resolve(token), null, 'the share row is gone, not just shut');
  assert.equal((await get(`/api/receipts/${enc(r.id)}`)).status, 404);
  assert.ok(!(await get('/api/trash')).body.records.some((x) => x.id === r.id));
  assert.equal((await catalogue.verify(SCOPE)).ok, true);
});

/* ---------------------------------------------------------------- sweep */

test('the sweep purges what is due and nothing else -- run at a one-second retention', async () => {
  const saved = config.trash.retentionMs;
  config.trash.retentionMs = schedule.parseRetention('1 sec');
  try {
    const due = await receipt('Due');
    const fresh = await receipt('Fresh');
    const books = await receipt('Books');
    const back = await receipt('PutBack');

    await post(`/api/receipts/${enc(due.id)}/trash`);
    await post(`/api/receipts/${enc(back.id)}/trash`);
    const t0 = Date.now();

    // Nothing is due yet.
    let res = await trash.sweep({ now: new Date(t0) });
    assert.equal(res.purged, 0, 'nothing goes before its second is up');
    assert.ok(await store.get(due.id));

    await post(`/api/receipts/${enc(back.id)}/restore`);
    await new Promise((done) => setTimeout(done, 1100));
    await post(`/api/receipts/${enc(fresh.id)}/trash`);

    res = await trash.sweep();
    assert.equal(res.purged, 1, JSON.stringify(res));
    assert.equal(res.failed, 0);
    assert.equal(await store.get(due.id), null, 'past its second: gone');
    assert.ok((await store.get(fresh.id)).deletedAt, 'trashed a moment ago: still waiting');
    assert.ok(await store.get(books.id), 'never trashed: untouched');
    assert.equal((await store.get(back.id)).deletedAt, undefined, 'put back: untouched');

    await new Promise((done) => setTimeout(done, 1100));
    res = await trash.sweep();
    assert.equal(res.purged, 1);
    assert.equal(await store.get(fresh.id), null);
    assert.equal((await catalogue.verify(SCOPE)).ok, true);
  } finally {
    config.trash.retentionMs = saved;
  }
});

test('the retention is read when asked: changing it moves what is already in the trash', async () => {
  const r = await receipt('Moves');
  await post(`/api/receipts/${enc(r.id)}/trash`);
  const long = (await get('/api/trash')).body.records.find((x) => x.id === r.id).purgeAt;
  const saved = config.trash.retentionMs;
  config.trash.retentionMs = 5000;
  try {
    const body = (await get('/api/trash')).body;
    const short = body.records.find((x) => x.id === r.id).purgeAt;
    assert.equal(Date.parse(long) - Date.parse(short), 30 * schedule.DAY - 5000);
    assert.equal(body.retention.label, '5 seconds');
  } finally {
    config.trash.retentionMs = saved;
    await post(`/api/receipts/${enc(r.id)}/restore`);
  }
});

test('GET /api/trash/settings answers the settings alone', async () => {
  const res = await get('/api/trash/settings');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['retention', 'sweep']);
  assert.equal(res.body.retention.label, '30 days');
});

test('/health says how long the trash keeps things and when it is emptied', async () => {
  const res = await fetch(`${base}/health`);
  const body = await res.json();
  assert.equal(body.trash.retention.label, '30 days');
  assert.equal(body.trash.sweep.cron, '0 3 * * *');
  assert.ok(body.trash.sweep.next);
});
