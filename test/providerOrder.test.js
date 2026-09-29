'use strict';

// Who does each job: VISION_PROVIDER, ENRICH_PROVIDER and PRODUCT_RESOLVER as
// ORDERED LISTS, the first usable provider chosen per call, a refusal during
// the call falling through to the next, an order saved from Settings winning
// over .env -- and a list in which nothing works ending in one sentence that
// says why, provider by provider.
//
// The providers are a local HTTP server standing in for all of them, reached by
// the same base-url settings the real calls use, as in providerKeys.test.js:
// a key starting `good-` is accepted, anything else is refused with a 401.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('provider-order-test');
installFakeRedis();

// .env, for this file: set even when empty so the checkout's own cannot leak in.
for (const v of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'TAVILY_API_KEY', 'TELEGRAM_BOT_TOKEN', 'ENRICH_ENABLED']) {
  process.env[v] = '';
}
process.env.OCR_PROVIDER = 'auto';
process.env.VISION_PROVIDER = 'anthropic,deepseek';
process.env.ENRICH_PROVIDER = 'tavily,deepseek';
process.env.PRODUCT_RESOLVER = 'anthropic,deepseek';
// The resolvers without their web tools: one plain answer per line.
process.env.PRODUCT_ANTHROPIC_WEB_SEARCH = '0';
process.env.PRODUCT_DEEPSEEK_WEB_SEARCH = '0';
process.env.PRODUCT_CACHE_ENABLED = '0';
delete process.env.PROVIDER_KEYS_SECRET;

const RECEIPT = JSON.stringify({ store: { name: 'Costco', date: null }, items: [], totals: { total: 1 } });
const seen = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const auth = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push({ url: req.url, key: auth });
    const ok = /^good-/.test(auth);
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    if (!ok) return res.end(JSON.stringify({ error: 'no' }));
    // A product lookup gets a product; anything else is a photo being read.
    const text = raw.includes('Receipt line item')
      ? JSON.stringify({ productTitle: `Named by ${auth.slice(5, 8)}`, confidence: 0.9 })
      : RECEIPT;
    if (req.url === '/anthropic/v1/messages') {
      // DeepSeek's web search, behind enrichment.
      const found = JSON.stringify({ title: `Looked up by ${auth.slice(5, 8)}`, url: null, snippet: null });
      return res.end(JSON.stringify({ content: [{ type: 'text', text: found }], stop_reason: 'end_turn' }));
    }
    if (req.url === '/v1/messages') return res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    return res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
});

const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: { enqueueReceipt: async () => ({ id: 'job' }), receiptsQueue: {}, connection: {} },
};

let config;
let order;
let keys;
let vision;
let store;
let server;
let base;

before(async () => {
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${fake.address().port}`;
  for (const v of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'DEEPSEEK_BASE_URL', 'TAVILY_BASE_URL']) process.env[v] = root;
  config = require('../src/config');
  order = require('../src/settings/providerOrder');
  keys = require('../src/settings/providerKeys');
  vision = require('../src/ocr/vision');
  store = require('../src/store');
  const { createApp } = require('../src/app');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fake.close();
  tmp.cleanup();
});

function withKeys(env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  keys._reset();
}

function photo(id) {
  const record = { id: `main:main:${id}`, image: { file: `${id}.jpg`, mimeType: 'image/jpeg' } };
  fs.mkdirSync(path.dirname(store.imagePathFor(record)), { recursive: true });
  fs.writeFileSync(store.imagePathFor(record), Buffer.alloc(8));
  return record;
}

/* ------------------------------------------------------------------ the list */

test('a list is trimmed, lower-cased, each name once, and a name that cannot do the job is dropped', () => {
  assert.deepEqual(order.parseList('vision', ' Anthropic , deepseek,anthropic,,tavily '), ['anthropic', 'deepseek']);
  assert.deepEqual(order.parseList('enrich', 'deepseek,tavily'), ['deepseek', 'tavily']);
  assert.deepEqual(order.parseList('products', 'openai'), []);
});

test('the order comes from .env, else the default -- and a single name still works', () => {
  assert.deepEqual(order.order('vision'), { order: ['anthropic', 'deepseek'], from: 'env' });
  const saved = process.env.VISION_PROVIDER;
  try {
    process.env.VISION_PROVIDER = 'deepseek';
    assert.deepEqual(order.order('vision').order, ['deepseek']);
    process.env.VISION_PROVIDER = '';
    assert.deepEqual(order.order('vision'), { order: ['anthropic'], from: 'default' });
    process.env.VISION_PROVIDER = 'nonsense';
    assert.deepEqual(order.order('vision'), { order: ['anthropic'], from: 'default' }, 'a list of typos is no list');
  } finally {
    process.env.VISION_PROVIDER = saved;
  }
});

/* ------------------------------------------------------- the first usable one */

test('the job goes to the first provider WITH A KEY, decided per call', () => {
  withKeys({ ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: 'good-ds-1' });
  const p = order.pick('vision');
  assert.equal(p.chosen, 'deepseek');
  assert.deepEqual(p.skipped, [{ id: 'anthropic', why: 'no key' }]);
  assert.equal(config.vision.provider, 'deepseek');
  assert.deepEqual(config.vision.providers, ['anthropic', 'deepseek']);
  assert.equal(config.ocrProvider, 'vision');
  assert.equal(config.products.resolver, 'deepseek');
  assert.equal(config.enrich.provider, 'deepseek');
  assert.equal(config.enrich.enabled, true, 'enrichment follows whether ANY lookup in the list can run');

  // A key arriving later changes the answer with no restart.
  withKeys({ ANTHROPIC_API_KEY: 'good-ant-1' });
  assert.equal(config.vision.provider, 'anthropic');
});

test('nobody usable: vision falls back to Tesseract under auto, and the job says why', () => {
  withKeys({ ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: '' });
  const p = order.pick('vision');
  assert.equal(p.chosen, null);
  assert.equal(config.ocrProvider, 'tesseract');
  assert.equal(config.vision.provider, 'anthropic', 'the first asked for, for a log line');
  assert.equal(config.enrich.enabled, false);
  assert.match(order.nobody('vision', p), /anthropic \(no key\), deepseek \(no key\) -- from VISION_PROVIDER/);
});

/* ----------------------------------------------------- refusal, and falling through */

test('a reader that refuses its key during the call hands the photo to the next, and is skipped after', async () => {
  withKeys({ ANTHROPIC_API_KEY: 'revoked-ant', DEEPSEEK_API_KEY: 'good-ds-2' });
  assert.equal(order.pick('vision').chosen, 'anthropic', 'nothing has said no yet');
  seen.length = 0;

  const out = await vision.extract(photo('fall1'));
  assert.equal(out.reader, 'deepseek');
  assert.equal(out.structured.store.name, 'Costco');
  assert.deepEqual(seen.map((s) => s.key), ['revoked-ant', 'good-ds-2']);

  // The refusal was recorded against that key, so the next photo does not ask.
  const p = order.pick('vision');
  assert.equal(p.chosen, 'deepseek');
  assert.deepEqual(p.skipped, [{ id: 'anthropic', why: 'refused', status: 401, at: p.skipped[0].at }]);
  seen.length = 0;
  await vision.extract(photo('fall2'));
  assert.deepEqual(seen.map((s) => s.key), ['good-ds-2']);

  // A NEW key is a new question: the old refusal was about the old key.
  withKeys({ ANTHROPIC_API_KEY: 'good-ant-2' });
  assert.equal(order.pick('vision').chosen, 'anthropic');
});

test('every reader refusing ends in ONE unrecoverable error naming each', async () => {
  withKeys({ ANTHROPIC_API_KEY: 'bad-ant-3', DEEPSEEK_API_KEY: 'bad-ds-3' });
  await assert.rejects(vision.extract(photo('none1')), (err) => {
    assert.equal(err.name, 'UnrecoverableError');
    assert.match(err.message, /anthropic \(refused: 401\), deepseek \(refused: 401\)/);
    return true;
  });
  // And now both are known to be refused, before any call.
  await assert.rejects(vision.extract(photo('none2')), (err) => {
    assert.equal(err.name, 'UnrecoverableError');
    assert.match(err.message, /no provider can do "vision": anthropic \(refused: 401\), deepseek \(refused: 401\)/);
    return true;
  });
});

/* -------------------------------------------------------- from the screen */

async function call(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('an order saved in Settings wins over .env, per call, and removing it gives .env back', async () => {
  withKeys({ ANTHROPIC_API_KEY: 'good-ant-4', DEEPSEEK_API_KEY: 'good-ds-4' });

  const all = await call('GET', '/api/settings/provider-order');
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(all.body).sort(), ['enrich', 'products', 'vision']);
  assert.equal(all.body.vision.from, 'env');
  assert.equal(all.body.vision.chosen, 'anthropic');
  assert.deepEqual(all.body.vision.candidates, ['anthropic', 'openai', 'deepseek']);
  assert.deepEqual(all.body.vision.status.openai, { why: 'no key' });
  assert.deepEqual(all.body.vision.status.deepseek, { why: null });

  const saved = await call('PUT', '/api/settings/provider-order/vision', { order: ['deepseek', 'anthropic'] });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.from, 'saved');
  assert.deepEqual(saved.body.order, ['deepseek', 'anthropic']);
  assert.deepEqual(saved.body.envOrder, ['anthropic', 'deepseek'], 'what Reset would go back to');
  assert.equal(saved.body.chosen, 'deepseek');
  assert.equal(config.vision.provider, 'deepseek', 'the next photo, with no restart');
  assert.ok(fs.existsSync(order._paths.orderFile()));

  const back = await call('DELETE', '/api/settings/provider-order/vision');
  assert.equal(back.body.from, 'env');
  assert.equal(config.vision.provider, 'anthropic');
});

test('a list that names what cannot do the job, twice, or nothing is refused, and nothing is stored', async () => {
  for (const body of [{ order: [] }, { order: ['tavily'] }, { order: ['deepseek', 'deepseek'] }, {}, { order: 'deepseek' }]) {
    const res = await call('PUT', '/api/settings/provider-order/vision', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error);
  }
  assert.equal(order.order('vision').from, 'env');
  assert.equal((await call('PUT', '/api/settings/provider-order/telepathy', { order: ['anthropic'] })).status, 404);
});

test('a list may leave a provider out: it is then not tried, even with a working key', async () => {
  withKeys({ ANTHROPIC_API_KEY: 'good-ant-5', DEEPSEEK_API_KEY: '' });
  await call('PUT', '/api/settings/provider-order/products', { order: ['deepseek'] });
  try {
    const p = order.pick('products');
    assert.equal(p.chosen, null);
    assert.match(order.nobody('products', p), /deepseek \(no key\) -- from the order saved in Settings/);
  } finally {
    await call('DELETE', '/api/settings/provider-order/products');
  }
  assert.equal(order.pick('products').chosen, 'anthropic');
});

test('a resolver that refuses its key hands the rest of the receipt to the next one', async () => {
  withKeys({ ANTHROPIC_API_KEY: 'revoked-ant-7', DEEPSEEK_API_KEY: 'good-ds-7' });
  const profileStore = require('../src/receiptProfiles/profileStore');
  const resultStore = require('../src/receiptProfiles/resultStore');
  const { resolveProductsForProfileResult } = require('../src/products/resolveService');
  config.products.concurrency = 1;

  const profile = await profileStore.create({ name: 'orderTest1', transformer: 'usGrocery' });
  const rec = await store.createReceipt({ buffer: Buffer.alloc(8, 1), mimeType: 'image/png', originalName: 'r.png', source: 'test' });
  await resultStore.save({
    receiptId: rec.id,
    profileId: profile.id,
    profileName: profile.name,
    store: { name: 'Costco', date: null },
    items: [
      { description: 'KS SPARK WAT', sku: '1', qty: 1, price: 4.99 },
      { description: 'EGGS', sku: '2', qty: 1, price: 5.99 },
    ],
  });

  seen.length = 0;
  const out = await resolveProductsForProfileResult(rec.id, profile.id);
  assert.deepEqual(out.products.map((p) => p.productTitle), ['Named by ds-', 'Named by ds-']);
  assert.equal(out.resolver, 'deepseek');
  assert.deepEqual(out.stats, { resolved: 2, skipped: 0, cached: 0, errors: 0 });
  // Anthropic was asked ONCE -- the first line -- and dropped for the second.
  assert.equal(seen.filter((s) => s.key === 'revoked-ant-7').length, 1);
  assert.equal(order.pick('products').chosen, 'deepseek');
});

test('an enrichment lookup that is refused hands every line to the next provider, asking the first once', async () => {
  withKeys({ TAVILY_API_KEY: 'revoked-tav-8', DEEPSEEK_API_KEY: 'good-ds-8' });
  const { enrichItems } = require('../src/enrich');
  config.enrich.concurrency = 1;
  const items = [
    { description: 'KS SPARK WAT', sku: '1', price: 4.99 },
    { description: 'EGGS', sku: '2', price: 5.99 },
  ];
  seen.length = 0;
  const stats = await enrichItems(items, 'Costco', { tenantId: 'main' });
  assert.deepEqual(items.map((i) => i.enrichment && i.enrichment.title), ['Looked up by ds-', 'Looked up by ds-']);
  assert.equal(stats.enriched, 2);
  assert.equal(stats.errors, 0);
  assert.equal(seen.filter((x) => x.key === 'revoked-tav-8').length, 1);
  assert.equal(order.pick('enrich').chosen, 'deepseek');
});

test('/health names who would do each job now, and the order it was chosen from', async () => {
  withKeys({ ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: 'good-ds-6' });
  const res = await fetch(`${base}/health`);
  const h = await res.json();
  assert.equal(h.visionProvider, 'deepseek');
  assert.deepEqual(h.visionProviders, ['anthropic', 'deepseek']);
  assert.equal(h.enrichmentProvider, 'deepseek');
  assert.deepEqual(h.products.resolvers, ['anthropic', 'deepseek']);
  assert.equal(h.products.resolver, 'deepseek');
});

test('a pin (what the suite does) overrides every source, and unpinning gives them back', () => {
  config.enrich.provider = 'deepseek';
  try {
    assert.deepEqual(order.order('enrich'), { order: ['deepseek'], from: 'pinned' });
  } finally {
    config.enrich.provider = null;
  }
  assert.equal(order.order('enrich').from, 'env');
});
