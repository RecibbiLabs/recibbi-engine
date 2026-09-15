'use strict';

// Retailer-sourced enrichment: what "Enrich with retailer product page" does,
// and — the part worth a test file — WHAT IT DELIBERATELY DECLINES TO DO.
//
// The tempting implementation builds an enrichment for every line out of the
// thumbnail and the description the payload already carried. It would look like
// it worked: every line "enriched", every stat up. It would also restate each
// item's own fields back to itself and, worse, satisfy the has-an-enrichment
// check that would otherwise have sent the line to the web search. The member
// would get a receipt reported as enriched that had learned nothing at all.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useTempDataDir, installFakeRedis, stubFetch, jsonResponse } = require('./helpers/harness');

const tmp = useTempDataDir('enrich-retailer-test');
installFakeRedis();

const config = require('../src/config');
const { enrichItems, fromRetailer } = require('../src/enrich');
const adapter = require('../src/retailers/adapters/samsclub.com');

after(() => tmp.cleanup());

const CORPUS = '/Users/osipov/Projects/codex-receipt-retailer-ground-truth/samsclub.com';

function online() {
  return { description: 'steep by Bigelow Lemon Ginger Herbal Tea, 60 ct',
           imageUrl: 'https://scene7.samsclub.com/is/image/samsclub/x',
           productUrl: 'https://www.samsclub.com/ip/steep-by-Bigelow/7231029088',
           enrichment: null };
}
function inClub() {
  return { description: 'MINI CUCUMBE', imageUrl: 'https://scene7.samsclub.com/is/image/samsclub/y',
           productUrl: null, enrichment: null };
}

test('a line the retailer published a page for is enriched with no lookup', () => {
  const e = fromRetailer(online());
  assert.equal(e.source, 'retailer');
  assert.equal(e.url, 'https://www.samsclub.com/ip/steep-by-Bigelow/7231029088');
  assert.equal(e.query, null, 'nothing was searched for');
});

test('a line with no product page gets NOTHING from the retailer path', () => {
  // Not an empty enrichment, not one made of the item's own fields. Null, so it
  // falls through to the search that might actually find something.
  assert.equal(fromRetailer(inClub()), null);
  assert.equal(fromRetailer({ description: 'x', imageUrl: 'https://img', enrichment: null }), null);
});

test('the fallback to the web search is real, per line, in one pass', async () => {
  const original = config.enrich.enabled;
  const originalKey = config.enrich.tavily.apiKey;
  config.enrich.enabled = true;
  config.enrich.tavily.apiKey = 'test-key'; // searchItem returns null without one
  const restore = stubFetch(() =>
    jsonResponse({ images: [{ url: 'https://web/img.jpg', description: 'a cucumber' }],
                   results: [{ title: 'Cucumber', url: 'https://web/p', content: 'green' }] }));
  try {
    const items = [online(), inClub()];
    const stats = await enrichItems(items, "Sam's Club", { tenantId: 'acme', source: 'retailer' });

    assert.equal(items[0].enrichment.source, 'retailer');
    assert.equal(items[0].enrichment.url, 'https://www.samsclub.com/ip/steep-by-Bigelow/7231029088');

    // The in-club line went to the search rather than being left bare.
    assert.equal(items[1].enrichment.source, undefined, 'absent source means the web search');
    assert.equal(items[1].enrichment.url, 'https://web/p');

    assert.equal(stats.enriched, 2);
    assert.equal(stats.fromRetailer, 1);
    assert.equal(restore.calls.length, 1, 'exactly one lookup — the retailer line needed none');
  } finally {
    restore();
    config.enrich.enabled = original;
    config.enrich.tavily.apiKey = originalKey;
  }
});

test('the default source is the web, exactly as it always was', async () => {
  const original = config.enrich.enabled;
  const originalKey = config.enrich.tavily.apiKey;
  config.enrich.enabled = true;
  config.enrich.tavily.apiKey = 'test-key';
  const restore = stubFetch(() => jsonResponse({ images: [], results: [] }));
  try {
    const items = [online()];
    // No `source` given: the retailer's own product page is NOT consulted, so a
    // caller that has not opted in sees no change in behaviour.
    await enrichItems(items, "Sam's Club", { tenantId: 'acme' });
    assert.equal(restore.calls.length, 1);
    assert.notEqual(items[0].enrichment && items[0].enrichment.source, 'retailer');
  } finally {
    restore();
    config.enrich.enabled = original;
    config.enrich.tavily.apiKey = originalKey;
  }
});

test('the retailer path works with no TAVILY_API_KEY at all', async () => {
  // It needs neither the key nor the network, so a deployment with enrichment
  // switched off still gets the lines it can genuinely enrich.
  const original = config.enrich.enabled;
  config.enrich.enabled = false;
  try {
    const items = [online(), inClub()];
    const stats = await enrichItems(items, "Sam's Club", { tenantId: 'acme', source: 'retailer' });
    assert.equal(items[0].enrichment.source, 'retailer');
    assert.equal(items[1].enrichment, null, 'the line that needed a search got none, and says so');
    assert.equal(stats.enriched, 1);
    assert.equal(stats.skipped, 1);
  } finally {
    config.enrich.enabled = original;
  }
});

// --- the adapter's half -----------------------------------------------------

test('canonicalUrl is a PATH, and is made absolute exactly once', () => {
  const payload = {
    summary: { orderId: '1', fulfillmentType: 'GLASS' },
    detail: { groups_2101: [{ categories: [{ items: [{
      id: 'l1', quantity: 1,
      productInfo: { name: 'Tea', usItemId: '7231029088', canonicalUrl: '/ip/Tea/7231029088',
                     imageInfo: { thumbnailUrl: 'https://scene7/x' } },
      priceInfo: { linePrice: { value: 9.98 }, unitPrice: { value: 9.98 } },
    }] }] }] },
  };
  const out = adapter.normalize(payload);
  const item = out.items.find((i) => i.description === 'Tea');
  // Stored as-is it would resolve against whatever page rendered it — a link on
  // Recibbi's own site pointing at Recibbi's own 404.
  assert.equal(item.productUrl, 'https://www.samsclub.com/ip/Tea/7231029088');
});

test('a canonicalUrl that is not a site-relative path is refused, not completed', () => {
  const make = (canonicalUrl) => ({
    summary: { orderId: '1', fulfillmentType: 'GLASS' },
    detail: { groups_2101: [{ categories: [{ items: [{
      id: 'l1', quantity: 1,
      productInfo: { name: 'X', usItemId: '1', canonicalUrl },
      priceInfo: { linePrice: { value: 1 } },
    }] }] }] },
  });
  const urlOf = (c) => adapter.normalize(make(c)).items.find((i) => i.description === 'X').productUrl;

  // `//evil.example/x` would inherit our scheme and point off-site entirely.
  assert.equal(urlOf('//evil.example/phish'), null);
  assert.equal(urlOf('javascript:alert(1)'), null);
  assert.equal(urlOf('ip/no-leading-slash'), null);
  // An already-absolute one is left alone rather than being prefixed twice.
  assert.equal(urlOf('https://www.samsclub.com/ip/X/1'), 'https://www.samsclub.com/ip/X/1');
});

test('the measured coverage, re-derived from the corpus', { skip: !fs.existsSync(CORPUS) }, () => {
  // The number the Settings copy quotes at the member. It is a CLIFF, not a
  // long tail: an in-club line carries a truncated register string where a
  // catalogue id would be, so it has no product page and cannot be given one.
  let lines = 0, withUrl = 0, glassLines = 0, glassWithUrl = 0;
  for (const f of fs.readdirSync(CORPUS).filter((n) => n.endsWith('.json'))) {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(path.join(CORPUS, f), 'utf8')); } catch { continue; }
    let out;
    try { out = adapter.normalize(payload); } catch { continue; }
    const isOnline = JSON.stringify(payload).includes('GLASS');
    for (const item of out.items || []) {
      lines += 1;
      if (item.productUrl) withUrl += 1;
      if (isOnline) {
        glassLines += 1;
        if (item.productUrl) glassWithUrl += 1;
      }
    }
  }
  assert.equal(lines, 1438);
  assert.equal(withUrl, 14);
  assert.equal(glassWithUrl, 14, 'every product page in the corpus is on an online order');
  assert.equal(lines - glassLines, 1419);
  assert.equal(withUrl - glassWithUrl, 0, 'not one in-club line has a product page');
});
