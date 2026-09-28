'use strict';

const { test, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { useTempDataDir, stubFetch, jsonResponse, textResponse } = require('./helpers/harness');

const tmp = useTempDataDir('vision-test');
const config = require('../src/config');
const store = require('../src/store');
const vision = require('../src/ocr/vision');
const { structured, SAMPLE_IMAGE_PATH } = require('./fixtures/costco-sample');

let record;
before(async () => {
  record = await store.createReceipt({
    buffer: fs.readFileSync(SAMPLE_IMAGE_PATH),
    mimeType: 'image/jpeg',
    originalName: 'costco.jpg',
  });
});
after(() => tmp.cleanup());

let restoreFetch;
beforeEach(() => {
  config.vision.provider = 'anthropic';
  config.vision.anthropic.apiKey = 'sk-ant-test';
  config.vision.anthropic.model = 'claude-sonnet-4-6';
});
afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
});

// Build a fake Anthropic Messages API response wrapping arbitrary text.
function anthropicReply(text) {
  return jsonResponse({ content: [{ type: 'text', text }] });
}

test('Anthropic path sends a base64 image + the configured model and key', async () => {
  restoreFetch = stubFetch((url, opts) => {
    assert.match(url, /\/v1\/messages$/);
    assert.equal(opts.headers['x-api-key'], 'sk-ant-test');
    assert.ok(opts.headers['anthropic-version'], 'sends an anthropic-version header');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'claude-sonnet-4-6');
    const image = body.messages[0].content.find((b) => b.type === 'image');
    assert.equal(image.source.type, 'base64');
    assert.equal(image.source.media_type, 'image/jpeg');
    assert.ok(image.source.data.length > 100, 'real base64 image payload attached');
    return anthropicReply(JSON.stringify(structured));
  });

  const out = await vision.extract(record);
  assert.ok(out.structured, 'structured JSON parsed from the model reply');
  assert.equal(out.structured.store.name, 'Costco');
  assert.equal(out.structured.items.length, structured.items.length);
});

test('strips ```json fences the model may add despite instructions', async () => {
  restoreFetch = stubFetch(() => anthropicReply('```json\n' + JSON.stringify(structured) + '\n```'));
  const out = await vision.extract(record);
  assert.ok(out.structured, 'fenced JSON still parses');
  assert.equal(out.structured.totals.total, 116.37);
});

test('recovers the JSON object when the model wraps it in prose', async () => {
  restoreFetch = stubFetch(() =>
    anthropicReply('Sure! Here is the receipt:\n' + JSON.stringify(structured) + '\nHope that helps.')
  );
  const out = await vision.extract(record);
  assert.ok(out.structured);
  assert.equal(out.structured.store.name, 'Costco');
});

test('returns structured=null (rawText kept) when the reply is not JSON', async () => {
  restoreFetch = stubFetch(() => anthropicReply('I could not read this receipt.'));
  const out = await vision.extract(record);
  assert.equal(out.structured, null, 'unparseable reply -> null, no throw');
  assert.ok(typeof out.rawText === 'string');
});

test('throws a descriptive error on a non-2xx API response', async () => {
  restoreFetch = stubFetch(() => textResponse('unauthorized', { ok: false, status: 401 }));
  await assert.rejects(() => vision.extract(record), /Anthropic API 401/);
});

test('OpenAI path uses chat/completions with a data: image URL', async () => {
  config.vision.provider = 'openai';
  config.vision.openai.apiKey = 'sk-openai-test';
  config.vision.openai.model = 'gpt-4o-mini';
  restoreFetch = stubFetch((url, opts) => {
    assert.match(url, /\/v1\/chat\/completions$/);
    assert.equal(opts.headers.authorization, 'Bearer sk-openai-test');
    const body = JSON.parse(opts.body);
    const img = body.messages[0].content.find((b) => b.type === 'image_url');
    assert.match(img.image_url.url, /^data:image\/jpeg;base64,/);
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(structured) } }] });
  });
  const out = await vision.extract(record);
  assert.equal(out.structured.store.name, 'Costco');
});

test('DeepSeek path uses /chat/completions with a data: image, JSON mode, and thinking off', async () => {
  config.vision.provider = 'deepseek';
  config.vision.deepseek.apiKey = 'sk-deepseek-test';
  config.vision.deepseek.model = 'deepseek-flash';
  config.vision.deepseek.thinking = false;
  restoreFetch = stubFetch((url, opts) => {
    // DeepSeek's OpenAI-format path has no /v1 prefix.
    assert.match(url, /api\.deepseek\.com\/chat\/completions$/);
    assert.equal(opts.headers.authorization, 'Bearer sk-deepseek-test');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
    // Images are accepted only in user messages.
    assert.equal(body.messages[0].role, 'user');
    const img = body.messages[0].content.find((b) => b.type === 'image_url');
    assert.match(img.image_url.url, /^data:image\/jpeg;base64,/);
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(structured) }, finish_reason: 'stop' }] });
  });
  const out = await vision.extract(record);
  assert.equal(out.structured.store.name, 'Costco');
  assert.equal(out.structured.items.length, structured.items.length);
});

test('DeepSeek empty content fails the attempt (so the job retries) instead of sealing no items', async () => {
  config.vision.provider = 'deepseek';
  config.vision.deepseek.apiKey = 'sk-deepseek-test';
  restoreFetch = stubFetch(() => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
  await assert.rejects(() => vision.extract(record), /DeepSeek API returned no content \(finish_reason: stop\)/);
});

test('DeepSeek non-2xx is a descriptive error', async () => {
  config.vision.provider = 'deepseek';
  config.vision.deepseek.apiKey = 'sk-deepseek-test';
  restoreFetch = stubFetch(() => textResponse('{"error":{"message":"Authentication Fails"}}', { ok: false, status: 401 }));
  await assert.rejects(() => vision.extract(record), /DeepSeek API 401: .*Authentication Fails/);
});
