'use strict';

// RECEIPTS IN THROUGH THE REAL PIPELINE, PRODUCTS OUT -- and the verifier as the
// oracle.
//
// This is the test the one-off backfill is the foundation for. The backfill
// fills the catalogue from receipts that arrived before it existed; every
// receipt after it is filed by the pipeline as it finishes. The claim worth
// testing is that the two agree: ingest any number of receipts with NO backfill
// in between, and `verify` -- which recomputes the catalogue from scratch and
// compares -- must find nothing. The same check runs against a live deployment
// as `node src/catalogue/cli.js verify`.
//
// Hermetic: temp DATA_DIR, fake Redis, and a fetch that throws, so the Sam's
// Club payloads go through their adapter with enrichment off and nothing leaves
// the process.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useTempDataDir, installFakeRedis, stubFetch } = require('./helpers/harness');

const tmp = useTempDataDir('catalogue-ingest-test');
installFakeRedis();
process.env.ENRICH_PROVIDER = 'tavily';
const config = require('../src/config');
const store = require('../src/store');
const identity = require('../src/identity');
const catalogue = require('../src/catalogue');
const { processReceipt } = require('../src/pipeline');

const FIXTURES = path.join(__dirname, 'fixtures', 'retailers', 'samsclub');
const PAYLOADS = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort();

let restoreFetch;
before(() => {
  config.enrich.enabled = false;
  restoreFetch = stubFetch((url) => {
    throw new Error(`the pipeline reached the network at ${url}`);
  });
});
after(() => {
  if (restoreFetch) restoreFetch();
  tmp.cleanup();
});

async function ingest(fixture) {
  const payload = fs.readFileSync(path.join(FIXTURES, fixture));
  const rec = await store.createRetailerReceipt({
    payload,
    retailer: 'samsclub.com',
    originalName: fixture,
    source: 'sync',
    origin: { retailer: 'samsclub.com', orderId: JSON.parse(payload).summary.orderId },
    options: { enrich: false },
  });
  return processReceipt(rec.id);
}

let scope;

test('every Sam’s Club fixture, ingested one by one, leaves a catalogue the verifier agrees with', async () => {
  let lines = 0;
  for (const f of PAYLOADS) {
    const done = await ingest(f);
    assert.equal(done.status, 'done', f);
    lines += done.items.length;
    scope = identity.scopeOf(done.id);
    // After EVERY receipt, not only at the end: a drift that one later receipt
    // happened to repair would pass an end-only check.
    const v = await catalogue.verify(scope);
    assert.equal(v.ok, true, `${f}: ${JSON.stringify(v)}`);
  }
  const products = await catalogue.products(scope);
  assert.ok(products.length > 0);
  assert.ok(products.length <= lines, 'never more products than lines');
  const receiptsWithLines = (await store.list({ ...scope, limit: 1000 })).filter((r) => r.items.length).length;
  const receiptsInCatalogue = new Set(products.flatMap((p) => p.buys.map((b) => b.record.id))).size;
  assert.equal(receiptsInCatalogue, receiptsWithLines, 'every receipt with lines is in the catalogue');
});

test('ingesting the same order again adds a purchase, not a product', async () => {
  const before = await catalogue.products(scope);
  await ingest(PAYLOADS[0]);
  const after = await catalogue.products(scope);
  assert.equal(after.length, before.length);
  assert.ok(after.some((p) => p.times >= 2));
  assert.equal((await catalogue.verify(scope)).ok, true);
});

test('a product the member named is named on the next receipt it arrives on', async () => {
  const [prod] = (await catalogue.products(scope)).filter((p) => p.times >= 2);
  await catalogue.nameProduct(scope, prod.id, { title: 'Named by me', brand: null, category: 'Test aisle' });

  const done = await ingest(PAYLOADS[0]);
  const named = done.items.filter((it) => it.enrichment && it.enrichment.named === 'member');
  assert.ok(named.length >= 1);
  assert.equal(named[0].enrichment.title, 'Named by me');

  const now = await catalogue.get(scope, prod.id);
  assert.equal(now.buys[0].record.id, done.id);
  assert.equal(now.item.enrichment.title, 'Named by me');
  assert.equal((await catalogue.verify(scope)).ok, true);
});

test('the rebuild of an already-correct catalogue changes nothing', async () => {
  const before = JSON.stringify(await catalogue.products(scope));
  const built = await catalogue.rebuild(scope);
  assert.equal(built.removed, 0);
  assert.equal(JSON.stringify(await catalogue.products(scope)), before);
});

test('the CLI verify exits 0 on a correct catalogue and 1 on drift', async () => {
  const cli = require('../src/catalogue/cli');
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await cli.main(['verify', '--tenant', scope.tenantId, '--user', scope.userId]), 0);
    const [row] = await require('../src/persistence').list({ kind: 'purchases', tenant: scope.tenantId, user: scope.userId });
    await require('../src/persistence').delete({
      kind: 'purchases',
      tenant: scope.tenantId,
      user: scope.userId,
      id: row.productId,
      sub: identity.resolveId(row.receiptId).cacheId,
    });
    assert.equal(await cli.main(['verify', '--tenant', scope.tenantId, '--user', scope.userId]), 1);
    assert.equal(await cli.main(['backfill']), 0, 'backfill repairs it and verifies its own work');
    assert.equal(await cli.main(['verify']), 0);
    assert.equal(await cli.main(['nonsense']), 2);
  } finally {
    console.log = log;
  }
});
