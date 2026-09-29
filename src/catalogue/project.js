'use strict';

// The product catalogue's PROJECTION: a done receipt in, one purchase row per
// product on it out. Pure -- no persistence, no Redis, no clock except the
// `indexedAt` a caller stamps -- so the same function feeds the incremental
// index at ingest, the one-off backfill, and the verifier that compares the two.
//
// WHAT A PRODUCT IS. The design atlas settled it and this file does not
// re-decide it (../recibbi-ux-design-atlas/assets/js/pages/products.js ->
// catalogue(), storeKey(); assets/js/recibbi.js -> productKey(), mergeBasket()):
//
//   a product is a STORE and a productKey() -- the SKU where the line has one,
//   the register's own string where it does not.
//
// The store is half of it because a SKU is a retailer's number and not a
// product's: 30669 at Costco and 30669 at Sam's Club share a till code by
// accident. Merging across stores is what a member's TAG is for, not a key.
//
// WHY THE ENGINE KEEPS A COPY OF A RULE THE ATLAS OWNS. The atlas's Products
// screen was drawn as "a query over the books, not a product table": merge
// every done receipt into products on every request. That is honest and it is
// O(receipts x lines) per page -- 1,473 lines re-merged to draw 24 cards, and
// every filter tick doing it again. So the engine now PERSISTS the merge, one
// row per (product, receipt), written when a receipt finishes. The rule has to
// be the atlas's rule exactly, or the card a member sees and the receipt it
// links to disagree about what the product is; test/catalogue-project.test.js
// pins it against the atlas's own examples, and a change here goes there first.
//
// THE ROWS ARE A PROJECTION, NOT A SOURCE OF TRUTH. A product's name still
// lives on the receipt lines (item.enrichment). Every row below can be deleted
// and rebuilt from the receipts, and scripts/catalogue.js does exactly that --
// which is also how the verifier knows what "correct" is.

const crypto = require('crypto');
const { receiptDay } = require('../store');

/** Bumped when the row shape changes, so the verifier can say "stale" rather than "wrong". */
const ROW_VERSION = 2; // 2: enrichment.categoryBy

/* The retailers the atlas's catalogue knows, by id and printed name
   (../recibbi-ux-design-atlas/assets/js/catalogue.js -> RETAILERS). Only the two
   columns storeMark() reads to pick a store's identity; the logos and the copy
   stay where they are drawn. A retailer added there is added here, or a
   photographed receipt from it keys by its printed name and its products split
   in two the day its logo starts matching. */
const RETAILERS = [
  ['costco', 'Costco'],
  ['samsclub', "Sam's Club"],
  ['walmart', 'Walmart'],
  ['target', 'Target'],
  ['kroger', 'Kroger'],
  ['publix', 'Publix'],
  ['wholefoods', 'Whole Foods'],
  ['traderjoes', 'Trader Joe’s'],
  ['aldi', 'Aldi'],
  ['instacart', 'Instacart'],
  ['amazon', 'Amazon'],
  ['bjs', "BJ's Wholesale"],
];

/* Case, spaces and punctuation out -- the atlas's normalizeStore(). A register
   prints "TRADER JOE'S" with a straight apostrophe and the table has a curly
   one; neither spelling may decide which product a line belongs to. */
function normalizeStore(s) {
  return s ? String(s).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/**
 * The store half of a product's identity.
 *
 * A retailer this product integrates with keys by its id, so "COSTCO WHOLESALE
 * #1024" and "Costco Wholesale" are one store. `record.retailer` wins over the
 * printed name, because only a synced receipt carries it and it is exact.
 * Anything else keys by its printed name with the punctuation out -- the
 * atlas's storeKey() over storeMark(), matched on a PREFIX for its reason: a
 * substring match would let a short retailer name collide with the middle of
 * somebody else's.
 */
function storeKey(record) {
  if (record && record.retailer) {
    const id = String(record.retailer).replace(/\..*$/, '');
    if (RETAILERS.some(([rid]) => rid === id)) return id;
  }
  const name = normalizeStore(record && record.store && record.store.name);
  if (name) {
    for (const [id, printed] of RETAILERS) {
      if (name.indexOf(normalizeStore(printed)) === 0) return id;
    }
  }
  return name;
}

/**
 * The line half: the SKU where there is one, the register's string where not.
 * Prefixed so the two key spaces cannot collide. The atlas's productKey(),
 * byte for byte -- including the raw, un-normalized description, because that
 * is what the receipt page keys its own lines by, and a save addressed from
 * this screen has to find the same lines there.
 */
function productKey(item) {
  return item && item.sku ? 'sku:' + item.sku : 'raw:' + String((item && item.description) || '');
}

function productKeyOf(record, item) {
  return storeKey(record) + '|' + productKey(item);
}

/**
 * A product's id: a hash of its key. The key is a store and a register string
 * -- spaces, slashes, anything a till prints -- and it has to travel in a URL
 * path and sit in a storage key whose segments are [A-Za-z0-9_-]. A hash is
 * both, and it is the same from an empty database: nothing has to be looked up
 * to address a product, which is what lets the backfill and the incremental
 * index agree on ids without talking to each other.
 */
function productId(key) {
  return 'p' + crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 24);
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cents(n) {
  return Math.round(n * 100) / 100;
}

/**
 * The resolver's answer for one line, if a product resolution ran on this
 * receipt. The resolver reads the PROFILE RESULT's lines, which a transformer
 * may have cleaned, so the match is by SKU first and by description second,
 * and a line with neither match simply has no resolver fields.
 */
function resolvedFor(item, resolved) {
  if (!resolved) return null;
  const sku = item && item.sku ? String(item.sku).trim().toLowerCase() : '';
  const desc = item && item.description ? String(item.description).trim().toLowerCase() : '';
  return (sku && resolved.bySku.get(sku)) || (desc && resolved.byDescription.get(desc)) || null;
}

/**
 * Index a receipt's product results (newest first) by SKU and description.
 * Only a product that was actually identified counts -- an all-null row is the
 * resolver saying it does not know, and folding it in would say nothing.
 */
function resolvedIndex(productResults) {
  const bySku = new Map();
  const byDescription = new Map();
  for (const result of productResults || []) {
    for (const p of (result && result.products) || []) {
      if (!p || !p.productTitle) continue;
      const li = p.lineItem || {};
      const sku = li.sku ? String(li.sku).trim().toLowerCase() : '';
      const desc = li.description ? String(li.description).trim().toLowerCase() : '';
      if (sku && !bySku.has(sku)) bySku.set(sku, p);
      if (desc && !byDescription.has(desc)) byDescription.set(desc, p);
    }
  }
  return bySku.size || byDescription.size ? { bySku, byDescription } : null;
}

/**
 * What the Products screen reads off a line's `enrichment`, in the shape the
 * atlas's builders read it: title, brand, category, confidence, named,
 * needsReview, reviewNote, tag, emoji, imageUrl, page -- and categoryBy.
 *
 * THREE SOURCES, AND THE MEMBER'S IS NOT MIXED WITH ANYBODY ELSE'S. A line the
 * member named (`named: 'member'`) says exactly what they said: a brand they
 * cleared is cleared, not refilled from a resolver, and it has no confidence,
 * because a confidence describes a guess. Otherwise the pipeline's enrichment
 * (a web search or the retailer's own page) comes first and the product
 * resolver fills what it left empty.
 *
 * `page` IS THE ATLAS'S NAME FOR WHAT THE ENRICHMENT CALLS `url`. Both mean the
 * product's own page; the rename happens here, once, so no view has to know two
 * spellings.
 *
 * NULL WHEN THERE IS NOTHING TO SAY. `(item.enrichment || {})` is how every
 * builder reads it, so an absent object and an empty one draw the same card,
 * and a thousand rows of nulls are a thousand rows of nothing.
 */
function enrichmentView(item, resolved) {
  const raw = item && item.enrichment;
  const e = raw && typeof raw === 'object' ? raw : {};
  const r = resolved || {};
  const member = e.named === 'member';
  const pick = (own, theirs) => (own !== undefined && own !== null && own !== '' ? own : member ? null : theirs);

  const view = {
    title: str(e.title) || (member ? null : str(r.productTitle)),
    brand: str(pick(e.brand, r.brand)),
    category: str(pick(e.category, r.category)),
    confidence: member ? null : num(e.confidence) !== null ? num(e.confidence) : num(r.confidence),
    named: member ? 'member' : null,
    needsReview: e.needsReview === true,
    reviewNote: str(e.reviewNote),
    tag: str(e.tag),
    emoji: str(e.emoji) || (member ? null : str(r.emoji)),
    imageUrl: str(e.imageUrl),
    page: str(e.page) || str(e.url) || (member ? null : str(r.productUrl)),
    source: str(e.source),
    // Who gave the category when src/catalogue/categorize.js did: 'recibbi'
    // or 'model'. Null for the member's, the enrichment's and the resolver's.
    categoryBy: member || !str(e.category) ? null : str(e.categoryBy),
  };
  const said = view.title || view.brand || view.category || view.confidence !== null || view.named ||
    view.needsReview || view.tag || view.emoji || view.imageUrl || view.page;
  return said ? view : null;
}

/** One line, as a purchase row keeps it: what the till said and what we made of it. */
function lineOf(item, resolved) {
  return {
    description: str(item.description),
    sku: item.sku === undefined || item.sku === null || item.sku === '' ? null : String(item.sku),
    qty: num(item.qty),
    unitPrice: num(item.unitPrice),
    price: num(item.price),
    imageUrl: str(item.imageUrl),
    enrichment: enrichmentView(item, resolvedFor(item, resolved)),
  };
}

/**
 * A done receipt -> its purchase rows, one per product on it, in register order.
 *
 * The atlas's mergeBasket(), per receipt: lines with the same productKey() are
 * one product, `qty` sums (a line with no quantity is one of something), and
 * `spent` sums the lines that HAVE a price -- a line with none adds nothing
 * rather than a zero it does not mean. `lines` keeps every line, because the
 * member checks "x2 . $33.98" against a ticket with two lines on it.
 *
 * A receipt that is not `done`, or has no lines, has no purchases. The books
 * open on done receipts and so does this: a receipt still being read has items
 * nobody should be counting yet.
 *
 * @param {object} record          a receipt record
 * @param {object} [opts]
 * @param {object} [opts.resolved] resolvedIndex() of the receipt's product results
 * @returns {object[]} purchase rows
 */
function purchases(record, { resolved = null } = {}) {
  if (!record || record.status !== 'done' || !Array.isArray(record.items) || !record.items.length) return [];
  const sk = storeKey(record);
  const out = [];
  const byKey = new Map();
  for (const item of record.items) {
    if (!item || typeof item !== 'object') continue;
    const line = productKey(item);
    let row = byKey.get(line);
    if (!row) {
      const key = sk + '|' + line;
      row = {
        v: ROW_VERSION,
        productId: productId(key),
        key,
        line,
        storeKey: sk,
        receiptId: record.id,
        retailer: str(record.retailer),
        storeName: str(record.store && record.store.name),
        day: receiptDay(record) || '',
        createdAt: str(record.createdAt) || '',
        qty: 0,
        spent: 0,
        lines: [],
      };
      byKey.set(line, row);
      out.push(row);
    }
    const q = num(item.qty);
    row.qty = cents(row.qty + (q === null ? 1 : q));
    const p = num(item.price);
    if (p !== null) row.spent = cents(row.spent + p);
    row.lines.push(lineOf(item, resolved));
  }
  return out;
}

/* ------------------------------------------------------------------ reading */

/** Newest first; a purchase nobody could date goes last. Then the engine's own recency rule. */
function byNewest(a, b) {
  if (!a.day !== !b.day) return a.day ? -1 : 1;
  if (a.day !== b.day) return a.day < b.day ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.receiptId === b.receiptId) return 0;
  return a.receiptId < b.receiptId ? 1 : -1;
}

/**
 * Purchase rows -> products, the shape the atlas's catalogue() hands its
 * builders, so ux-main draws an engine answer with the atlas's own tile:
 *
 *   id      productId(key) -- what a URL names
 *   key     store + productKey()
 *   line    productKey() alone -- what a receipt's own lines are keyed by
 *   store   the newest receipt's printed store name
 *   item    THE LINE THE CARD IS DRAWN FROM. The newest purchase's, unless a
 *           line on any purchase is flagged for review -- then that one, because
 *           a card that went quiet about a question still being asked on one of
 *           its receipts would be the screen hiding it.
 *   buys    one per receipt, newest first: { record, day, item, qty, spent, lines }
 *           `record` carries only what a card and the dialog read -- id, store
 *           name, retailer -- and never the rest of the receipt.
 *   times   how many receipts, which is not how many were bought -- `qty`
 *   spent   across every receipt
 *   last    the newest receipt's day, or ''
 */
function assemble(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row || !row.productId) continue;
    let g = groups.get(row.productId);
    if (!g) groups.set(row.productId, (g = []));
    g.push(row);
  }
  const out = [];
  for (const [id, group] of groups) {
    group.sort(byNewest);
    const buys = group.map((r) => ({
      record: { id: r.receiptId, store: { name: r.storeName }, retailer: r.retailer },
      day: r.day,
      item: r.lines[0],
      qty: r.qty,
      spent: r.spent,
      lines: r.lines,
    }));
    let flagged = null;
    for (const b of buys) {
      for (const l of b.lines) {
        if (!flagged && l.enrichment && l.enrichment.needsReview === true) flagged = l;
      }
    }
    out.push({
      id,
      key: group[0].key,
      line: group[0].line,
      store: group[0].storeName,
      item: flagged || buys[0].item,
      buys,
      times: buys.length,
      qty: cents(group.reduce((a, r) => a + r.qty, 0)),
      spent: cents(group.reduce((a, r) => a + r.spent, 0)),
      last: group[0].day || '',
    });
  }
  return out;
}

module.exports = {
  ROW_VERSION,
  RETAILERS,
  normalizeStore,
  storeKey,
  productKey,
  productKeyOf,
  productId,
  resolvedIndex,
  resolvedFor,
  enrichmentView,
  purchases,
  assemble,
};
