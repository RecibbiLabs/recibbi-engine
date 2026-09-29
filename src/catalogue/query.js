'use strict';

// Narrowing the catalogue: the filter predicate, the order, and the facets that
// let ux-main draw the Products screen's panel over products it has not got.
//
// THE CONTRACT IS THE DESIGN ATLAS'S, the way src/receiptQuery.js's is. The
// query-string spelling, the four groups, the range, the eight orders and the
// facet rule are settled in ../recibbi-ux-design-atlas/assets/js/pages/products.js
// (parseFilters, productMatches, facets, SORTS, sortProducts), which ux-main
// ports and ships to the browser. A browser re-drawing a page it was handed and
// this module answering over the books must agree, or a member watches a card
// move when nothing changed. Keep them in step; test/catalogue-query.test.js
// holds the cases both sides have to answer the same way.
//
// THREE RULES WORTH SAYING OUT LOUD, all of them the atlas's:
//
//   A PRODUCT WITH NO VALUE IN A GROUP THAT IS ON IS A MISS. Most products have
//   no tag and many have no category; a filter that let those through would
//   answer "show me my dairy" with everything nobody has categorised.
//
//   A FACET'S COUNTS ARE THE OTHER GROUPS' COUNTS. Counting `store` with the
//   store filter applied to itself makes every unticked box read 0.
//
//   THE RANGE IS APPLIED ONLY AT AN END THAT IS SET. `times_min` alone is "on at
//   least this many receipts", never "between this and whatever the most is
//   today".

/** The checkbox groups. Repeated keys, like a GET form submits. */
const FILTER_KEYS = ['category', 'store', 'named', 'tag'];

/* FOUR WAYS A NAME CAME TO BE, exclusive so the counts add up to the books, in
   the order the panel draws them: "waiting for you" first, because it is the
   one with something to do. */
const NAMED_ORDER = ['review', 'member', 'resolver', 'nobody'];

function empty() {
  return { category: [], store: [], named: [], tag: [], times: { min: null, max: null } };
}

/** A whole number of receipts, at least one, or null -- anything else is no bound. */
function countOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n) || n < 1) return null;
  return Math.floor(n);
}

function listOf(v) {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
}

/** Express's req.query -> filters. Unknown keys are ignored, not refused. */
function parse(query = {}) {
  const f = empty();
  for (const k of FILTER_KEYS) f[k] = listOf(query[k]);
  f.times = { min: countOrNull(query.times_min), max: countOrNull(query.times_max) };
  return f;
}

function timesOn(f) {
  const t = f.times || {};
  return t.min !== null && t.min !== undefined ? true : t.max !== null && t.max !== undefined;
}

/**
 * Who named it. `review` wins over `resolver` because a flagged line IS a
 * resolver's guess -- the one the engine has asked the member about.
 */
function namedAs(item) {
  const e = (item && item.enrichment) || {};
  if (e.needsReview === true) return 'review';
  if (e.named === 'member') return 'member';
  return e.title ? 'resolver' : 'nobody';
}

/** The one value a product has in a filter group, or null. */
function valueOf(prod, group) {
  const e = (prod.item && prod.item.enrichment) || {};
  if (group === 'category') return e.category || null;
  if (group === 'tag') return e.tag || null;
  if (group === 'store') return prod.store;
  if (group === 'named') return namedAs(prod.item);
  return null;
}

/** OR within a group, AND across groups. */
function matches(prod, f) {
  for (const k of FILTER_KEYS) {
    const on = f[k] || [];
    if (on.length && !on.includes(valueOf(prod, k))) return false;
  }
  const t = f.times || {};
  if (t.min !== null && t.min !== undefined && prod.times < t.min) return false;
  if (t.max !== null && t.max !== undefined && prod.times > t.max) return false;
  return true;
}

/**
 * The panel's numbers, over the books. The options are what the books hold;
 * each count is what ticking that box would leave with every OTHER group --
 * and the range -- applied. The bar's ends are the books' too: one receipt at
 * the left, the most any product was bought on at the right.
 */
function facets(products, f) {
  const options = {};
  const counts = {};
  for (const g of FILTER_KEYS) {
    const probe = { ...empty(), times: f.times || { min: null, max: null } };
    for (const k of FILTER_KEYS) probe[k] = k === g ? [] : f[k] || [];
    const seen = new Set();
    const n = {};
    for (const p of products) {
      const v = valueOf(p, g);
      if (v === null || v === undefined) continue;
      seen.add(v);
      if (matches(p, probe)) n[v] = (n[v] || 0) + 1;
    }
    options[g] = g === 'named' ? NAMED_ORDER.filter((v) => seen.has(v)) : [...seen].sort();
    counts[g] = n;
  }
  const most = products.reduce((a, p) => Math.max(a, p.times), 1);
  return { options, counts, bounds: { times: { lo: 1, hi: most } } };
}

/* ------------------------------------------------------------------ the order

   FOUR QUESTIONS, TWO DIRECTIONS EACH. Newest purchase first is the default,
   because the product a member is looking for is most often the one on the
   receipt they just sent. Ordered BEFORE the slice, or "most spent" would be
   the most spent of the first twenty-four. */
const SORTS = ['recent', 'earliest', 'most_often', 'least_often', 'most_spent', 'least_spent', 'name_az', 'name_za'];
const DEFAULT_SORT = 'recent';

function sortOrDefault(v) {
  return typeof v === 'string' && SORTS.includes(v) ? v : DEFAULT_SORT;
}

/** The name a product ended up with -- the atlas's itemTitle(), lower-cased. */
function nameOf(p) {
  const it = p.item || {};
  const e = it.enrichment || {};
  return String(e.title || it.description || 'item').toLowerCase();
}

const ORDERS = {
  recent: { dir: -1, key: (p) => p.last || null },
  earliest: { dir: 1, key: (p) => p.last || null },
  most_often: { dir: -1, key: (p) => p.times },
  least_often: { dir: 1, key: (p) => p.times },
  most_spent: { dir: -1, key: (p) => p.spent },
  least_spent: { dir: 1, key: (p) => p.spent },
  name_az: { dir: 1, key: nameOf },
  name_za: { dir: -1, key: nameOf },
};

/**
 * A copy, in `sort` order. A tie falls back to the name, A-Z, so two products
 * bought on the same day do not swap places between visits; a product with no
 * answer (no day) goes last in both directions. The atlas's sortProducts(), and
 * then one more tie-break it does not need and this side does: the id, because
 * two products CAN share a name (the same till string at two stores), and an
 * order that is not total is an order a page boundary can split differently on
 * two requests.
 */
function sortProducts(products, sort) {
  const by = ORDERS[sortOrDefault(sort)];
  return products.slice().sort((a, b) => {
    const x = by.key(a);
    const y = by.key(b);
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    if (x !== y && x !== null) return (x < y ? -1 : 1) * by.dir;
    const n = nameOf(a);
    const m = nameOf(b);
    if (n !== m) return n < m ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* A picture a card could draw: the retailer's own photograph or the
   enrichment's. The atlas's productImage() with no member preference applied --
   the offer counts what is missing over the books, not what one member chose
   not to show -- over its safeImageUrl() and STOCK_IMAGE, copied rather than
   approximated: the one Sam's Club fuel graphic is not a photograph of
   anything, and counting it as one would hide 57 lines from the offer. */
const STOCK_IMAGE = /\/sams-fuel-nobg-img\.jpg(?:[?#]|$)/;
function safeImageUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, 'https://recibbi.invalid');
    return ['http:', 'https:', 'data:'].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}
function pictured(item) {
  const e = (item && item.enrichment) || {};
  const src = safeImageUrl(item && item.imageUrl) || safeImageUrl(e.imageUrl);
  return Boolean(src && !STOCK_IMAGE.test(src));
}

/**
 * The envelope GET /api/catalogue answers: a page, and what it is a page OF.
 * The same numbers the books' envelope carries, counted in products, plus two
 * the Products screen needs: how many receipts the matches came off, and how
 * many products across the books have no picture.
 */
function page(all, f, sort, { limit, offset }) {
  const matched = sortProducts(all.filter((p) => matches(p, f)), sort);
  const receipts = new Set();
  for (const p of matched) for (const b of p.buys) receipts.add(b.record.id);
  const from = Math.max(0, offset);
  const records = matched.slice(from, from + limit);
  return {
    records,
    total: all.length,
    matched: matched.length,
    receipts: receipts.size,
    limit,
    offset: from,
    more: from + records.length < matched.length,
    facets: facets(all, f),
    unpictured: all.filter((p) => !pictured(p.item)).length,
  };
}

module.exports = {
  FILTER_KEYS,
  NAMED_ORDER,
  SORTS,
  DEFAULT_SORT,
  empty,
  parse,
  countOrNull,
  timesOn,
  namedAs,
  valueOf,
  matches,
  facets,
  sortOrDefault,
  sortProducts,
  pictured,
  page,
};
