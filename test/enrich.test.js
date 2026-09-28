'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis, stubFetch, jsonResponse, textResponse } = require('./helpers/harness');

useTempDataDir('enrich-test');
const fakeRedis = installFakeRedis(); // must precede requiring enrich (it pulls in ../redis)
const config = require('../src/config');
const { enrichItems } = require('../src/enrich');

// A canned Tavily search response.
function tavilyHit(query) {
  return {
    images: [{ url: `https://img.example/${encodeURIComponent(query)}.jpg`, description: `photo of ${query}` }],
    results: [{ title: `${query} — buy online`, url: 'https://shop.example/x', content: 'Great product. '.repeat(40) }],
  };
}

let restoreFetch;
beforeEach(() => {
  // Default: enrichment on, by Tavily, with a (fake) Tavily key -- pinned, so an
  // operator's ENRICH_PROVIDER in the checkout's .env cannot choose for the suite.
  config.enrich.provider = 'tavily';
  config.enrich.enabled = true;
  config.enrich.maxItems = 40;
  config.enrich.tavily.apiKey = 'tvly-test-key';
  fakeRedis.store.clear();
  fakeRedis.calls.get = fakeRedis.calls.set = 0;
});
afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
});

test('skips enrichment entirely when disabled (no key)', async () => {
  config.enrich.enabled = false;
  restoreFetch = stubFetch(() => {
    throw new Error('fetch should not be called when enrichment is disabled');
  });
  const items = [{ description: 'KS WATER GAL', enrichment: null }];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(items[0].enrichment, null, 'item left un-enriched');
  assert.equal(stats.enriched, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(restoreFetch.calls.length, 0, 'no network calls');
});

test('enriches an item with image + metadata from Tavily', async () => {
  restoreFetch = stubFetch((url, opts) => {
    assert.match(url, /\/search$/, 'calls the Tavily search endpoint');
    const body = JSON.parse(opts.body);
    assert.equal(body.include_images, true, 'requests images');
    return jsonResponse(tavilyHit(body.query));
  });
  const items = [{ description: 'US WAGYUBEEF', enrichment: null }];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.enriched, 1);
  assert.ok(items[0].enrichment.imageUrl.startsWith('https://img.example/'));
  assert.ok(items[0].enrichment.title.includes('WAGYUBEEF'));
  assert.ok(items[0].enrichment.snippet.length <= 280, 'snippet is truncated');
  // The store name is folded into the query so lookups are store-aware.
  assert.ok(restoreFetch.calls.some((c) => JSON.parse(c.options.body).query.includes('Costco')));
});

test('caches lookups so a repeat item does not re-spend API credits', async () => {
  let networkCalls = 0;
  restoreFetch = stubFetch((url, opts) => {
    networkCalls += 1;
    return jsonResponse(tavilyHit(JSON.parse(opts.body).query));
  });
  // Same description twice -> identical query -> one network call, one cache hit.
  const items = [
    { description: 'SOUR CREAM', enrichment: null },
    { description: 'SOUR CREAM', enrichment: null },
  ];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.enriched, 2, 'both items end up enriched');
  assert.equal(networkCalls, 1, 'second lookup served from cache');
  assert.ok(fakeRedis.calls.set >= 1, 'result was written to the cache');
  // Within one receipt the repeat line shares the first line's lookup (they run
  // in parallel, so both would otherwise miss the cache together); the cache is
  // what saves the NEXT receipt the call.
  assert.ok(fakeRedis.calls.get >= 1, 'cache was consulted');
  assert.notEqual(items[0].enrichment, items[1].enrichment, 'each line owns its own enrichment object');

  const again = [{ description: 'SOUR CREAM', enrichment: null }];
  await enrichItems(again, 'Costco');
  assert.equal(networkCalls, 1, 'a later receipt is served from the cache');
  assert.equal(again[0].enrichment.title, items[0].enrichment.title);
});

test('respects ENRICH_MAX_ITEMS and skips the overflow', async () => {
  config.enrich.maxItems = 1;
  restoreFetch = stubFetch((url, opts) => jsonResponse(tavilyHit(JSON.parse(opts.body).query)));
  const items = [
    { description: 'KS WATER GAL', enrichment: null },
    { description: 'SWISS', enrichment: null },
  ];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.enriched, 1);
  assert.equal(stats.skipped, 1);
  assert.ok(items[0].enrichment, 'first item enriched');
  assert.equal(items[1].enrichment, null, 'capped item left alone');
});

test('degrades gracefully when a lookup errors (record marked, others continue)', async () => {
  restoreFetch = stubFetch((url, opts) => {
    const q = JSON.parse(opts.body).query;
    if (/SWISS/.test(q)) return textResponse('rate limited', { ok: false, status: 429 });
    return jsonResponse(tavilyHit(q));
  });
  const items = [
    { description: 'SWISS', enrichment: null }, // will error
    { description: 'YELLOW ONION', enrichment: null }, // will succeed
  ];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.errors, 1);
  assert.equal(stats.enriched, 1);
  assert.ok(items[0].enrichment.error, 'failed item carries an error note, not a crash');
  assert.ok(items[1].enrichment.imageUrl, 'subsequent item still enriched');
});

test('treats an empty-key Tavily response as a skip, not an error', async () => {
  config.enrich.tavily.apiKey = ''; // searchItem returns null without a key
  restoreFetch = stubFetch(() => {
    throw new Error('should not fetch without an api key');
  });
  const items = [{ description: 'MIXED PEPPER', enrichment: null }];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.errors, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(items[0].enrichment, null);
});

// --- ENRICH_PROVIDER=deepseek ------------------------------------------------

function deepseekReply(answer, urls) {
  return jsonResponse({
    stop_reason: 'end_turn',
    content: [
      { type: 'web_search_tool_result', tool_use_id: 'call_00',
        content: urls.map((url) => ({ type: 'web_search_result', title: 'r', url, encrypted_content: 'x' })) },
      { type: 'text', text: JSON.stringify(answer) },
    ],
  });
}

function withDeepSeek(fn) {
  return async () => {
    config.enrich.provider = 'deepseek';
    config.enrich.deepseek.apiKey = 'sk-ds-test';
    config.products.emoji = true;
    try {
      await fn();
    } finally {
      config.enrich.provider = 'tavily';
      config.enrich.deepseek.apiKey = '';
    }
  };
}

test('DeepSeek enriches with a name, a page its search returned, a sentence and an emoji -- and no picture', withDeepSeek(async () => {
  const page = 'https://www.costco.com/kirkland-signature-sour-cream.product.100.html';
  restoreFetch = stubFetch((url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    const body = JSON.parse(opts.body);
    assert.equal(body.tools[0].name, 'web_search');
    assert.match(body.system, /emoji/);
    assert.match(body.messages[0].content, /Receipt line: "SOUR CREAM"\nStore: Costco\nPrice paid: \$4\.49/);
    return deepseekReply({ title: 'Kirkland Signature Sour Cream, 3 lb', url: page, snippet: 'Cultured sour cream. '.repeat(30), emoji: '🥛' }, [page]);
  });
  const items = [{ description: 'SOUR CREAM', price: 4.49, enrichment: null }];
  const stats = await enrichItems(items, 'Costco', { tenantId: 'acme' });
  assert.equal(stats.enriched, 1);
  const e = items[0].enrichment;
  assert.equal(e.source, 'deepseek');
  assert.equal(e.title, 'Kirkland Signature Sour Cream, 3 lb');
  assert.equal(e.url, page);
  assert.equal(e.imageUrl, null, 'a web search returns pages, not pictures');
  assert.equal(e.emoji, '🥛');
  assert.ok(e.snippet.length <= 280);
  assert.ok(fakeRedis.store.has(require('../src/enrich').cacheKey('SOUR CREAM Costco', 'acme', 'deepseek')),
    'cached under the provider it came from');
}));

test('DeepSeek: a link its search did not return is dropped; the name still enriches the line', withDeepSeek(async () => {
  restoreFetch = stubFetch(() =>
    deepseekReply({ title: 'Kirkland Signature Sour Cream', url: 'https://www.costco.com/made-up.product.999.html', snippet: null, emoji: null },
      ['https://www.costco.com/real.product.100.html']));
  const items = [{ description: 'SOUR CREAM', enrichment: null }];
  await enrichItems(items, 'Costco');
  assert.equal(items[0].enrichment.url, null);
  assert.equal(items[0].enrichment.title, 'Kirkland Signature Sour Cream');
}));

test('DeepSeek: nothing identified is skipped, and not cached', withDeepSeek(async () => {
  restoreFetch = stubFetch(() => deepseekReply({ title: null, url: null, snippet: null, emoji: null }, []));
  const items = [{ description: 'ZZ 0001', enrichment: null }];
  const stats = await enrichItems(items, 'Costco');
  assert.equal(stats.skipped, 1);
  assert.equal(items[0].enrichment, null);
  assert.equal(fakeRedis.calls.set, 0);
}));

test('switching provider never serves the other one\'s cached answer', withDeepSeek(async () => {
  // A Tavily answer for this line is already cached...
  config.enrich.provider = 'tavily';
  restoreFetch = stubFetch((url, opts) => jsonResponse(tavilyHit(JSON.parse(opts.body).query)));
  await enrichItems([{ description: 'MILK', enrichment: null }], 'Costco');
  restoreFetch();
  // ...and DeepSeek still makes its own lookup.
  config.enrich.provider = 'deepseek';
  restoreFetch = stubFetch(() => deepseekReply({ title: 'Kirkland Milk', url: null, snippet: null, emoji: null }, []));
  const items = [{ description: 'MILK', enrichment: null }];
  await enrichItems(items, 'Costco');
  assert.equal(restoreFetch.calls.length, 1);
  assert.equal(items[0].enrichment.source, 'deepseek');
}));

test('lookups run in parallel, up to ENRICH_CONCURRENCY at once', async () => {
  config.enrich.concurrency = 3;
  let open = 0;
  let peak = 0;
  restoreFetch = stubFetch(async (url, opts) => {
    open += 1;
    peak = Math.max(peak, open);
    await new Promise((r) => setTimeout(r, 10));
    open -= 1;
    return jsonResponse(tavilyHit(JSON.parse(opts.body).query));
  });
  try {
    const items = Array.from({ length: 7 }, (_, i) => ({ description: `ITEM ${i}`, enrichment: null }));
    const stats = await enrichItems(items, 'Costco');
    assert.equal(stats.enriched, 7);
    assert.equal(peak, 3);
    assert.ok(items.every((it) => it.enrichment && it.enrichment.title.startsWith(it.description)), 'each line got its own answer');
  } finally {
    config.enrich.concurrency = 5;
  }
});
