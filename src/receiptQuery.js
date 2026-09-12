'use strict';

// Narrowing the books: the filter predicate, the counts, and the facets that
// let a caller draw a filter panel over receipts it has not got.
//
// WHY THIS IS HERE AND NOT IN THE CALLER. `GET /api/receipts` used to answer
// with a page and nothing else, so every question about the WHOLE of a member's
// receipts -- how many are there, how many match, which stores do they shop at,
// what is the largest amount -- could only be answered by pulling all of them
// across the wire and counting on the far side. That works up to a few hundred
// and then stops: recibbi-ux-main was hydrating each row with its own
// `GET /api/receipts/:id`, and its own comment said the fix belonged here
// ("if a list ever needs to be long enough for that to matter, the right fix is
// a totals field on the engine's list endpoint, not a bigger pool here" --
// recibbi-ux-main/src/engine.js). This is that fix.
//
// THE CONTRACT IS THE DESIGN ATLAS'S. The query-string spelling, the predicate
// and the two traps below are settled in ../recibbi-ux-design-atlas
// (docs/porting.md, and `matchesFilters` in assets/js/recibbi.js, which ships
// to the browser). A browser re-running the predicate over a page it was handed
// and this module running it over the books must agree, or a member watches the
// list change under them when a filter round-trips. Keep them in step.
//
// TWO TRAPS, both recorded there after they were real:
//
//   A RANGE MUST NOT BE APPLIED WHEN NEITHER END IS SET. `amt_min=0` with no
//   max is not "every receipt": applying a range at all drops every receipt
//   that has no total YET, because a range tests a number and a receipt still
//   being read has none. The sliders on that side suppress each end on its own
//   so an unconstrained range submits nothing at all; this module only has to
//   not invent one.
//
//   A FACET'S COUNTS ARE THE OTHER GROUPS' COUNTS. Counting `store` with the
//   store filter applied to itself makes every unticked box read 0, which tells
//   a member nothing about what ticking it would do.

const store = require('./store');

/** The three multiple-choice groups. Repeated keys, like a GET form submits. */
const MULTI = ['store', 'source', 'status'];

/** Pipeline order, not alphabetical: the order the status badges teach. */
const STATUS_ORDER = ['done', 'processing', 'queued', 'failed'];

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function empty() {
  return {
    store: [],
    source: [],
    status: [],
    from: null,
    to: null,
    items: { min: null, max: null },
    amount: { min: null, max: null },
  };
}

/**
 * Read the filters off a parsed query object (Express's `req.query`).
 *
 * Express gives a repeated key as an array and a single one as a string, so
 * every multi-group is normalised to an array here rather than at three call
 * sites. Anything unparseable is dropped rather than rejected: a filter that
 * cannot be read is no filter, and 400-ing a member out of their own receipts
 * over a malformed `amt_min` would be the wrong trade.
 */
function parse(query = {}) {
  const f = empty();
  for (const k of MULTI) {
    const raw = query[k];
    f[k] = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .map((v) => String(v))
      .filter(Boolean);
  }
  f.from = query.from ? String(query.from) : null;
  f.to = query.to ? String(query.to) : null;
  f.items = { min: numOrNull(query.items_min), max: numOrNull(query.items_max) };
  f.amount = { min: numOrNull(query.amt_min), max: numOrNull(query.amt_max) };
  return f;
}

function rangeOn(r) {
  return r.min !== null || r.max !== null;
}

/** Is anything actually narrowing the list? */
function isEmpty(f) {
  return (
    !MULTI.some((k) => f[k].length) && !f.from && !f.to && !rangeOn(f.items) && !rangeOn(f.amount)
  );
}

/**
 * How many items -- or NULL, which is not the same as zero.
 *
 * A receipt still in the pipeline has an empty `items` array because nothing
 * has read it yet, and calling that "0 items" is a claim about a basket nobody
 * has opened. Null is what makes a range filter say *unknown* instead of
 * quietly answering *none*.
 */
function itemCount(record) {
  const n = (record.items || []).length;
  return n === 0 && record.status !== 'done' ? null : n;
}

/**
 * What the receipt came to -- the printed total, or the items summed when the
 * ticket printed none. A photographed receipt with no total line is the common
 * case, not the edge one.
 */
function receiptTotal(record) {
  const t = record.totals || {};
  return t.total !== null && t.total !== undefined ? t.total : t.sumOfItems;
}

/**
 * THE DAY THE FILTER MEANS IS THE DAY THE SORT USED.
 *
 * store.receiptDay() is what orders the list -- the day ON the receipt, parsed
 * out of whatever shape the OCR produced, falling back to the day it was read.
 * A date range that compared `store.date` raw would disagree with it on every
 * receipt whose date came off a photograph as "9/11/2026", and a range that
 * hides a receipt the member can see two rows above is worse than no range.
 */
function receiptDay(record) {
  return store.receiptDay(record);
}

function matches(record, f) {
  if (f.store.length && !f.store.includes(record.store && record.store.name)) return false;
  if (f.source.length && !f.source.includes(record.source)) return false;
  if (f.status.length && !f.status.includes(record.status)) return false;

  if (f.from || f.to) {
    const day = receiptDay(record);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
  }

  if (rangeOn(f.items)) {
    const n = itemCount(record);
    if (n === null) return false;
    if (f.items.min !== null && n < f.items.min) return false;
    if (f.items.max !== null && n > f.items.max) return false;
  }

  if (rangeOn(f.amount)) {
    const a = receiptTotal(record);
    if (a === null || a === undefined) return false;
    if (f.amount.min !== null && a < f.amount.min) return false;
    if (f.amount.max !== null && a > f.amount.max) return false;
  }

  return true;
}

function apply(records, f) {
  if (isEmpty(f)) return records;
  return records.filter((r) => matches(r, f));
}

function valueFor(record, group) {
  return group === 'store' ? record.store && record.store.name : record[group];
}

/**
 * What each box would LEAVE, counted with every other group applied and this
 * one ignored. See the second trap at the top of this file.
 */
function countsFor(records, f, group) {
  const probe = { ...f, [group]: [] };
  const out = {};
  for (const r of apply(records, probe)) {
    const k = valueFor(r, group);
    if (k) out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * The options a group offers are the ones the books actually contain, never a
 * fixed list. A member who has never used Telegram is not offered a Telegram
 * box that can only ever return nothing, and the day a ninth store arrives it
 * appears without anybody editing a list.
 */
function optionsFor(records, group) {
  const seen = new Set();
  for (const r of records) {
    const k = valueFor(r, group);
    if (k) seen.add(k);
  }
  const out = [...seen];
  return group === 'status'
    ? out.sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))
    : out.sort();
}

/** The ends of the two sliders, taken from the books rather than guessed. */
function boundsFor(records) {
  const amounts = [];
  const counts = [];
  for (const r of records) {
    const a = receiptTotal(r);
    if (a !== null && a !== undefined) amounts.push(Number(a));
    const n = itemCount(r);
    if (n !== null) counts.push(n);
  }
  return {
    amount: { lo: 0, hi: amounts.length ? Math.ceil(Math.max(...amounts) / 10) * 10 : 100 },
    items: { lo: 0, hi: counts.length ? Math.max(...counts) : 10 },
  };
}

/**
 * Everything a filter panel needs to draw itself, over the WHOLE of the books.
 *
 * `pending` is the count of receipts carrying no numbers yet. It is the one a
 * caller needs to say why a range returned nothing -- "three of them are still
 * being read" -- and it is a fact about the books, so counting the page would
 * understate it.
 */
function facets(records, f) {
  const counts = {};
  const options = {};
  for (const g of MULTI) {
    counts[g] = countsFor(records, f, g);
    options[g] = optionsFor(records, g);
  }
  const days = records.map(receiptDay).filter(Boolean).sort();
  return {
    counts,
    options,
    bounds: boundsFor(records),
    days: { from: days[0] || null, to: days[days.length - 1] || null },
    pending: records.filter((r) => itemCount(r) === null).length,
  };
}

module.exports = {
  MULTI,
  STATUS_ORDER,
  empty,
  parse,
  isEmpty,
  rangeOn,
  matches,
  apply,
  facets,
  itemCount,
  receiptTotal,
  receiptDay,
  numOrNull,
};
