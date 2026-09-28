'use strict';

// Unit tests for the DeepSeek product resolver. Hermetic: global fetch is
// stubbed (see helpers/harness), so no network and no API key are needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, stubFetch, jsonResponse, textResponse } = require('./helpers/harness');

useTempDataDir('products-resolver-deepseek-test');

const resolver = require('../src/products/resolvers/deepseek');
const anthropic = require('../src/products/resolvers/anthropic');

// webSearch defaults OFF here so the tests above the web-search section pin
// the no-search path; the section below turns it on.
function cfg({ emoji = true, thinking = false, webSearch = false } = {}) {
  return {
    products: {
      emoji,
      deepseek: {
        apiKey: 'test-key',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        thinking,
        webSearch,
        maxSearches: 3,
      },
    },
  };
}

const PRODUCT_JSON = JSON.stringify({
  productTitle: 'Kirkland Signature Sparkling Water',
  productDescription: 'Costco house-brand sparkling water.',
  productUrl: null,
  brand: 'Kirkland Signature',
  category: 'Beverages',
  emoji: '🥤',
  confidence: 0.8,
});

function reply(content, finish_reason = 'stop') {
  return jsonResponse({ choices: [{ message: { content }, finish_reason }] });
}

test('ready() follows the DeepSeek key', () => {
  assert.equal(resolver.ready(cfg()), true);
  const none = cfg();
  none.products.deepseek.apiKey = '';
  assert.equal(resolver.ready(none), false);
});

test('resolve sends system + user turns in JSON mode, and parses the product', async () => {
  const restore = stubFetch((url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(opts.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.tools, undefined, 'DeepSeek has no server-side web tools to offer');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /product-research/i);
    assert.match(body.messages[1].content, /Store: Costco/);
    return reply(PRODUCT_JSON);
  });
  try {
    const out = await resolver.resolve({ description: 'KS SPARK WAT', price: 4.99 }, { storeName: 'Costco', config: cfg() });
    assert.equal(out.productTitle, 'Kirkland Signature Sparkling Water');
    assert.equal(out.productUrl, null);
    assert.equal(out.emoji, '🥤');
  } finally {
    restore();
  }
});

test('the prompt does not claim a search it cannot make', () => {
  const ungrounded = anthropic.buildSystem(cfg(), { grounded: false });
  assert.match(ungrounded, /cannot browse/);
  assert.doesNotMatch(ungrounded, /the actual URL you found/);
  // The Anthropic resolver's own prompt is unchanged.
  assert.match(anthropic.buildSystem(cfg()), /Return the actual URL you found/);
});

test('thinking is sent as configured', async () => {
  const restore = stubFetch((url, opts) => {
    assert.deepEqual(JSON.parse(opts.body).thinking, { type: 'enabled' });
    return reply(PRODUCT_JSON);
  });
  try {
    await resolver.resolve({ description: 'MILK' }, { config: cfg({ thinking: true }) });
  } finally {
    restore();
  }
});

test('emoji is dropped when the feature is off, even if the model volunteers one', async () => {
  const restore = stubFetch(() => reply(PRODUCT_JSON));
  try {
    const out = await resolver.resolve({ description: 'KS SPARK WAT' }, { config: cfg({ emoji: false }) });
    assert.equal(out.emoji, null);
  } finally {
    restore();
  }
});

test('an unidentifiable item comes back null (skipped), not an error', async () => {
  const restore = stubFetch(() =>
    reply(JSON.stringify({ productTitle: null, productDescription: null, productUrl: null, confidence: 0.1 }))
  );
  try {
    assert.equal(await resolver.resolve({ description: '???' }, { config: cfg() }), null);
  } finally {
    restore();
  }
});

test('empty content and non-2xx both throw, so they are recorded as errors and never cached', async () => {
  let restore = stubFetch(() => reply('', 'length'));
  try {
    await assert.rejects(
      () => resolver.resolve({ description: 'MILK' }, { config: cfg() }),
      /DeepSeek API returned no content \(finish_reason: length\)/
    );
  } finally {
    restore();
  }
  restore = stubFetch(() => textResponse('rate limited', { ok: false, status: 429 }));
  try {
    await assert.rejects(() => resolver.resolve({ description: 'MILK' }, { config: cfg() }), /DeepSeek API 429/);
  } finally {
    restore();
  }
});

// --- with web search -----------------------------------------------------------

function searchReply(product, urls) {
  return jsonResponse({
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', id: 'call_00', name: 'web_search', input: { query: 'kirkland sparkling water' } },
      { type: 'web_search_tool_result', tool_use_id: 'call_00',
        content: urls.map((url) => ({ type: 'web_search_result', title: 'r', url, encrypted_content: 'x' })) },
      { type: 'text', text: 'Based on my search:\n' + JSON.stringify(product) },
    ],
  });
}

const FOUND = 'https://www.costcobusinessdelivery.com/kirkland-signature-sparkling-water.product.100357967.html';

test('with web search, it asks DeepSeek\'s Anthropic-format endpoint with the grounded prompt', async () => {
  const restore = stubFetch((url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(opts.headers['x-api-key'], 'test-key');
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
    assert.match(body.system, /Return the actual URL you found/);
    assert.match(body.messages[0].content, /KS SPARK WAT/);
    return searchReply({ ...JSON.parse(PRODUCT_JSON), productUrl: FOUND }, [FOUND]);
  });
  try {
    const out = await resolver.resolve({ description: 'KS SPARK WAT' }, { storeName: 'Costco', config: cfg({ webSearch: true }) });
    assert.equal(out.productTitle, 'Kirkland Signature Sparkling Water');
    assert.equal(out.productUrl, FOUND, 'a page the search returned is kept');
  } finally {
    restore();
  }
});

test('with web search, a link the search did not return is dropped and the product stands', async () => {
  const made = 'https://inst.cr/store/costco/products/20194391-kirkland-signature-sparkling-water-12-fl-oz';
  const restore = stubFetch(() => searchReply({ ...JSON.parse(PRODUCT_JSON), productUrl: made }, [FOUND]));
  try {
    const out = await resolver.resolve({ description: 'KS SPARK WAT' }, { config: cfg({ webSearch: true }) });
    assert.equal(out.productUrl, null);
    assert.equal(out.productTitle, 'Kirkland Signature Sparkling Water');
  } finally {
    restore();
  }
});

test('with web search, the emoji flag is still authoritative', async () => {
  const restore = stubFetch(() => searchReply(JSON.parse(PRODUCT_JSON), [FOUND]));
  try {
    const out = await resolver.resolve({ description: 'KS SPARK WAT' }, { config: cfg({ webSearch: true, emoji: false }) });
    assert.equal(out.emoji, null);
  } finally {
    restore();
  }
});
