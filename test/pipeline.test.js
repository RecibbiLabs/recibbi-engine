'use strict';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { useTempDataDir, installFakeRedis, stubFetch, jsonResponse } = require('./helpers/harness');

const tmp = useTempDataDir('pipeline-test');
installFakeRedis(); // enrich -> ../redis
// These tests are about Tavily's lookup. Set before config loads, so a checkout's
// .env choosing ENRICH_PROVIDER=deepseek cannot choose for them (dotenv never
// overrides a variable that is already set).
process.env.ENRICH_PROVIDER = 'tavily';
const config = require('../src/config');
const store = require('../src/store');
const { processReceipt } = require('../src/pipeline');
const { structured, SAMPLE_IMAGE_PATH } = require('./fixtures/costco-sample');

function newReceipt() {
  return store.createReceipt({
    buffer: fs.readFileSync(SAMPLE_IMAGE_PATH),
    mimeType: 'image/jpeg',
    originalName: 'costco.jpg',
    source: 'cli',
  });
}

let restoreFetch;
afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
});
after(() => tmp.cleanup());

// Route fetch to the right fake backend by URL.
function routeFetch() {
  return stubFetch((url, opts) => {
    if (/\/v1\/messages$/.test(url)) {
      return jsonResponse({ content: [{ type: 'text', text: JSON.stringify(structured) }] });
    }
    if (/\/search$/.test(url)) {
      const q = JSON.parse(opts.body).query;
      return jsonResponse({
        images: [{ url: `https://img.example/${encodeURIComponent(q)}.jpg`, description: q }],
        results: [{ title: q, url: 'https://shop.example/x', content: 'about ' + q }],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

test('full pipeline: vision extract -> parse -> Tavily enrich -> summarize -> done', async () => {
  // Vision + enrichment both "configured" (fetch is stubbed, so no real calls).
  config.ocrProvider = 'vision';
  config.vision.provider = 'anthropic';
  config.vision.anthropic.apiKey = 'sk-ant-test';
  config.enrich.enabled = true;
  config.enrich.maxItems = 40;
  config.enrich.tavily.apiKey = 'tvly-test';
  restoreFetch = routeFetch();

  const created = await newReceipt();
  const result = await processReceipt(created.id);

  // Final state
  assert.equal(result.status, 'done');
  assert.equal(result.extraction.provider, 'vision');
  assert.equal(result.store.name, 'Costco');
  assert.equal(result.items.length, structured.items.length);
  assert.equal(result.totals.total, 116.37);

  // Every item got enriched with an image (Tavily stub always returns one).
  assert.ok(result.items.every((i) => i.enrichment && i.enrichment.imageUrl), 'all items enriched');

  // Summary reflects store, item count and enriched count.
  assert.match(result.summary, /Costco/);
  assert.match(result.summary, new RegExp(`${structured.items.length} item\\(s\\)`));
  assert.match(result.summary, /\$116\.37/);
  assert.match(result.summary, new RegExp(`${structured.items.length} item\\(s\\) matched`));

  // Timings recorded for each stage.
  assert.ok(typeof result.timings.ocrMs === 'number');
  assert.ok(typeof result.timings.enrichMs === 'number');
  assert.ok(typeof result.timings.totalMs === 'number');

  // The durable record on disk matches the returned record.
  const persisted = await store.get(created.id);
  assert.equal(persisted.status, 'done');
  assert.equal(persisted.summary, result.summary);
});

test('graceful degradation: tesseract OCR + no enrichment still finishes "done"', async () => {
  // No vision/Tavily keys -> heuristic OCR path, enrichment skipped.
  config.ocrProvider = 'tesseract';
  config.enrich.enabled = false;

  // Stub the heavy Tesseract module with a canned OCR dump of the sample.
  const { rawOcrText } = require('./fixtures/costco-sample');
  const tessPath = require.resolve('../src/ocr/tesseract');
  require.cache[tessPath] = {
    id: tessPath,
    filename: tessPath,
    loaded: true,
    exports: { extract: async () => ({ rawText: rawOcrText, structured: null }) },
  };

  restoreFetch = stubFetch(() => {
    throw new Error('no network expected with no keys');
  });

  const created = await newReceipt();
  const result = await processReceipt(created.id);

  assert.equal(result.status, 'done');
  assert.equal(result.extraction.provider, 'tesseract');
  assert.equal(result.store.name, 'Costco');
  assert.ok(result.items.length >= 12, 'heuristic parser found the line items');
  assert.ok(result.items.every((i) => i.enrichment == null), 'no enrichment without a key');
  assert.match(result.summary, /0 item\(s\) matched with images/);
});

test('a failing extraction propagates so the worker can mark the record failed', async () => {
  // The worker catches the throw and sets status=failed on the final attempt;
  // here we assert the pipeline surfaces the error rather than swallowing it.
  config.ocrProvider = 'vision';
  config.vision.provider = 'anthropic';
  config.vision.anthropic.apiKey = 'sk-ant-test';
  restoreFetch = stubFetch((url) => {
    if (/\/v1\/messages$/.test(url)) {
      return { ok: false, status: 500, async text() { return 'boom'; }, async json() { return {}; } };
    }
    throw new Error('unexpected');
  });

  const created = await newReceipt();
  await assert.rejects(() => processReceipt(created.id), /Anthropic API 500/);

  // The record was advanced to "processing" before the failure (observable progress).
  const persisted = await store.get(created.id);
  assert.equal(persisted.status, 'processing');
});
