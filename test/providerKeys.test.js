'use strict';

// Settings -> Providers: the deployment's keys.
//
// The assertions worth the file are the ones a page cannot make for itself:
// that a secret never leaves this service whole, that a key the provider refuses
// is never stored and the one in use keeps working, that a saved key reaches the
// NEXT call without a restart, and that an answer about an old key is never
// shown as an answer about the new one.
//
// The providers are a local HTTP server standing in for all four, reached by
// the same base-url settings the real calls use -- so the probe, the routes and
// the call-site recording are the shipping code end to end, with no network.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('provider-keys-test');
installFakeRedis();

// What .env holds, for this file. Set BEFORE config is required, and set even
// when empty -- dotenv does not override a variable that exists, so the checkout's
// own .env cannot leak a real key into the suite.
process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env-b2Tn';
process.env.OPENAI_API_KEY = '';
process.env.TAVILY_API_KEY = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.ENRICH_ENABLED = '';
process.env.OCR_PROVIDER = 'auto';
process.env.VISION_PROVIDER = 'anthropic';
delete process.env.PROVIDER_KEYS_SECRET;

// The provider: a key is accepted when it starts with `good-`, refused with a
// 401 otherwise, and a key starting `busy-` gets a 529 -- an answer about the
// provider's afternoon, not about the key.
const seen = [];
const fake = http.createServer((req, res) => {
  const auth = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer /, '') ||
    (req.url.match(/^\/bot([^/]+)\//) || [])[1] || '';
  seen.push({ url: req.url, key: auth });
  const status = /^good-/.test(auth) ? 200 : /^busy-/.test(auth) ? 529 : 401;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { data: [] } : { error: 'no' }));
});

// Never open a BullMQ connection.
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async () => ({ id: 'job' }),
    enqueueProcessAndApply: async () => ({ id: 'job' }),
    enqueueProcessApplyAndResolve: async () => ({ id: 'job' }),
    receiptsQueue: {},
    connection: {},
  },
};

let config;
let keys;
let server;
let base;

before(async () => {
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${fake.address().port}`;
  process.env.ANTHROPIC_BASE_URL = root;
  process.env.OPENAI_BASE_URL = root;
  process.env.TAVILY_BASE_URL = root;
  process.env.TELEGRAM_API_ROOT = root;

  config = require('../src/config');
  keys = require('../src/settings/providerKeys');
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

function put(key, body) {
  return fetch(`${base}/api/settings/providers/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- what the page is allowed to know ----------------------------------------

test('GET answers every engine provider, and a secret as its last four characters', async () => {
  const res = await fetch(`${base}/api/settings/providers`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);

  assert.deepEqual(Object.keys(body).sort(), ['anthropic', 'openai', 'tavily', 'telegram']);
  assert.deepEqual(body.anthropic.fields.apiKey, { from: 'env', tail: 'b2Tn' });
  assert.deepEqual(body.openai.fields.apiKey, { from: null });
  assert.equal(body.anthropic.check, null);
  // THE VALUE NEVER LEAVES. Not whole, and not as any prefix longer than the tail.
  assert.ok(!text.includes('sk-ant-from-env'), 'the .env key must not appear in the answer');
});

test('Clerk, Auth0 and DeepSeek are not the engine\'s, and are refused rather than stored', async () => {
  for (const key of ['clerk', 'auth0', 'deepseek', '__proto__']) {
    const res = await put(key, { apiKey: 'good-whatever-1234' });
    assert.equal(res.status, 404, key);
  }
});

// --- the provider is asked first ---------------------------------------------

test('a key the provider refuses is NOT stored, and the key in use keeps working', async () => {
  const res = await put('anthropic', { apiKey: 'sk-mistyped-Zz99' });
  assert.equal(res.status, 422);
  const { error } = await res.json();
  assert.match(error, /^Anthropic did not accept it: it answered 401/);

  assert.equal(config.vision.anthropic.apiKey, 'sk-ant-from-env-b2Tn');
  assert.equal(fs.existsSync(keys._paths.keysFile()), false, 'nothing may be written for a refused key');
});

test('a provider that could not judge the key stores nothing either, and says it was not a refusal', async () => {
  const res = await put('anthropic', { apiKey: 'busy-9999-abcd' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /could not check it \(it answered 529.*nothing was stored/);
  assert.equal(config.vision.anthropic.apiKey, 'sk-ant-from-env-b2Tn');
});

test('blank means keep, an unknown field is refused, and a paste of the wrong thing is refused', async () => {
  assert.equal((await put('anthropic', { apiKey: '   ' })).status, 400);
  assert.equal((await put('anthropic', {})).status, 400);
  assert.equal((await put('anthropic', { botToken: 'good-1234567' })).status, 400);
  assert.equal((await put('anthropic', { apiKey: 'good key with spaces' })).status, 400);
  assert.equal((await put('anthropic', { apiKey: 42 })).status, 400);
});

// --- a saved key wins, per call ----------------------------------------------

test('an accepted key is stored sealed, wins over .env, and reaches the NEXT call', async () => {
  const before = config.vision.anthropic.apiKey;
  const res = await put('anthropic', { apiKey: 'good-anthropic-Qm7w' });
  assert.equal(res.status, 200);
  const rec = await res.json();

  assert.equal(rec.fields.apiKey.from, 'saved');
  assert.equal(rec.fields.apiKey.tail, 'Qm7w');
  assert.equal(rec.fields.apiKey.envTail, 'b2Tn', 'what .env holds UNDER it, so Remove can say what it falls back to');
  assert.ok(rec.fields.apiKey.savedAt);
  assert.equal(rec.check.ok, true, 'the provider just answered for exactly this key');

  // Per call: the same config object, read again, with no reload and no restart.
  assert.equal(before, 'sk-ant-from-env-b2Tn');
  assert.equal(config.vision.anthropic.apiKey, 'good-anthropic-Qm7w');
  assert.equal(config.products.anthropic.apiKey, 'good-anthropic-Qm7w', 'the product resolver uses the same key');

  // AT REST, SEALED: neither the file nor anything beside it holds the key.
  const onDisk = fs.readFileSync(keys._paths.keysFile(), 'utf8');
  assert.ok(!onDisk.includes('good-anthropic'), 'the key must not be on disk in plain text');
  assert.equal(fs.statSync(keys._paths.keysFile()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(keys._paths.secretFile()).mode & 0o777, 0o600);
});

test('a key saved by ANOTHER process is seen on the next read here', async () => {
  // What the worker experiences when the api saves: the file is replaced under
  // it. Simulated by sealing a new value through a second copy of the module.
  const path = require.resolve('../src/settings/providerKeys');
  const cached = require.cache[path];
  delete require.cache[path];
  const other = require('../src/settings/providerKeys');
  require.cache[path] = cached;

  await other.save('tavily', { apiKey: 'good-tavily-9fKd' }, { probe: async () => ({ ok: true }) });
  assert.equal(config.enrich.tavily.apiKey, 'good-tavily-9fKd');
  assert.equal(config.enrich.enabled, true, 'enrichment follows whether there is a Tavily key');
});

test('"auto" OCR follows the key per call: tesseract without one, vision with one', async () => {
  assert.equal(config.ocrProvider, 'vision');
  await keys.remove('anthropic');
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = '';
  try {
    assert.equal(config.ocrProvider, 'tesseract');
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
  }
  assert.equal(config.ocrProvider, 'vision');
});

// --- remove -------------------------------------------------------------------

test('Remove takes away only what was saved here, and .env answers again', async () => {
  assert.equal((await put('anthropic', { apiKey: 'good-anthropic-Qm7w' })).status, 200);
  const res = await fetch(`${base}/api/settings/providers/anthropic`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const rec = await res.json();
  assert.deepEqual(rec.fields.apiKey, { from: 'env', tail: 'b2Tn' });
  assert.equal(rec.check, null, 'nothing has called the provider with the key now in use');
  assert.equal(config.vision.anthropic.apiKey, 'sk-ant-from-env-b2Tn');

  // Removing a value that only .env holds changes nothing, and cannot.
  const again = await (await fetch(`${base}/api/settings/providers/anthropic`, { method: 'DELETE' })).json();
  assert.deepEqual(again.fields.apiKey, { from: 'env', tail: 'b2Tn' });
});

test('with nothing under it, Remove leaves the provider with no key at all', async () => {
  assert.equal((await put('openai', { apiKey: 'good-openai-x81Q' })).status, 200);
  assert.equal(config.vision.openai.apiKey, 'good-openai-x81Q');
  const rec = await (await fetch(`${base}/api/settings/providers/openai`, { method: 'DELETE' })).json();
  assert.deepEqual(rec.fields.apiKey, { from: null });
  assert.equal(config.vision.openai.apiKey, '');
});

// --- the last answer ------------------------------------------------------------

test('a real call that is refused is recorded, and shown -- red -- on the card', async () => {
  keys._reset();
  keys.observe('anthropic', 'sk-ant-from-env-b2Tn', 401, 'Unauthorized');
  const rec = keys.view('anthropic');
  assert.equal(rec.check.ok, false);
  assert.equal(rec.check.status, 401);
  assert.equal(rec.check.said, 'Unauthorized');
});

test('a 429 or a 500 says nothing about the key, and is not recorded', async () => {
  keys._reset();
  keys.observe('anthropic', 'sk-ant-from-env-b2Tn', 200);
  keys._reset();
  keys.observe('anthropic', 'sk-ant-from-env-b2Tn', 529, 'Overloaded');
  keys.observe('anthropic', 'sk-ant-from-env-b2Tn', 500);
  assert.equal(keys.view('anthropic').check.ok, true);
});

test('an answer about a REPLACED key is not shown as an answer about the new one', async () => {
  keys._reset();
  keys.observe('anthropic', 'sk-ant-from-env-b2Tn', 401, 'Unauthorized');
  assert.equal(keys.view('anthropic').check.ok, false);
  // The operator edits .env and restarts: the check on disk is about the old key.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-rotated-in-env-7777';
  try {
    assert.equal(keys.view('anthropic').check, null);
  } finally {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env-b2Tn';
  }
});

test('the vision call records its answer against the key it used', async () => {
  keys._reset();
  const store = require('../src/store');
  const vision = require('../src/ocr/vision');
  // A saved key the fake provider refuses on a real call -- revoked, say, in the
  // provider's dashboard after it was accepted here.
  await keys.save('anthropic', { apiKey: 'revoked-later-Lw3E' }, { probe: async () => ({ ok: true }) });
  const record = { id: 'main:main:v1', image: { file: 'x.jpg', mimeType: 'image/jpeg' } };
  fs.mkdirSync(require('path').dirname(store.imagePathFor(record)), { recursive: true });
  fs.writeFileSync(store.imagePathFor(record), Buffer.alloc(8));
  await assert.rejects(
    vision.extract(record),
    /Anthropic API 401/
  );
  const rec = keys.view('anthropic');
  assert.equal(rec.check.ok, false);
  assert.equal(rec.check.status, 401);
  await keys.remove('anthropic');
});

// --- encryption --------------------------------------------------------------

test('a saved value that will not open is ignored, and .env answers -- never a garbled key', async () => {
  await keys.save('telegram', { botToken: 'good-123456:telegram' }, { probe: async () => ({ ok: true }) });
  assert.equal(config.telegram.token, 'good-123456:telegram');
  assert.equal(config.telegram.enabled, true);

  process.env.PROVIDER_KEYS_SECRET = 'a different secret than the one it was sealed with';
  keys._reset();
  try {
    assert.equal(config.telegram.token, '');
    assert.equal(config.telegram.enabled, false);
    assert.deepEqual(keys.view('telegram').fields.botToken, { from: null });
  } finally {
    delete process.env.PROVIDER_KEYS_SECRET;
    keys._reset();
  }
  assert.equal(config.telegram.token, 'good-123456:telegram');
  await keys.remove('telegram');
});

test('the probes ask each provider its own cheap question, and nothing that costs a credit', async () => {
  const { probe } = require('../src/settings/providerProbe');
  seen.length = 0;
  assert.deepEqual(await probe('anthropic', { apiKey: 'good-a-1234' }), { ok: true, status: 200 });
  assert.equal((await probe('openai', { apiKey: 'nope-1234' })).refused, true);
  assert.equal((await probe('tavily', { apiKey: 'good-t-1234' })).ok, true);
  assert.equal((await probe('telegram', { botToken: 'good-1:abc' })).ok, true);
  assert.deepEqual(seen.map((s) => s.url.replace(/bot[^/]+/, 'bot<token>')),
    ['/v1/models?limit=1', '/v1/models', '/usage', '/bot<token>/getMe']);
});
