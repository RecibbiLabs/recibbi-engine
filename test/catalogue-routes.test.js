'use strict';

// GET/PATCH /api/catalogue over real HTTP: the envelope, the filters and the
// order reaching the query, naming, and the scope coming from the identity
// headers and nowhere else.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('catalogue-routes-test');
installFakeRedis();

const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async (id) => ({ id: `receipt-${id}` }),
    enqueueProcessAndApply: async () => ({}),
    enqueueProcessApplyAndResolve: async () => ({}),
    enqueueApplyProfile: async () => ({}),
    enqueueResolveProducts: async () => ({}),
    connection: {},
  },
};

const store = require('../src/store');
const catalogue = require('../src/catalogue');
const { createApp } = require('../src/app');

const ME = { 'X-Tenant-Id': 'tA', 'X-User-Id': 'uA' };
const STRANGER = { 'X-Tenant-Id': 'tB', 'X-User-Id': 'uB' };

let server;
let base;

function line(description, sku, price, enrichment = null) {
  return { description, sku, qty: 1, unitPrice: price, price, enrichment };
}

async function seed(date, items, name = 'Costco') {
  const rec = await store.createReceipt({
    buffer: Buffer.from('x'),
    mimeType: 'image/png',
    originalName: 'r.png',
    source: 'test',
    tenantId: 'tA',
    userId: 'uA',
  });
  const done = await store.update(rec.id, { status: 'done', store: { name, date }, items, totals: {} });
  await catalogue.indexReceipt(done);
  return done;
}

async function get(pathname, headers = ME) {
  const res = await fetch(base + pathname, { headers });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  await seed('2026-01-01', [line('EGGS', '1', 5, { title: 'Eggs', category: 'Dairy' }), line('BREAD', '2', 3)]);
  await seed('2026-02-01', [line('EGGS', '1', 5, { title: 'Eggs', category: 'Dairy' }), line('APPLES', '3', 4, { title: 'Apples', category: 'Produce' })]);
  await seed('2026-03-01', [line('TV', '9', 300)], 'Walmart Supercenter');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

test('GET /api/catalogue answers the envelope over the books', async () => {
  const { status, body } = await get('/api/catalogue');
  assert.equal(status, 200);
  assert.equal(body.total, 4);
  assert.equal(body.matched, 4);
  assert.equal(body.receipts, 3);
  assert.equal(body.categories, 2, 'the categories behind what matched');
  assert.equal(body.spent, 317, 'what matched came to');
  assert.equal(body.more, false);
  assert.equal(body.records[0].line, 'sku:9', 'newest purchase first by default');
  assert.deepEqual(body.facets.options.store, ['Costco', 'Walmart Supercenter']);
  assert.deepEqual(body.facets.options.category, ['Dairy', 'Produce']);
  assert.equal(body.unpictured, 4);
});

test('filters, the times range, the order and the slice all reach the query', async () => {
  let r = await get('/api/catalogue?category=Dairy&category=Produce&sort=name_az');
  assert.deepEqual(r.body.records.map((p) => p.line), ['sku:3', 'sku:1']);
  assert.equal(r.body.facets.counts.store.Costco, 2);

  r = await get('/api/catalogue?times_min=2');
  assert.deepEqual(r.body.records.map((p) => p.line), ['sku:1']);

  r = await get('/api/catalogue?store=Walmart%20Supercenter');
  assert.equal(r.body.matched, 1);
  assert.equal(r.body.categories, 0, 'the meta row moves with the filter');
  assert.equal(r.body.spent, 300);

  r = await get('/api/catalogue?named=nobody&sort=most_spent');
  assert.deepEqual(r.body.records.map((p) => p.line), ['sku:9', 'sku:2']);

  r = await get('/api/catalogue?sort=most_spent&limit=2&offset=1');
  assert.deepEqual(r.body.records.map((p) => p.line), ['sku:1', 'sku:3']);
  assert.equal(r.body.more, true);
  assert.equal(r.body.offset, 1);
});

test('the scope is the identity headers’: a stranger sees empty books and 404s', async () => {
  const mine = (await get('/api/catalogue')).body.records[0];
  const theirs = await get('/api/catalogue', STRANGER);
  assert.equal(theirs.body.total, 0);
  assert.equal((await get(`/api/catalogue/${mine.id}`, STRANGER)).status, 404);
  assert.equal((await get(`/api/catalogue/${mine.id}`)).status, 200);

  const res = await fetch(`${base}/api/catalogue/${mine.id}`, {
    method: 'PATCH',
    headers: { ...STRANGER, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'hijacked' }),
  });
  assert.equal(res.status, 404);
});

test('PATCH /api/catalogue/:id names the product on every receipt it was on', async () => {
  const eggs = (await get('/api/catalogue?times_min=2')).body.records[0];
  const res = await fetch(`${base}/api/catalogue/${eggs.id}`, {
    method: 'PATCH',
    headers: { ...ME, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Free-range eggs', brand: 'Farm', category: 'Dairy' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.item.enrichment.title, 'Free-range eggs');
  assert.equal(body.item.enrichment.named, 'member');
  for (const b of body.buys) assert.equal(b.item.enrichment.title, 'Free-range eggs');

  const bad = await fetch(`${base}/api/catalogue/${eggs.id}`, {
    method: 'PATCH',
    headers: { ...ME, 'content-type': 'application/json' },
    body: JSON.stringify({ title: { nested: true } }),
  });
  assert.equal(bad.status, 400);

  const r = await get('/api/catalogue?named=member');
  assert.equal(r.body.matched, 1);
});

test('verify and rebuild are scoped and answer reports', async () => {
  let r = await get('/api/catalogue/verify');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.receipts, 3);
  const res = await fetch(`${base}/api/catalogue/rebuild`, { method: 'POST', headers: ME });
  const built = await res.json();
  assert.equal(built.receipts, 3);
  assert.equal(built.removed, 0);
  r = await get('/api/catalogue/verify', STRANGER);
  assert.equal(r.body.receipts, 0);
  assert.equal(r.body.ok, true);
});

test('a product id that is not one is a 404, not a lookup', async () => {
  assert.equal((await get('/api/catalogue/not-an-id')).status, 404);
});
