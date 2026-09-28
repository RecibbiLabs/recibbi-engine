'use strict';

// DeepSeek's server-side web search (src/deepseekSearch.js). Hermetic: fetch is
// stubbed with replies in the shape DeepSeek's Anthropic-format endpoint was
// observed to answer in (2026-09-23): server_tool_use + web_search_tool_result
// blocks, then text.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, stubFetch, jsonResponse, textResponse } = require('./helpers/harness');

useTempDataDir('deepseek-search-test');
const ds = require('../src/deepseekSearch');

const OPTS = {
  apiKey: 'sk-ds-test', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
  thinking: false, maxSearches: 2, system: 'sys', user: 'Receipt line: "KS SPARK WAT"',
};

function searched(urls) {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'call_00',
    content: urls.map((url) => ({ type: 'web_search_result', title: `t ${url}`, url, encrypted_content: 'x', page_age: null })),
  };
}

test('asks the Anthropic-format endpoint with the web_search tool, max_uses, and thinking off', async () => {
  const restore = stubFetch((url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(opts.headers['x-api-key'], 'sk-ds-test');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.system, 'sys');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
    assert.equal(body.messages[0].content, 'Receipt line: "KS SPARK WAT"');
    return jsonResponse({
      stop_reason: 'end_turn',
      usage: { server_tool_use: { web_search_requests: 1 } },
      content: [
        { type: 'text', text: "I'll search for this product." },
        { type: 'server_tool_use', id: 'call_00', name: 'web_search', input: { query: 'kirkland sparkling water' } },
        searched(['https://www.costco.com/a.html', 'https://shop.example/b']),
        { type: 'text', text: '{"title":"x"}' },
      ],
    });
  });
  try {
    const out = await ds.search(OPTS);
    assert.match(out.text, /\{"title":"x"\}/);
    assert.deepEqual(out.results.map((r) => r.url), ['https://www.costco.com/a.html', 'https://shop.example/b']);
    assert.equal(out.searches, 1);
  } finally {
    restore();
  }
});

test('a pause_turn is resumed, and results from every turn are kept', async () => {
  let n = 0;
  const restore = stubFetch((url, opts) => {
    n += 1;
    const body = JSON.parse(opts.body);
    if (n === 1) {
      return jsonResponse({ stop_reason: 'pause_turn', content: [searched(['https://one.example/p'])] });
    }
    assert.equal(body.messages.length, 2, 'the paused assistant turn is sent back');
    assert.equal(body.messages[1].role, 'assistant');
    return jsonResponse({ stop_reason: 'end_turn', content: [searched(['https://two.example/p']), { type: 'text', text: '{}' }] });
  });
  try {
    const out = await ds.search(OPTS);
    assert.equal(n, 2);
    assert.deepEqual(out.results.map((r) => r.url), ['https://one.example/p', 'https://two.example/p']);
  } finally {
    restore();
  }
});

test('an error result block carries no pages, and does not break collection', () => {
  const pages = ds._internal.resultsOf([
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }] },
    searched(['https://ok.example/']),
  ]);
  assert.deepEqual(pages.map((p) => p.url), ['https://ok.example/']);
});

test('no answer, and a refusal, are both thrown -- never a silent empty result', async () => {
  let restore = stubFetch(() => jsonResponse({ stop_reason: 'max_tokens', content: [searched(['https://x.example/'])] }));
  try {
    await assert.rejects(() => ds.search(OPTS), /DeepSeek API returned no answer \(stop_reason: max_tokens\)/);
  } finally {
    restore();
  }
  restore = stubFetch(() => textResponse('{"error":{"message":"Authentication Fails"}}', { ok: false, status: 401 }));
  try {
    await assert.rejects(() => ds.search(OPTS), /DeepSeek API 401: .*Authentication Fails/);
  } finally {
    restore();
  }
});

test('grounded() keeps only a page the search returned', () => {
  const results = [
    { url: 'https://www.costcobusinessdelivery.com/kirkland-signature-sparkling-water%2c-variety-pack.product.100357967.html' },
    { url: 'https://www.instacart.com/products/20603825-kirkland?retailerSlug=big-save-market' },
    { url: 'https://www.tastingtable.com/1862769/worst/#1' },
  ];
  // Exactly as returned.
  assert.equal(ds.grounded(results[0].url, results), results[0].url);
  // The same page with its tracking query dropped, its fragment dropped, no www, a trailing slash.
  assert.ok(ds.grounded('https://instacart.com/products/20603825-kirkland', results));
  assert.ok(ds.grounded('https://www.tastingtable.com/1862769/worst/', results));
  // Decoded or encoded, it is the same path.
  assert.ok(ds.grounded('https://www.costcobusinessdelivery.com/kirkland-signature-sparkling-water,-variety-pack.product.100357967.html', results));
  // A plausible product page on a real retailer that the search never returned.
  assert.equal(ds.grounded('https://www.instacart.com/products/20194391-kirkland-signature-sparkling-water', results), null);
  assert.equal(ds.grounded('https://inst.cr/store/costco/products/20194391', results), null);
  // Not a URL at all.
  assert.equal(ds.grounded('costco.com', results), null);
  assert.equal(ds.grounded('javascript:alert(1)', [{ url: 'javascript:alert(1)' }]), null);
  assert.equal(ds.grounded(null, results), null);
});
