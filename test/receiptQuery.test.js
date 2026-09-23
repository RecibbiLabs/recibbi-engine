'use strict';

// The filter predicate, the counts and the facets that let a caller draw a
// filter panel over receipts it has not got.
//
// Every assertion below is a rule settled in ../recibbi-ux-design-atlas and
// written down in its docs/porting.md -- most of them after the rule was broken
// in a real run. They are here because THIS is now the side that narrows the
// books: a browser re-running the same predicate over a page it was handed and
// this module running it over everything must agree, or a member watches the
// list change under them when a filter round-trips.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir } = require('./helpers/harness');
const tmp = useTempDataDir('receipt-query-test');
const q = require('../src/receiptQuery');

process.on('exit', () => tmp.cleanup());

const done = (over = {}) => ({
  id: 'a',
  status: 'done',
  source: 'telegram',
  store: { name: 'Aldi', date: '2026-08-24' },
  items: [{ description: 'x' }, { description: 'y' }],
  totals: { total: 30, itemCount: 2, sumOfItems: 30 },
  ...over,
});

const inFlight = (over = {}) => ({
  id: 'p',
  status: 'processing',
  source: 'telegram',
  store: { name: 'Costco Wholesale', date: null },
  createdAt: '2026-09-01T10:00:00.000Z',
  items: [],
  totals: null,
  ...over,
});

// --- "A range tests a number, and a receipt still being read has none." -----

test('a receipt nobody has read yet has no item count, and no total', () => {
  // Not zero. Zero is a claim about a basket -- "there was nothing in it" --
  // and nothing has opened this one. The difference is the whole reason
  // `status` exists, and a caller handed 0 cannot recover it.
  assert.equal(q.itemCount(inFlight()), null);
  assert.equal(q.itemCount(done()), 2);
  // A finished receipt with genuinely no items IS zero. That one is a fact.
  assert.equal(q.itemCount({ status: 'done', items: [] }), 0);
});

test('the amount falls back to the items when the ticket printed no total', () => {
  // A photographed receipt with no printed total is the common case, not the
  // edge one.
  assert.equal(q.receiptTotal(done()), 30);
  assert.equal(q.receiptTotal(done({ totals: { total: null, sumOfItems: 41.2 } })), 41.2);
  assert.equal(q.receiptTotal(inFlight()), undefined);
});

test('an active range leaves out the receipts that have no number to test', () => {
  // "$0 and up" reads like "everything" and is not: a receipt still being read
  // has no total, so a range -- any range -- cannot match it. The caller is
  // told this out loud rather than losing three receipts quietly.
  const f = { ...q.empty(), amount: { min: 0, max: null } };
  assert.equal(q.matches(done(), f), true);
  assert.equal(q.matches(inFlight(), f), false);

  const items = { ...q.empty(), items: { min: 0, max: null } };
  assert.equal(q.matches(inFlight(), items), false);
});

test('a range with neither end set is not a range at all', () => {
  // The sliders suppress each end on its own, so an unconstrained range submits
  // nothing. This module must not invent one -- inventing it would drop every
  // in-flight receipt from a list nobody filtered.
  const none = q.parse({});
  assert.equal(q.isEmpty(none), true);
  assert.equal(q.matches(inFlight(), none), true);
  assert.equal(q.apply([done(), inFlight()], none).length, 2);
});

// --- "What narrows the list is in the URL." ---------------------------------

test('the query string is read the way a GET form submits it', () => {
  // Repeated keys for the multiple-choice groups, a bare pair per range --
  // which is what a form of checkboxes and two number fields actually sends.
  const f = q.parse({
    store: ['Aldi', 'Target'],
    status: 'done',
    from: '2026-01-01',
    amt_min: '50',
    items_max: '9',
  });
  assert.deepEqual(f.store, ['Aldi', 'Target']);
  assert.deepEqual(f.status, ['done'], 'a single key is still a group');
  assert.equal(f.from, '2026-01-01');
  assert.deepEqual(f.amount, { min: 50, max: null });
  assert.deepEqual(f.items, { min: null, max: 9 });
});

test('an unreadable filter is no filter, not a rejection', () => {
  // 400-ing a member out of their own receipts over a malformed amt_min would
  // be the wrong trade.
  const f = q.parse({ amt_min: 'banana', items_min: '', store: ['', 'Aldi'] });
  assert.deepEqual(f.amount, { min: null, max: null });
  assert.deepEqual(f.items, { min: null, max: null });
  assert.deepEqual(f.store, ['Aldi'], 'an empty value is not a choice');
});

test('a date bound that is not a day is not a bound', () => {
  // The same rule as amt_min above, for the two parameters that were missing
  // it. `from=banana` used to be compared lexically against '2026-08-24' and
  // every other day, so every receipt sorted below it and the member got an
  // empty list with nothing to explain it. Of the two ways to misread a filter,
  // silently hiding the whole of somebody's books is the worse one.
  assert.equal(q.dayOrNull('2026-09-11'), '2026-09-11');
  assert.equal(q.dayOrNull('banana'), null, 'not a date at all');
  assert.equal(q.dayOrNull('2026-09'), null, 'half a day is not a day');
  assert.equal(q.dayOrNull('9/11/2026'), null, 'the wire spelling is ISO, and only ISO');
  assert.equal(q.dayOrNull(''), null);

  const junk = q.parse({ from: 'banana', to: '' });
  assert.equal(junk.from, null);
  assert.equal(junk.to, null);
  assert.equal(q.isEmpty(junk), true, 'so nothing is narrowing the list');
  assert.equal(q.matches(done(), junk), true, 'and the books come back whole');
});

test('the date range means the same day the sort used', () => {
  // store.date is not reliably canonical: a retailer adapter writes an ISO day,
  // a photographed receipt carries whatever detectDate() matched. The ordering
  // already parses that; a filter comparing the raw string would disagree with
  // it and hide a receipt the member can see two rows above.
  const slashy = done({ store: { name: 'Aldi', date: '9/11/2026' } });
  assert.equal(q.receiptDay(slashy), '2026-09-11');
  const inRange = { ...q.empty(), from: '2026-09-01', to: '2026-09-30' };
  assert.equal(q.matches(slashy, inRange), true);
  assert.equal(q.matches(done(), inRange), false, 'Aug 24 is outside September');
});

test('a receipt with no readable date falls back to when it was read', () => {
  assert.equal(q.receiptDay(inFlight()), '2026-09-01');
});

// --- "The facet counts are the OTHER groups' counts." -----------------------

test('a facet count says what ticking the box would leave, not zero', () => {
  // Counting `store` with the store filter applied to itself makes every
  // unticked box read 0, which tells a member nothing about what ticking it
  // would do.
  const books = [
    done({ id: 'a', store: { name: 'Aldi', date: '2026-08-24' } }),
    done({ id: 'b', store: { name: 'Costco Wholesale', date: '2026-08-01' }, source: 'sync' }),
    inFlight({ id: 'c', store: { name: 'Aldi', date: null } }),
  ];
  const f = { ...q.empty(), store: ['Aldi'] };
  const fx = q.facets(books, f);

  assert.equal(fx.counts.store.Aldi, 2);
  assert.equal(fx.counts.store['Costco Wholesale'], 1, 'an unticked box must not read 0');
  // The OTHER groups ARE narrowed by the store choice -- that is the point.
  assert.equal(fx.counts.source.telegram, 2);
  assert.equal(fx.counts.source.sync, undefined, 'no Aldi receipt arrived by sync');
});

test('the options a group offers come from the books, never a fixed list', () => {
  const books = [done({ source: 'sync' }), done({ id: 'b', source: 'telegram' })];
  assert.deepEqual(q.facets(books, q.empty()).options.source, ['sync', 'telegram']);
  // Pipeline order for status, not alphabetical: the order the badges teach.
  const mixed = [done({ status: 'failed' }), done({ id: 'b', status: 'done' })];
  assert.deepEqual(q.facets(mixed, q.empty()).options.status, ['done', 'failed']);
});

test('the facets carry what the books hold, not what the page holds', () => {
  const books = [done({ id: 'a' }), done({ id: 'b', totals: { total: 212 } }), inFlight()];
  const fx = q.facets(books, q.empty());
  assert.equal(fx.bounds.amount.hi, 220, 'the slider ends where the books do, rounded up');
  assert.equal(fx.bounds.items.hi, 2);
  assert.equal(fx.days.from, '2026-08-24');
  // The count a caller needs to say WHY a range returned nothing.
  assert.equal(fx.pending, 1);
});

// --- "The order is a question for the route, not for the page." ------------
//
// The same table as the atlas's test/laws.test.js, so the two cannot disagree
// about what "largest first" means. docs/proposals.md § 10 over there.

test('a receipt that is not done comes first, whatever the order', () => {
  // In byRecency() order: newest first. `q` is queued and `x` failed, both
  // older than the finished `a`; they still lead under every sort.
  const books = [
    inFlight({ id: 'p', store: { name: 'Costco' } }),
    done({ id: 'a', store: { name: 'aldi', date: '2026-08-24' }, totals: { total: 40 } }),
    inFlight({ id: 'q', status: 'queued', store: { name: 'Zabar' } }),
    done({ id: 'b', store: { name: 'Target', date: '2026-08-20' }, totals: { total: 5 }, items: [{ description: 'z' }] }),
    inFlight({ id: 'x', status: 'failed', store: { name: 'Aldi' } }),
    done({ id: 'c', store: { name: 'Aldi', date: '2026-08-10' }, totals: { total: 90 } }),
    done({ id: 'n', store: { name: 'Aldi', date: '2026-08-01' }, totals: {} }),
  ];
  const ids = (s) => q.sortReceipts(books, s).map((r) => r.id).join('');
  assert.equal(ids('newest'), 'pqx' + 'abcn');
  assert.equal(ids('oldest'), 'pqx' + 'ncba');
  assert.equal(ids('largest'), 'pqx' + 'cabn');
  // A finished receipt with no total is not the smallest; it is not known.
  assert.equal(ids('smallest'), 'pqx' + 'bacn');
  assert.equal(ids('most_items'), 'pqx' + 'acnb');
  assert.equal(ids('fewest_items'), 'pqx' + 'bacn');
  // Case-blind, and a tie keeps the recency order: the Aldis newest first.
  assert.equal(ids('store_az'), 'pqx' + 'acnb');
  assert.equal(ids('store_za'), 'pqx' + 'bacn');
  assert.equal(ids('banana'), ids('newest'));
  // And it never reorders what it was handed in place.
  assert.equal(books.map((r) => r.id).join(''), 'paqbxcn');
});

test('an unknown sort is the default, not an error', () => {
  assert.equal(q.sortOrDefault('largest'), 'largest');
  assert.equal(q.sortOrDefault('banana'), q.DEFAULT_SORT);
  assert.equal(q.sortOrDefault(undefined), q.DEFAULT_SORT);
  assert.equal(q.sortOrDefault(['largest', 'oldest']), q.DEFAULT_SORT, 'a repeated key is not a sort');
  assert.deepEqual(q.SORTS.length, 8);
});
