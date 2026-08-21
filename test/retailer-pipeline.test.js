'use strict';

// The JSON ingest path through the REAL pipeline: store a retailer payload,
// run processReceipt, and check that stage 1 normalized it with the retailer
// adapter instead of OCR while stages 2-4 behaved exactly as they do for a
// photographed receipt.
//
// Hermetic: temp DATA_DIR, in-memory fake Redis, and a `fetch` that THROWS on
// any call — which is itself the assertion that neither an OCR backend nor
// Tavily was reached.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useTempDataDir, installFakeRedis, stubFetch, jsonResponse } = require('./helpers/harness');

const tmp = useTempDataDir('retailer-pipeline-test');
installFakeRedis(); // enrich + ../redis
const config = require('../src/config');
const store = require('../src/store');
const { processReceipt } = require('../src/pipeline');

const FIXTURES = path.join(__dirname, 'fixtures', 'retailers', 'samsclub');
const payloadBytes = (name) => fs.readFileSync(path.join(FIXTURES, name));

// Configure the app as if a vision key were present, so that if the pipeline
// ever took the OCR branch for a JSON receipt it would try to call out — and
// the throwing fetch below would catch it.
before(() => {
  config.ocrProvider = 'vision';
  config.vision.provider = 'anthropic';
  config.vision.anthropic.apiKey = 'sk-ant-test';
  config.enrich.enabled = true;
  config.enrich.tavily.apiKey = 'tvly-test';
});

let restoreFetch;
afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
  config.retailers.storeRawPayload = true;
});
after(() => tmp.cleanup());

function noNetwork() {
  return stubFetch((url) => {
    throw new Error(`pipeline reached the network at ${url} — it should not have`);
  });
}

async function ingest(fixture, { enrich = false, source = 'sync' } = {}) {
  const payload = payloadBytes(fixture);
  return store.createRetailerReceipt({
    payload,
    retailer: 'samsclub.com',
    originalName: fixture,
    source,
    origin: { retailer: 'samsclub.com', orderId: JSON.parse(payload).summary.orderId },
    options: { enrich },
  });
}

test('a JSON receipt is normalized by its adapter, with no OCR and no enrichment', async () => {
  restoreFetch = noNetwork();
  const created = await ingest('scan-and-go.json');
  assert.equal(created.kind, 'json');
  assert.equal(created.status, 'queued');

  const result = await processReceipt(created.id);

  assert.equal(result.status, 'done');
  assert.equal(result.extraction.provider, 'retailer:samsclub.com', 'stage 1 was the adapter, not an OCR engine');
  assert.equal(result.extraction.rawText, null, 'there is no OCR text on this path');
  assert.equal(result.extraction.retailer, 'samsclub.com');
  assert.equal(result.store.name, "Sam's Club");
  assert.equal(result.store.date, '2025-10-05');
  assert.equal(result.items.length, 4);
  assert.equal(result.totals.total, 39.66);
  assert.equal(result.totals.subtotalMatch, true);
  assert.ok(result.items.every((i) => i.enrichment === null), 'enrichment is off by default for retailer receipts');
  assert.ok(result.summary.includes("Sam's Club"), 'summary still built from the canonical record');
  assert.ok(result.summary.includes('4 item(s)'));
  assert.ok(!/0 item\(s\) matched/.test(result.summary), 'no misleading "0 matched" note when enrichment never ran');
  assert.ok(result.timings.totalMs >= 0 && 'ocrMs' in result.timings);
});

test('adapter warnings ride along on the record', async () => {
  restoreFetch = noNetwork();
  const created = await ingest('total-check-fails.json');
  const result = await processReceipt(created.id);
  assert.equal(result.totals.totalMatch, false);
  assert.ok(
    result.extraction.warnings.some((w) => /unmodelled charge/.test(w)),
    'the receipt says what did not add up'
  );
  assert.equal(result.status, 'done', 'a money gap is a finding, not a failure');
});

test('retailer provenance is kept on the record', async () => {
  restoreFetch = noNetwork();
  const created = await ingest('fuel.json');
  const result = await processReceipt(created.id);
  const source = result.extraction.source;
  assert.equal(source.retailer, 'samsclub.com');
  assert.equal(source.orderId, '05320328058895178882');
  assert.equal(source.externalId, 'samsclub.com:05320328058895178882');
  assert.equal(source.isFuelPurchase, true);
  assert.equal(result.origin.orderId, '05320328058895178882', 'the upload-time peek matches the full normalize');
});

test('enrichment runs for a JSON receipt when the upload asks for it', async () => {
  restoreFetch = stubFetch((url, opts) => {
    if (/\/search$/.test(url)) {
      const q = JSON.parse(opts.body).query;
      return jsonResponse({
        images: [{ url: `https://img.example/${encodeURIComponent(q)}.jpg`, description: q }],
        results: [{ title: q, url: 'https://shop.example/x', content: 'about ' + q }],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const created = await ingest('scan-and-go.json', { enrich: true });
  const result = await processReceipt(created.id);

  assert.equal(result.status, 'done');
  assert.ok(result.items.every((i) => i.enrichment && i.enrichment.imageUrl), 'every item enriched');
  assert.ok(result.summary.includes('4 item(s) matched'), 'and the summary says so');
});

test('the stored payload is readable back, and re-normalizing is idempotent', async () => {
  restoreFetch = noNetwork();
  const created = await ingest('savings.json');
  const first = await processReceipt(created.id);

  const payload = await store.readDocument(await store.get(created.id));
  assert.equal(payload.summary.orderId, '008220651018835151852', 'the original bytes round-trip');

  const second = await processReceipt(created.id);
  assert.deepEqual(second.items, first.items, 'the same payload normalizes the same way');
  assert.deepEqual(second.totals, first.totals);
});

test('RETAILER_STORE_RAW_PAYLOAD=0 discards the payload once the receipt is done', async () => {
  restoreFetch = noNetwork();
  config.retailers.storeRawPayload = false;
  const created = await ingest('scan-and-go.json');
  const filePath = store.documentPathFor(created);
  assert.ok(fs.existsSync(filePath), 'written at upload — the worker needs it');

  const result = await processReceipt(created.id);

  assert.equal(result.status, 'done');
  assert.equal(result.items.length, 4, 'the normalized receipt survives');
  assert.equal(fs.existsSync(filePath), false, 'the payload does not');
  assert.equal(result.document.discarded, true, 'and the record says where it came from anyway');
  await assert.rejects(() => store.readDocument(result), /discarded/);
});

test('a record with no enrich option still enriches — receipts written before this existed', async () => {
  restoreFetch = stubFetch((url, opts) => {
    if (/\/search$/.test(url)) {
      const q = JSON.parse(opts.body).query;
      return jsonResponse({ images: [{ url: 'https://img.example/x.jpg', description: q }], results: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const created = await store.createRetailerReceipt({
    payload: payloadBytes('fuel.json'),
    retailer: 'samsclub.com',
    source: 'sync',
  });
  assert.equal(created.options, undefined, 'no options block at all');
  const result = await processReceipt(created.id);
  assert.ok(result.items[0].enrichment, 'defaults to enriching, as the pipeline always did');
});

test('an unknown retailer on the record fails the job with a clear reason', async () => {
  restoreFetch = noNetwork();
  const created = await ingest('scan-and-go.json');
  await store.update(created.id, { retailer: 'costco.com' });
  await assert.rejects(() => processReceipt(created.id), /adapter "costco.com" is not available/);
});
