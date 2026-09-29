'use strict';

// The product catalogue: persisted, per member, maintained as receipts finish.
//
// THREE DOCUMENT KINDS, and the split is what keeps it correct without a lock
// that spans processes (see docs/CATALOGUE.md for the long version):
//
//   purchases      { tenant, user, id: productId, sub: receiptCacheId }
//                  ONE ROW PER PRODUCT PER RECEIPT -- that receipt's lines for
//                  that product, merged. Written only by indexing THAT receipt,
//                  so no two receipts ever write the same row, and the worker
//                  finishing two receipts with the same eggs on them at once is
//                  two independent writes rather than a read-modify-write race
//                  on one "eggs" document.
//   purchaseIndex  { tenant, user, id: receiptCacheId }
//                  which products a receipt contributed to, so re-indexing it
//                  can delete the rows it no longer produces. Also one writer.
//   catalogue      { tenant, user, id: productId }
//                  what the MEMBER said about a product -- the name they gave
//                  it -- so the next receipt it turns up on is named the same
//                  way. Written only by naming, in the API process.
//
// A PRODUCT ITSELF IS NOT STORED. It is its purchase rows, grouped -- assembled
// at read time by project.assemble(). That costs one indexed list per request
// instead of re-merging every receipt's lines, and it means there is no
// aggregate document for two writers to disagree about.
//
// EVERYTHING HERE IS SCOPED BY (tenant, user), exactly as receipts are, and the
// scope always comes from the caller: a route's identity headers or a receipt's
// own composite id. A product id from somebody else's books names a row that
// does not exist under the asking scope -- a 404 reached structurally, the way
// src/routes/settings.js serves a profile photograph.

const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const identity = require('../identity');
const persistence = require('../persistence');
const store = require('../store');
const productStore = require('../products/productStore');
const { withLock } = require('../settings/lock');
const project = require('./project');
const categorize = require('./categorize');
const query = require('./query');

const KIND = { purchase: 'purchases', receipt: 'purchaseIndex', product: 'catalogue' };

/** A refused catalogue operation, carrying the status a route should answer. */
class CatalogueError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CatalogueError';
    this.status = status;
  }
}

function scopeFrom(scope) {
  if (!scope || !identity.isValidSegment(scope.tenantId) || !identity.isValidSegment(scope.userId)) {
    throw new CatalogueError(400, 'a valid tenant and user are required');
  }
  return { tenant: scope.tenantId, user: scope.userId };
}

function isProductId(id) {
  return typeof id === 'string' && /^p[0-9a-f]{24}$/.test(id);
}

/* ---------------------------------------------------------------- indexing */

/** The receipt's product-resolution results, newest first, or null. Never throws. */
async function resolvedOf(receiptId) {
  try {
    return project.resolvedIndex(await productStore.list(receiptId));
  } catch {
    return null;
  }
}

/**
 * The rows a receipt SHOULD have, by the projection.
 *
 * NONE WHILE IT IS IN THE TRASH. A deleted receipt is out of the books, so its
 * products are out of the catalogue: indexing it on the way in removes its
 * rows, indexing it on the way back out of the trash files them again, and
 * verify() agrees with both because it asks this same function.
 */
async function expectedRows(record) {
  if (!record || record.status !== 'done' || store.inTrash(record)) return [];
  return project.purchases(record, { resolved: await resolvedOf(record.id) });
}

/**
 * Bring one receipt's purchase rows in line with the receipt.
 *
 * Idempotent: indexing the same receipt twice writes the same rows. A receipt
 * that is no longer `done`, or whose lines changed, loses the rows it no longer
 * produces -- which is why the per-receipt index exists.
 *
 * @returns {{ receiptId, products, removed }}
 */
async function indexReceipt(record) {
  if (!record || !record.id) return { receiptId: null, products: 0, removed: 0 };
  const { tenantId, userId, cacheId } = identity.resolveId(record.id);
  const s = { tenant: tenantId, user: userId };
  const rows = await expectedRows(record);
  const indexedAt = new Date().toISOString();

  const previous = await persistence.get({ kind: KIND.receipt, ...s, id: cacheId });
  const keep = new Set(rows.map((r) => r.productId));

  for (const row of rows) {
    await persistence.put({ kind: KIND.purchase, ...s, id: row.productId, sub: cacheId }, { ...row, indexedAt });
  }
  let removed = 0;
  for (const pid of (previous && previous.productIds) || []) {
    if (keep.has(pid)) continue;
    if (await persistence.delete({ kind: KIND.purchase, ...s, id: pid, sub: cacheId })) removed += 1;
  }
  if (rows.length) {
    await persistence.put(
      { kind: KIND.receipt, ...s, id: cacheId },
      { receiptId: record.id, productIds: [...keep], indexedAt, v: project.ROW_VERSION }
    );
  } else if (previous) {
    await persistence.delete({ kind: KIND.receipt, ...s, id: cacheId });
  }
  return { receiptId: record.id, products: rows.length, removed };
}

/**
 * indexReceipt(), for callers whose own work must not fail because of it: the
 * pipeline (a receipt that read perfectly is not failed because its products
 * could not be filed) and the resolver. A miss here is DRIFT, not loss -- the
 * receipt is intact and `scripts/catalogue.js verify` names it -- so it is
 * logged loudly and swallowed.
 */
async function indexReceiptSafely(record) {
  try {
    return await indexReceipt(record);
  } catch (err) {
    logger.error({ err: err.message, receiptId: record && record.id }, 'catalogue: receipt not indexed; run scripts/catalogue.js verify');
    return null;
  }
}

/** Re-read a receipt by id and index it. Best-effort. */
async function reindex(receiptId) {
  try {
    return await indexReceiptSafely(await store.get(receiptId));
  } catch (err) {
    logger.error({ err: err.message, receiptId }, 'catalogue: receipt not re-indexed');
    return null;
  }
}

/* ----------------------------------------------------------------- reading */

async function rowsOf(scope) {
  const s = scopeFrom(scope);
  try {
    return await persistence.list({ kind: KIND.purchase, ...s });
  } catch {
    return [];
  }
}

/** Every product in a member's books, assembled from their purchase rows. */
async function products(scope) {
  return project.assemble(await rowsOf(scope));
}

/** One product, or null -- including when the id is somebody else's. */
async function get(scope, productId) {
  const s = scopeFrom(scope);
  if (!isProductId(productId)) return null;
  let rows;
  try {
    rows = await persistence.list({ kind: KIND.purchase, ...s, id: productId });
  } catch {
    return null;
  }
  const [prod] = project.assemble(rows);
  return prod || null;
}

/**
 * A page of the catalogue: filters and order applied over the books, then the
 * slice. See query.page() for the envelope.
 */
async function page(scope, { filters, sort, limit = 24, offset = 0 } = {}) {
  const all = await products(scope);
  return query.page(all, filters || query.empty(), sort, { limit, offset });
}

/* ------------------------------------------------------ what the member said */

const NAME_FIELDS = ['title', 'brand', 'category'];
const MAX_FIELD = 200;

/**
 * A naming patch, checked. Each field is absent (leave it), null or blank
 * (clear it), or a string. Anything else is a 400 rather than a coercion: a
 * number where a name goes is a caller bug, and storing "[object Object]" as a
 * member's product name is a worse outcome than refusing it.
 */
function cleanPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new CatalogueError(400, 'the body must be an object of title, brand and category');
  }
  const out = {};
  for (const k of NAME_FIELDS) {
    if (!(k in patch) || patch[k] === undefined) continue;
    const v = patch[k];
    if (v === null) out[k] = null;
    else if (typeof v === 'string') out[k] = v.trim().slice(0, MAX_FIELD) || null;
    else throw new CatalogueError(400, `"${k}" must be a string or null`);
  }
  if (!Object.keys(out).length) throw new CatalogueError(400, 'nothing to save: send title, brand or category');
  return out;
}

/**
 * Write a member's answer onto one line. SETS `named: 'member'` AND CLEARS
 * `confidence`, because a confidence describes a guess and nobody is using the
 * guess any more; the two move together or a view prints a resolver's number
 * over a member's answer. The review flag comes off too: the member has just
 * answered the question it was asking. (The atlas's stub-api.js nameProduct(),
 * which is the contract.)
 */
function stamp(item, patch, at) {
  const e = item.enrichment && typeof item.enrichment === 'object' ? { ...item.enrichment } : {};
  for (const k of NAME_FIELDS) if (k in patch) e[k] = patch[k];
  e.named = 'member';
  e.confidence = null;
  e.namedAt = at;
  delete e.needsReview;
  delete e.reviewNote;
  item.enrichment = e;
}

/**
 * Name a product: every line of it, on every receipt it was on, and remember
 * the answer for the receipts it turns up on next.
 *
 * ALL OR NOTHING, as far as two document writes can be. One product, one name
 * -- saving it on some of its receipts would leave the card and the others
 * disagreeing about what the thing is. The receipts are written one after
 * another and, if one write fails, the ones already written are put back.
 * Neither backend offers a transaction across documents through the
 * persistence interface; this is the compensating version, and the refusal it
 * answers says nothing changed because nothing did.
 *
 * Serialized per product within this process. The worker never names; it only
 * re-indexes, and a re-index racing a name is a projection of one of the two
 * states of the receipt -- which `verify` would name and `backfill` would fix.
 */
async function nameProduct(scope, productId, patch) {
  const s = scopeFrom(scope);
  const clean = cleanPatch(patch);
  return withLock(`catalogue:${s.tenant}:${s.user}:${productId}`, async () => {
    const prod = await get(scope, productId);
    if (!prod) throw new CatalogueError(404, 'not found');

    const at = new Date().toISOString();
    const receiptIds = [...new Set(prod.buys.map((b) => b.record.id))];
    const written = [];
    try {
      for (const id of receiptIds) {
        const record = await store.get(id);
        if (!record) continue;
        // The rows said this receipt is in the asking scope; the record's own
        // id is what proves it. A row pointing elsewhere is corruption, and a
        // write through it would be a write into somebody else's books.
        const owner = identity.scopeOf(record.id);
        if (owner.tenantId !== s.tenant || owner.userId !== s.user) continue;
        const before = JSON.parse(JSON.stringify(record));
        let touched = 0;
        for (const item of record.items || []) {
          if (item && typeof item === 'object' && project.productKey(item) === prod.line) {
            stamp(item, clean, at);
            touched += 1;
          }
        }
        if (!touched) continue;
        await store.save(record);
        written.push(before);
      }
    } catch (err) {
      logger.error({ err: err.message, productId, written: written.length }, 'catalogue: naming failed; restoring');
      for (const original of written.reverse()) {
        try {
          await store.save(original);
        } catch (e) {
          logger.error({ err: e.message, receiptId: original.id }, 'catalogue: could not restore a receipt after a failed name');
        }
      }
      throw new CatalogueError(502, 'That name could not be saved. The line still says what it said.');
    }

    await persistence.put(
      { kind: KIND.product, ...s, id: productId },
      { id: productId, key: prod.key, line: prod.line, naming: clean, namedAt: at }
    );
    for (const id of receiptIds) await reindex(id);
    return get(scope, productId);
  });
}

/**
 * A NAME THE MEMBER GAVE A PRODUCT IS THE NAME THE NEXT PURCHASE GETS.
 *
 * Run by the pipeline on a receipt that has just been read, before it is
 * marked done: a line whose product the member has named is stamped with that
 * name, exactly as naming it would have stamped it. Without this the member
 * names "SWISS" once and meets it again, unnamed, on every receipt after.
 *
 * A line the member already named on this receipt keeps its own answer.
 * Returns how many lines were named. Never throws: a receipt is not held back
 * because the catalogue could not be read.
 */
async function applyRememberedNames(record) {
  try {
    if (!record || !Array.isArray(record.items) || !record.items.length) return 0;
    const { tenantId, userId } = identity.scopeOf(record.id);
    const docs = await persistence.list({ kind: KIND.product, tenant: tenantId, user: userId });
    const named = new Map(docs.filter((d) => d && d.naming).map((d) => [d.key, d]));
    if (!named.size) return 0;
    let n = 0;
    for (const item of record.items) {
      if (!item || typeof item !== 'object') continue;
      const doc = named.get(project.productKeyOf(record, item));
      if (!doc) continue;
      if (item.enrichment && item.enrichment.named === 'member') continue;
      stamp(item, doc.naming, doc.namedAt || new Date().toISOString());
      n += 1;
    }
    return n;
  } catch (err) {
    logger.warn({ err: err.message, receiptId: record && record.id }, 'catalogue: remembered names not applied');
    return 0;
  }
}

/* ------------------------------------------------------------ categories */

/**
 * What the member's books already say: product key -> the category its card
 * shows (the `recibbi` source), and the categories the model is offered --
 * the member's and this step's, not a resolver's free text (categorize.teaches).
 */
async function knownCategories(scope) {
  const known = new Map();
  const existing = new Set();
  for (const p of await products(scope)) {
    const view = p.item && p.item.enrichment;
    if (!view || !view.category) continue;
    known.set(p.key, view.category);
    if (categorize.teaches(view)) existing.add(view.category);
  }
  return { known, existing: [...existing].sort() };
}

/**
 * A CATEGORY FOR EVERY LINE OF A RECEIPT BEING READ, in place, before it is
 * done -- so its lines land in the Products screen's category list with the
 * receipt, rather than under no category until somebody runs a job. Run by the
 * pipeline beside applyRememberedNames(), and before it, so a name the member
 * gave the product (category included) is the one that stands.
 *
 * Returns how many lines were given a category. Never throws: a receipt is not
 * held back because a category could not be found. See categorize.js.
 */
async function categorizeReceipt(record, { classify } = {}) {
  try {
    if (!config.products.enabled || !config.products.categorize) return 0;
    if (!record || !Array.isArray(record.items) || !record.items.length) return 0;
    const { known, existing } = await knownCategories(identity.scopeOf(record.id));
    const report = await categorize.categorizeRecords([{ record, resolved: null }], { known, existing, classify });
    return report.lines;
  } catch (err) {
    logger.warn({ err: err.message, receiptId: record && record.id }, 'catalogue: lines not categorized');
    return 0;
  }
}

/**
 * THE ONE-OFF OVER HISTORY: every done receipt in a member's books, every line
 * with no category given one, and the receipts' rows re-derived.
 *
 * One question per product across the whole history, so a few model calls
 * answer hundreds of receipts. The answers are worked out over the receipts as
 * listed and written onto each receipt RE-READ just before it is saved, so a
 * name the member saved while this ran is not put back the way it was.
 * Idempotent: the second run finds nothing to categorize and writes nothing.
 *
 * @param {object} scope
 * @param {{ dryRun?: boolean, redo?: boolean, classify?: Function }} [opts]
 *   redo: ask again about lines this step categorized before (see categorize.needsCategory)
 */
async function categorizeHistory(scope, { dryRun = false, redo = false, classify } = {}) {
  const s = scopeFrom(scope);
  const receipts = (await receiptsOf(scope)).filter((r) => r && r.status === 'done');
  const entries = [];
  for (const record of receipts) entries.push({ record, resolved: await resolvedOf(record.id) });
  const report = await categorize.categorizeRecords(entries, { classify, redo, dryRun: true });

  let written = 0;
  if (!dryRun) {
    const answered = (record, resolved) => (item) =>
      categorize.needsCategory(item, resolved, { redo }) && report.answers.has(project.productKeyOf(record, item));
    const touched = entries.filter(({ record, resolved }) => record.items.some(answered(record, resolved)));
    for (const { record: { id } } of touched) {
      const fresh = await store.get(id);
      if (!fresh || fresh.status !== 'done') continue;
      const resolved = await resolvedOf(id);
      if (!categorize.applyAnswers(fresh, report.answers, resolved, { redo })) continue;
      await store.save(fresh);
      await indexReceiptSafely(fresh);
      written += 1;
    }
  }
  return {
    scope: { tenantId: s.tenant, userId: s.user },
    receipts: receipts.length,
    dryRun: !!dryRun,
    written,
    products: report.products,
    lines: report.lines,
    byRecibbi: report.byRecibbi,
    byModel: report.byModel,
    unanswered: report.unanswered,
    failed: report.failed,
    model: report.model,
    categories: report.categories,
  };
}

/* ------------------------------------------------- backfill and verification */

async function receiptsOf(scope) {
  const s = scopeFrom(scope);
  try {
    return await persistence.list({ kind: 'receipts', ...s });
  } catch {
    return [];
  }
}

function rowKey(productId, receiptId) {
  const { cacheId } = identity.resolveId(receiptId);
  return `${productId}/${cacheId}`;
}

/* What a row is, for comparison: everything but when it was written. */
function comparable(row) {
  const { indexedAt, ...rest } = row || {};
  return JSON.stringify(rest);
}

const SAMPLE = 20;

/**
 * DOES THE STORED CATALOGUE SAY WHAT THE RECEIPTS SAY?
 *
 * Recomputes every row from the receipts, in memory, and compares it with what
 * is stored -- the from-scratch answer against the incremental one. This is the
 * test that incremental indexing at ingest is correct: after any number of
 * receipts have arrived through the pipeline, `ok` must be true. It writes
 * nothing.
 *
 *   missing   a row the receipts imply and the store does not have
 *   extra     a stored row no receipt implies (a receipt that changed, or went)
 *   stale     both have it, and they differ
 *   index     receipts whose per-receipt index is absent or wrong
 */
async function verify(scope) {
  const s = scopeFrom(scope);
  const receipts = await receiptsOf(scope);
  const expected = new Map();
  const byReceipt = new Map();
  let done = 0;
  for (const r of receipts) {
    if (r.status === 'done') done += 1;
    const rows = await expectedRows(r);
    for (const row of rows) expected.set(rowKey(row.productId, row.receiptId), row);
    const { cacheId } = identity.resolveId(r.id);
    byReceipt.set(cacheId, rows.map((row) => row.productId).sort());
  }

  const stored = new Map();
  for (const row of await rowsOf(scope)) stored.set(rowKey(row.productId, row.receiptId), row);

  const missing = [];
  const stale = [];
  const extra = [];
  for (const [k, row] of expected) {
    if (!stored.has(k)) missing.push(k);
    else if (comparable(stored.get(k)) !== comparable(row)) stale.push(k);
  }
  for (const k of stored.keys()) if (!expected.has(k)) extra.push(k);

  const indexWrong = [];
  let indexDocs = [];
  try {
    indexDocs = await persistence.list({ kind: KIND.receipt, ...s });
  } catch {
    indexDocs = [];
  }
  const indexed = new Map(indexDocs.map((d) => [identity.resolveId(d.receiptId).cacheId, d]));
  for (const [cacheId, pids] of byReceipt) {
    const doc = indexed.get(cacheId);
    const have = doc ? [...doc.productIds].sort() : [];
    if (JSON.stringify(have) !== JSON.stringify(pids)) indexWrong.push(cacheId);
    indexed.delete(cacheId);
  }
  for (const cacheId of indexed.keys()) indexWrong.push(cacheId); // an index for no receipt

  const productCount = new Set([...expected.values()].map((r) => r.productId)).size;
  return {
    scope: { tenantId: s.tenant, userId: s.user },
    ok: !missing.length && !stale.length && !extra.length && !indexWrong.length,
    receipts: receipts.length,
    done,
    products: productCount,
    rows: { expected: expected.size, stored: stored.size },
    missing: { count: missing.length, sample: missing.slice(0, SAMPLE) },
    stale: { count: stale.length, sample: stale.slice(0, SAMPLE) },
    extra: { count: extra.length, sample: extra.slice(0, SAMPLE) },
    index: { wrong: indexWrong.length, sample: indexWrong.slice(0, SAMPLE) },
  };
}

/**
 * REBUILD ONE MEMBER'S CATALOGUE FROM THEIR RECEIPTS -- the one-off backfill,
 * and the repair for anything verify() finds.
 *
 * Every receipt is re-indexed (which writes its rows and deletes the ones it no
 * longer implies), and then any row or index entry no receipt accounts for is
 * removed. What the member SAID -- the `catalogue` kind -- is never touched:
 * their names live on the receipt lines already, and the remembered copy is
 * theirs, not the projection's.
 */
async function rebuild(scope) {
  const s = scopeFrom(scope);
  const receipts = await receiptsOf(scope);
  const live = new Set();
  let indexed = 0;
  let rows = 0;
  for (const r of receipts) {
    const res = await indexReceipt(r);
    if (res.products) indexed += 1;
    rows += res.products;
    for (const row of await expectedRows(r)) live.add(rowKey(row.productId, row.receiptId));
  }

  let removed = 0;
  for (const row of await rowsOf(scope)) {
    const k = rowKey(row.productId, row.receiptId);
    if (live.has(k)) continue;
    const { cacheId } = identity.resolveId(row.receiptId);
    if (await persistence.delete({ kind: KIND.purchase, ...s, id: row.productId, sub: cacheId })) removed += 1;
  }
  const known = new Set(receipts.map((r) => identity.resolveId(r.id).cacheId));
  let indexDocs = [];
  try {
    indexDocs = await persistence.list({ kind: KIND.receipt, ...s });
  } catch {
    indexDocs = [];
  }
  for (const d of indexDocs) {
    const { cacheId } = identity.resolveId(d.receiptId);
    if (!known.has(cacheId)) await persistence.delete({ kind: KIND.receipt, ...s, id: cacheId });
  }

  return {
    scope: { tenantId: s.tenant, userId: s.user },
    receipts: receipts.length,
    indexed,
    rows,
    removed,
    products: new Set([...live].map((k) => k.split('/')[0])).size,
  };
}

/**
 * Every (tenant, user) that holds receipts -- for the backfill, which runs over
 * the whole deployment. The sqlite backend can list a kind across scopes; the
 * filesystem one is walked, because its layout IS the scope.
 */
async function scopes() {
  const seen = new Map();
  const add = (tenantId, userId) => {
    if (identity.isValidSegment(tenantId) && identity.isValidSegment(userId)) {
      seen.set(`${tenantId}:${userId}`, { tenantId, userId });
    }
  };
  if (persistence.backendName() === 'sqlite') {
    for (const r of await persistence.list({ kind: 'receipts' })) add(r.tenantId, r.userId);
  } else {
    let tenants = [];
    try {
      tenants = await fs.readdir(config.dataDir, { withFileTypes: true });
    } catch {
      tenants = [];
    }
    for (const t of tenants) {
      if (!t.isDirectory() || !identity.isValidSegment(t.name)) continue;
      let users = [];
      try {
        users = await fs.readdir(path.join(config.dataDir, t.name), { withFileTypes: true });
      } catch {
        users = [];
      }
      for (const u of users) {
        if (!u.isDirectory() || !identity.isValidSegment(u.name)) continue;
        try {
          await fs.access(path.join(config.dataDir, t.name, u.name, 'receipts'));
          add(t.name, u.name);
        } catch {
          /* a directory with no receipts is not a member's books */
        }
      }
    }
  }
  return [...seen.values()];
}

module.exports = {
  KIND,
  CatalogueError,
  isProductId,
  indexReceipt,
  indexReceiptSafely,
  reindex,
  products,
  get,
  page,
  cleanPatch,
  nameProduct,
  applyRememberedNames,
  knownCategories,
  categorizeReceipt,
  categorizeHistory,
  verify,
  rebuild,
  scopes,
};
