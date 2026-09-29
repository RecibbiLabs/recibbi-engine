'use strict';

const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { cache } = require('../redis');
const tavily = require('./tavily');
const deepseek = require('./deepseek');
const providerOrder = require('../settings/providerOrder');

// Who answers the web lookup: the ENRICH_PROVIDER order (or the one saved in
// Settings), walked per call like the keys it depends on -- the usable ones,
// first first (src/settings/providerOrder.js). Both take (query, { item,
// storeName }); Tavily needs only the query.
const SEARCH = { tavily: tavily.searchItem, deepseek: deepseek.searchItem };
function lookupChain() {
  return providerOrder.usable('enrich').filter((id) => SEARCH[id]);
}

// The enrichment cache is scoped PER TENANT: item enrichment is derived from a
// tenant's receipts (private-ish), and users within a tenant tend to shop the
// same stores, so sharing within a tenant keeps the hit rate high without
// leaking across tenants. (The product cache, by contrast, is global — a SKU's
// product identity is the same for everyone.) Tenant defaults to the configured
// identity so single-tenant callers need pass nothing.
//
// The provider is IN the key: a Tavily answer and a DeepSeek answer to the same
// line are different shapes (only one has a picture), and switching providers
// must not serve the other one's. Tavily's keys are unchanged, so its cache survives.
function cacheKey(query, tenantId, providerId = 'tavily') {
  const t = tenantId || config.defaultTenantId;
  const h = crypto.createHash('sha1').update(query.toLowerCase()).digest('hex');
  return `${t}:enrich:${providerId}:${h}`;
}

function buildQuery(item, storeName) {
  const parts = [item.description];
  if (storeName) parts.push(storeName);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function fromCache(query, tenantId, providerId) {
  try {
    const raw = await cache().get(cacheKey(query, tenantId, providerId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn({ err: err.message }, 'enrich cache read failed');
    return null;
  }
}

async function toCache(query, value, tenantId, providerId) {
  try {
    await cache().set(cacheKey(query, tenantId, providerId), JSON.stringify(value), 'EX', config.enrich.cacheTtlSeconds);
  } catch (err) {
    logger.warn({ err: err.message }, 'enrich cache write failed');
  }
}

/**
 * What the RETAILER already told us about this line, as an enrichment, or null.
 *
 * "Enrich with retailer product page" does not fetch that page. It does not
 * need to: the retailer's payload already carried the product's name, its own
 * photograph and the canonical URL of the page, which is the information a web
 * search is trying to reconstruct second-hand. Crawling the page to re-read
 * what was posted to us would be slower, ruder, and would introduce a failure
 * mode — a blocked or redesigned page — that we currently do not have.
 *
 * A LINE WITHOUT A PRODUCT URL GETS NOTHING FROM HERE, and that is the whole of
 * why this returns null rather than assembling something. An in-club line has a
 * thumbnail and a description, but both are ALREADY ON THE ITEM: an enrichment
 * built from them would restate the item's own fields back to itself, count as
 * `enriched` in the stats, and satisfy `productImage()` — so the member would
 * see a receipt reported as enriched that had learned nothing, and the web
 * lookup that could actually have found something would have been skipped
 * because the line already "had" an enrichment. Null sends it to the search.
 *
 * For Sam's Club that is 14 of 1,438 measured lines, essentially all of them
 * online orders; see productUrlOf() in the adapter for the split.
 */
function fromRetailer(item) {
  if (!item || typeof item !== 'object') return null;
  const url = typeof item.productUrl === 'string' && item.productUrl ? item.productUrl : null;
  if (!url) return null;
  return {
    // `source` marks where this came from. Absent means the web search: every
    // enrichment written before this existed came from Tavily, so absence is
    // the honest reading of an old record rather than a gap to be filled in.
    source: 'retailer',
    query: null, // nothing was searched for
    imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl || null : null,
    imageDescription: null,
    title: item.description || null,
    url,
    snippet: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Enrich items in place (mutates each item's `enrichment` field). The cache is
 * scoped to `tenantId` (default: configured tenant).
 *
 * `source` picks where enrichment is SOURCED FROM, not whether it runs:
 *   'web'      (default) every line goes to the web search, as it always has.
 *   'retailer' a line the retailer published a product page for is enriched
 *              from the payload itself, with no lookup at all; every other line
 *              FALLS BACK to the web search rather than being left bare.
 *
 * Degrades gracefully: if disabled or a lookup fails, items keep enrichment=null.
 * The retailer path is the one exception — it needs neither a lookup key nor
 * the network, so it still runs when the web search is switched off entirely.
 * A deployment with no lookup key that turns this switch on gets the 14 lines
 * it can genuinely enrich instead of nothing.
 *
 * The web lookups run in a bounded pool (config.enrich.concurrency). Which lines
 * get one is decided first, in order, so maxItems and the stats mean exactly
 * what they did when the lookups ran one at a time.
 *
 * @returns {Promise<{enriched:number, skipped:number, errors:number, fromRetailer:number}>}
 */
async function enrichItems(items, storeName, { tenantId, source } = {}) {
  const stats = { enriched: 0, skipped: 0, errors: 0, fromRetailer: 0 };
  const retailerFirst = source === 'retailer';

  // ONE CHAIN PER RECEIPT, shared by every line: a provider that refuses its key
  // on one line is dropped for the rest, so a revoked key costs one refusal and
  // not forty.
  const chain = lookupChain();
  const searching = config.enrich.enabled && chain.length > 0;
  if (!searching && !retailerFirst) {
    logger.info(
      { enabled: config.enrich.enabled, order: config.enrich.providers, skipped: providerOrder.pick('enrich').skipped },
      'enrichment: no lookup provider can run; skipping'
    );
    stats.skipped = items.length;
    return stats;
  }

  const lookups = [];
  let processed = 0;
  for (const item of items) {
    if (processed >= config.enrich.maxItems) {
      stats.skipped += 1;
      continue;
    }

    // The retailer's own answer, where there is one. Free, offline, and exact —
    // so it is not counted against maxItems and does not consume a lookup.
    if (retailerFirst) {
      const own = fromRetailer(item);
      if (own) {
        item.enrichment = own;
        stats.enriched += 1;
        stats.fromRetailer += 1;
        continue;
      }
    }

    // Everything else is the web search, including every line of a retailer
    // receipt the retailer published no page for.
    if (!searching) {
      stats.skipped += 1;
      continue;
    }

    const query = buildQuery(item, storeName);
    if (!query) {
      stats.skipped += 1;
      continue;
    }
    lookups.push({ item, query });
    processed += 1;
  }

  // ONE LOOKUP PER QUERY. Run in parallel, two identical lines (the same item
  // bought twice) would both miss the cache at the same moment and both be paid
  // for; the second waits on the first instead.
  const inFlight = new Map();
  const refusedNow = [];
  const lookupOnce = (query, item) => {
    if (!inFlight.has(query)) {
      inFlight.set(query, (async () => {
        while (chain.length) {
          const id = chain[0];
          let result = await fromCache(query, tenantId, id);
          if (result) return result;
          try {
            result = await SEARCH[id](query, { item, storeName });
          } catch (err) {
            // A refusal is about the KEY: drop the provider and ask the next
            // one the same question. Anything else fails this line only.
            if (!providerOrder.refused(id)) throw err;
            if (chain[0] === id) {
              chain.shift();
              refusedNow.push(providerOrder.refusal(id));
              logger.warn({ provider: id, next: chain[0] || null }, 'enrichment: provider refused its key; trying the next');
            }
            continue;
          }
          if (result) await toCache(query, result, tenantId, id);
          return result;
        }
        throw new Error(`no enrichment provider accepted its key: ${providerOrder.explain(refusedNow)}`);
      })());
    }
    return inFlight.get(query);
  };

  await inPool(lookups, config.enrich.concurrency, async ({ item, query }) => {
    try {
      const result = await lookupOnce(query, item);
      // Each line owns its own copy: the views and the profile stage treat
      // item.enrichment as the line's, not as a shared object.
      item.enrichment = result ? { ...result } : result;
      if (result) stats.enriched += 1;
      else stats.skipped += 1;
    } catch (err) {
      logger.warn({ err: err.message, query, provider: chain[0] || null }, 'enrichment lookup failed');
      item.enrichment = { query, error: err.message };
      stats.errors += 1;
    }
  });
  return stats;
}

/** Run fn over every entry, at most `limit` at a time. */
async function inPool(entries, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < entries.length) await fn(entries[next++]);
  };
  const n = Math.max(1, Math.min(limit || 1, entries.length));
  await Promise.all(Array.from({ length: n }, worker));
}

module.exports = { enrichItems, fromRetailer, cacheKey };
