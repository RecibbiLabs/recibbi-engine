'use strict';

// "Resolve products for a receipt's profile result" service. Input is a receipt
// PROFILE RESULT (the cleaned line items), identified by receiptId + profileId;
// resolution only ever runs AFTER a receipt profile has been applied. Picks the
// resolver named by config.products.resolver, runs it over each line item, and
// (unless dryRun) persists a product result. Pure-ish JS, no Express/Redis dep —
// reused by both the sync route and the BullMQ worker. Mirrors
// receiptProfiles/applyService.js + the graceful degradation in enrich/index.js.

const config = require('../config');
const store = require('../store');
const profileStore = require('../receiptProfiles/profileStore');
const resultStore = require('../receiptProfiles/resultStore');
const identity = require('../identity');
const registry = require('./registry');
const productStore = require('./productStore');
const productCache = require('./productCache');
const productEvents = require('./productEvents');
const catalogue = require('../catalogue');
const providerOrder = require('../settings/providerOrder');
const logger = require('../logger');

// Run `fn` over `arr` with at most `limit` calls in flight at once, preserving
// nothing about order (each fn writes its own slot). Used to resolve a receipt's
// line items in a bounded parallel pool instead of strictly one-at-a-time —
// every lookup is an independent, network-bound backend call.
async function mapWithConcurrency(arr, limit, fn) {
  const width = Math.min(Math.max(1, limit | 0), arr.length);
  let next = 0;
  async function worker() {
    while (next < arr.length) {
      const i = next++;
      await fn(arr[i]);
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
}

// The shape pushed for an item that wasn't resolved (skipped, disabled, capped,
// or errored). `error` is the only field that ever varies.
function nullProduct(lineItem, error = null) {
  return { lineItem, productTitle: null, productDescription: null, productUrl: null, brand: null, category: null, emoji: null, confidence: null, error };
}

// Error with an HTTP-ish status so the sync route can map it; the worker lets it
// propagate (job fails/retries).
class ResolveError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ResolveError';
    this.status = status;
  }
}

// The subset of a profile-result item we keep on each product (the source line).
function lineItemOf(it) {
  return {
    description: it.description ?? null,
    sku: it.sku ?? null,
    qty: it.qty ?? null,
    unitPrice: it.unitPrice ?? null,
    price: it.price ?? null,
  };
}

/**
 * Resolve products for a receipt's profile result.
 * @param {string} receiptId
 * @param {string} profileId  receipt-profile id or name
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<object>} the product result document
 * @throws {ResolveError} 404 (unknown receipt/profile) | 409 (profile not applied) | 422 (no resolver)
 */
async function resolveProductsForProfileResult(receiptId, profileId, { dryRun = false } = {}) {
  const record = await store.get(receiptId);
  if (!record) throw new ResolveError(404, 'receipt not found');

  // Profiles are tenant-scoped; resolve within the receipt's tenant.
  const { tenantId } = identity.scopeOf(record.id);
  const profile = await profileStore.get(profileId, { tenantId });
  if (!profile) throw new ResolveError(404, 'profile not found');

  const profileResult = await resultStore.get(record.id, profile.id);
  if (!profileResult) {
    throw new ResolveError(409, `profile "${profile.name}" has not been applied to this receipt yet`);
  }

  // WHO NAMES THE PRODUCTS: the PRODUCT_RESOLVER order (or the one saved in
  // Settings), walked now -- the usable resolvers, first first. A list naming
  // no resolver this engine ships is a 422, as a single unknown name always
  // was; a list whose resolvers all lack a working key is the disabled path
  // below, which skips every line and says why.
  //
  // Usable is the resolver module's own answer -- ready(config), which is
  // whether its key is there -- and not refused: the provider has not turned
  // down exactly that key (providerOrder.refused()).
  const pick = providerOrder.pick('products');
  const known = pick.order.map((id) => registry.get(id)).filter(Boolean);
  if (!known.length) {
    throw new ResolveError(422, `product resolver "${pick.order.join(',')}" is not available`);
  }
  const chain = [];
  const blocked = [];
  for (const r of known) {
    if (chain.includes(r)) continue;
    if (!r.ready(config)) blocked.push({ id: r.id, why: 'no key' });
    else if (providerOrder.refused(r.id)) blocked.push({ id: r.id, why: 'refused' });
    else chain.push(r);
  }
  let resolver = chain[0] || known[0];

  const items = Array.isArray(profileResult.items) ? profileResult.items : [];
  const ctx = {
    storeName: profileResult.store ? profileResult.store.name : null,
    storeDate: profileResult.store ? profileResult.store.date : null,
    config,
    log: (msg, extra) => logger.info({ ...extra, receiptId: record.id, profile: profile.name }, msg),
  };

  // `cached` is a sub-count of `resolved`: how many got their product fields
  // from the shared cache rather than a fresh backend call. resolved+skipped+
  // errors still equals the item count, so existing consumers are unaffected.
  const stats = { resolved: 0, skipped: 0, cached: 0, errors: 0 };

  const enabled = config.products.enabled && chain.length > 0;
  if (!enabled) {
    logger.info(
      {
        receiptId: record.id,
        order: pick.order,
        enabled: config.products.enabled,
        why: chain.length ? null : providerOrder.explain(blocked),
      },
      'product resolution disabled or no resolver has a working key; skipping'
    );
  }

  // Each resolver with a model keeps its settings under config.products.<id>.
  const modelOf = (r) => (config.products[r.id] && config.products[r.id].model) || null;
  const storeName = profileResult.store ? profileResult.store.name : null;
  // Emit one monitor event per lookup (best-effort; see productEvents). The
  // `dryRun` flag rides along so the console can distinguish probe runs.
  const emit = (lineItem, key, outcome, latencyMs, extra, r = resolver) =>
    productEvents.record({
      receiptId: record.id,
      profileId: profile.id,
      resolver: r.id,
      model: modelOf(r),
      store: storeName,
      sku: lineItem.sku || null,
      description: lineItem.description || null,
      outcome, // 'hit' | 'miss' | 'empty' | 'error'
      latencyMs,
      cacheKey: key,
      dryRun: !!dryRun,
      ...extra,
    });

  // One slot per item, filled by index so the parallel pool preserves order.
  const slots = items.map((it, idx) => ({ idx, lineItem: lineItemOf(it) }));
  // When enabled, resolve the first maxItems items and skip the overflow; when
  // disabled, skip everything. (maxItems is a by-position cap, as before.)
  const toResolve = enabled ? slots.slice(0, config.products.maxItems) : [];
  const toSkip = enabled ? slots.slice(config.products.maxItems) : slots;

  const products = new Array(slots.length);
  for (const slot of toSkip) {
    products[slot.idx] = nullProduct(slot.lineItem);
    stats.skipped += 1;
  }

  // Resolve eligible items in a bounded parallel pool, each fronted by the
  // shared per-SKU cache. A cache hit skips the backend call; only successful
  // (non-null) fields are cached, mirroring enrich.
  // ONE CHAIN FOR THE RECEIPT: a resolver that refuses its key on one line is
  // dropped for every line after it, and that line is asked of the next one.
  async function resolveOne(lineItem) {
    for (;;) {
      const r = chain[0];
      if (!r) throw new Error(`no resolver accepted its key: ${providerOrder.explain(blocked)}`);
      const key = productCache.keyFor(r.id, lineItem, ctx);
      const t0 = Date.now();
      const hit = await productCache.get(key);
      if (hit) return { r, key, fields: hit, cached: true, latencyMs: Date.now() - t0 };
      try {
        const fields = await r.resolve(lineItem, ctx);
        return { r, key, fields, cached: false, latencyMs: Date.now() - t0 };
      } catch (err) {
        if (!providerOrder.refused(r.id)) throw Object.assign(err, { resolverId: r.id, cacheKey: key });
        if (chain[0] === r) {
          chain.shift();
          blocked.push(providerOrder.refusal(r.id));
          logger.warn({ receiptId: record.id, resolver: r.id, next: chain[0] ? chain[0].id : null }, 'product resolver refused its key; trying the next');
        }
      }
    }
  }

  await mapWithConcurrency(toResolve, config.products.concurrency, async (slot) => {
    const { idx, lineItem } = slot;
    try {
      const { r, key, fields, cached, latencyMs } = await resolveOne(lineItem);
      resolver = r;
      if (cached) {
        products[idx] = { lineItem, ...fields, error: null };
        stats.resolved += 1;
        stats.cached += 1;
        await emit(lineItem, key, 'hit', latencyMs, {
          productTitle: fields.productTitle || null,
          confidence: fields.confidence ?? null,
        }, r);
        return;
      }
      if (fields) {
        await productCache.set(key, fields);
        products[idx] = { lineItem, ...fields, error: null };
        stats.resolved += 1;
        await emit(lineItem, key, 'miss', latencyMs, {
          productTitle: fields.productTitle || null,
          confidence: fields.confidence ?? null,
        }, r);
      } else {
        products[idx] = nullProduct(lineItem);
        stats.skipped += 1;
        await emit(lineItem, key, 'empty', latencyMs, {}, r);
      }
    } catch (err) {
      logger.warn({ err: err.message, description: lineItem.description }, 'product resolution failed for item');
      products[idx] = nullProduct(lineItem, err.message);
      stats.errors += 1;
      const r = registry.get(err.resolverId) || resolver;
      await emit(lineItem, err.cacheKey || productCache.keyFor(r.id, lineItem, ctx), 'error', null, { error: err.message }, r);
    }
  });

  const result = {
    receiptId: record.id,
    receiptProfileId: profile.id,
    receiptProfileName: profile.name,
    resolver: resolver.id,
    model: modelOf(resolver),
    resolvedAt: new Date().toISOString(),
    dryRun: !!dryRun,
    store: profileResult.store || { name: null, date: null },
    products,
    stats,
  };

  if (!dryRun) {
    await productStore.save(result);
    // The resolver's brand, category and confidence reach the Products screen
    // through the catalogue, so the receipt's purchase rows are re-derived now
    // that there is something new to derive them from. Best-effort, like the
    // pipeline's own indexing.
    await catalogue.reindex(record.id);
    logger.info(
      { receiptId: record.id, receiptProfileId: profile.id, resolver: resolver.id, ...stats },
      'products resolved'
    );
  }
  return result;
}

module.exports = { resolveProductsForProfileResult, ResolveError };
