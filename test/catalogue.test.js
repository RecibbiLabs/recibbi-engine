'use strict';

// The catalogue's two pure halves: the projection (a receipt -> purchase rows
// -> products) and the query (filters, order, facets). No persistence here;
// see catalogue-store.test.js for that and catalogue-ingest.test.js for the
// pipeline.
//
// THE RULES UNDER TEST ARE THE DESIGN ATLAS'S, and several cases below are its
// own examples: ../recibbi-ux-design-atlas/assets/js/pages/products.js
// (catalogue, storeKey, productMatches, facets, sortProducts) and
// assets/js/recibbi.js (productKey, mergeBasket). A case that fails here after
// a change there means the two have drifted, and the atlas is right.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir } = require('./helpers/harness');

const tmp = useTempDataDir('catalogue-test');
process.on('exit', () => tmp.cleanup());

const project = require('../src/catalogue/project');
const query = require('../src/catalogue/query');

let seq = 0;
function receipt({ store = "Sam's Club", retailer = 'samsclub.com', date = '2026-05-01', status = 'done', items = [], createdAt } = {}) {
  seq += 1;
  return {
    id: `t1:u1:r${String(seq).padStart(4, '0')}`,
    status,
    retailer,
    store: store === null ? null : { name: store, date },
    createdAt: createdAt || `2026-09-0${(seq % 9) + 1}T10:00:00.000Z`,
    items,
  };
}

function line(description, sku, price, extra = {}) {
  return { description, sku, qty: 1, unitPrice: price, price, ...extra };
}

/* ----------------------------------------------------------- the identity */

test('productKey is the SKU where there is one and the register string where not', () => {
  assert.equal(project.productKey({ sku: '30669', description: 'EGGS' }), 'sku:30669');
  assert.equal(project.productKey({ sku: null, description: 'ORG BANANAS' }), 'raw:ORG BANANAS');
  assert.equal(project.productKey({ description: '' }), 'raw:');
});

test('storeKey: a synced retailer by id, a printed name by prefix, anything else by its letters', () => {
  assert.equal(project.storeKey({ retailer: 'samsclub.com', store: { name: 'whatever' } }), 'samsclub');
  assert.equal(project.storeKey({ store: { name: 'COSTCO WHOLESALE #1024' } }), 'costco');
  assert.equal(project.storeKey({ store: { name: 'Costco' } }), 'costco');
  assert.equal(project.storeKey({ store: { name: "TRADER JOE'S #552" } }), 'traderjoes');
  assert.equal(project.storeKey({ store: { name: 'Corner Deli, Inc.' } }), 'cornerdeliinc');
  assert.equal(project.storeKey({ store: null }), '');
  // A retailer id nobody has catalogued falls through to the printed name.
  assert.equal(project.storeKey({ retailer: 'unknown.example', store: { name: 'Aldi Süd' } }), 'aldi');
});

test('the same SKU at two stores is two products, because a SKU is a retailer’s number', () => {
  const a = receipt({ items: [line('EGGS', '30669', 5)] });
  const b = receipt({ retailer: null, store: 'Costco', items: [line('EGGS', '30669', 5)] });
  const rows = [...project.purchases(a), ...project.purchases(b)];
  assert.equal(new Set(rows.map((r) => r.productId)).size, 2);
});

test('productId is a stable, URL-safe hash of the key', () => {
  const id = project.productId('samsclub|sku:MINI CUCUMBE');
  assert.match(id, /^p[0-9a-f]{24}$/);
  assert.equal(id, project.productId('samsclub|sku:MINI CUCUMBE'));
  assert.notEqual(id, project.productId('costco|sku:MINI CUCUMBE'));
});

/* ---------------------------------------------------------- one receipt */

test('lines with one key merge: qty sums, spent sums only priced lines, every line is kept', () => {
  const r = receipt({
    items: [
      line('EGGS', '1', 5.49),
      line('MILK', '2', 3.2),
      line('EGGS', '1', 5.49, { qty: 2, price: 10.98 }),
      line('EGGS', '1', null, { price: null }),
    ],
  });
  const rows = project.purchases(r);
  assert.equal(rows.length, 2, 'two products, in register order');
  const [eggs, milk] = rows;
  assert.equal(eggs.line, 'sku:1');
  assert.equal(eggs.qty, 4); // 1 + 2 + 1
  assert.equal(eggs.spent, 16.47); // the unpriced line adds nothing
  assert.equal(eggs.lines.length, 3);
  assert.equal(milk.spent, 3.2);
  assert.equal(eggs.receiptId, r.id);
  assert.equal(eggs.day, '2026-05-01');
});

test('a line with no quantity is one of something', () => {
  const [row] = project.purchases(receipt({ items: [{ description: 'X', sku: '9', price: 1 }] }));
  assert.equal(row.qty, 1);
});

test('a receipt that is not done, or has no lines, has no purchases', () => {
  assert.deepEqual(project.purchases(receipt({ status: 'processing', items: [line('A', '1', 1)] })), []);
  assert.deepEqual(project.purchases(receipt({ items: [] })), []);
  assert.deepEqual(project.purchases(null), []);
});

test('an undated receipt files under the day it was read, as the books do', () => {
  const [row] = project.purchases(receipt({ date: null, createdAt: '2026-08-15T23:00:00.000Z', items: [line('A', '1', 1)] }));
  assert.equal(row.day, '2026-08-15');
});

/* -------------------------------------------------- what a line is called */

test('enrichment is carried in the atlas’s shape, with `url` read as `page`', () => {
  const v = project.enrichmentView({
    enrichment: { title: 'Mini Cucumbers', url: 'https://x.example/p', imageUrl: 'https://i.example/a.jpg', source: 'retailer' },
  });
  assert.equal(v.title, 'Mini Cucumbers');
  assert.equal(v.page, 'https://x.example/p');
  assert.equal(v.named, null);
  assert.equal(v.confidence, null);
  assert.equal(project.enrichmentView({ enrichment: null }), null, 'nothing to say is null, not a row of nulls');
  assert.equal(project.enrichmentView({ enrichment: { query: 'x', error: 'boom' } }), null);
});

test('the resolver fills what the pipeline left empty, and never over a member', () => {
  const resolved = project.resolvedIndex([
    { products: [{ lineItem: { sku: 'A1', description: 'KS WATER' }, productTitle: 'Sparkling Water', brand: 'Kirkland', category: 'Beverages', confidence: 0.9, productUrl: 'https://r.example' }] },
  ]);
  const guessed = project.purchases(receipt({ items: [line('KS WATER', 'A1', 4)] }), { resolved })[0].lines[0].enrichment;
  assert.equal(guessed.title, 'Sparkling Water');
  assert.equal(guessed.category, 'Beverages');
  assert.equal(guessed.confidence, 0.9);
  assert.equal(guessed.page, 'https://r.example');

  const named = project.purchases(
    receipt({ items: [line('KS WATER', 'A1', 4, { enrichment: { title: 'Fizzy', brand: null, named: 'member', confidence: null } })] }),
    { resolved }
  )[0].lines[0].enrichment;
  assert.equal(named.title, 'Fizzy');
  assert.equal(named.brand, null, 'a brand the member cleared stays cleared');
  assert.equal(named.category, null);
  assert.equal(named.confidence, null, 'a member’s answer carries no confidence');
  assert.equal(named.named, 'member');
});

test('an all-null resolver answer contributes nothing', () => {
  assert.equal(project.resolvedIndex([{ products: [{ lineItem: { sku: '1' }, productTitle: null }] }]), null);
});

/* ------------------------------------------------------------- assembling */

function catalogueOf(receipts) {
  return project.assemble(receipts.flatMap((r) => project.purchases(r)));
}

test('one product per store+key across receipts, with its receipts newest first', () => {
  const old = receipt({ date: '2026-01-10', items: [line('EGGS', '1', 5)] });
  const mid = receipt({ date: '2026-03-10', items: [line('EGGS', '1', 6), line('MILK', '2', 3)] });
  const undated = receipt({ date: null, items: [line('EGGS', '1', 7)] });
  delete undated.createdAt; // no printed day and no instant: nothing to date it by
  const [eggs] = catalogueOf([old, mid, undated]).filter((p) => p.line === 'sku:1');
  assert.equal(eggs.times, 3);
  assert.equal(eggs.spent, 18);
  assert.equal(eggs.qty, 3);
  assert.deepEqual(eggs.buys.map((b) => b.record.id), [mid.id, old.id, undated.id], 'a receipt nobody could date goes last');
  assert.equal(eggs.last, '2026-03-10');
  assert.equal(eggs.store, "Sam's Club");
  assert.deepEqual(Object.keys(eggs.buys[0].record).sort(), ['id', 'retailer', 'store'], 'a buy carries only what the card reads');
});

test('the card is drawn from a flagged line when any receipt has one', () => {
  const newest = receipt({ date: '2026-05-01', items: [line('SWISS', '7', 4)] });
  const older = receipt({ date: '2026-02-01', items: [line('SWISS', '7', 4, { enrichment: { title: 'Swiss chard?', needsReview: true } })] });
  const [p] = catalogueOf([newest, older]);
  assert.equal(p.item.enrichment.needsReview, true);
  assert.equal(p.buys[0].record.id, newest.id);
});

/* ------------------------------------------------------------------ query */

function books() {
  const withCat = (d, s, p, category, extra = {}) =>
    line(d, s, p, { enrichment: { title: d.toLowerCase(), category, ...extra } });
  return catalogueOf([
    receipt({ date: '2026-01-01', items: [withCat('EGGS', '1', 5, 'Dairy'), line('RAW THING', null, 2)] }),
    receipt({ date: '2026-02-01', items: [withCat('EGGS', '1', 5, 'Dairy'), withCat('APPLES', '3', 4, 'Produce')] }),
    receipt({ date: '2026-03-01', items: [withCat('EGGS', '1', 5, 'Dairy'), withCat('CHEESE', '4', 9, 'Dairy', { needsReview: true })] }),
    receipt({ retailer: null, store: 'Costco', date: '2026-04-01', items: [line('BIG TV', '5', 400, { enrichment: { title: 'Television', named: 'member' } })] }),
  ]);
}

test('parse reads the atlas’s spelling and drops what is not a bound', () => {
  const f = query.parse({ category: ['Dairy', 'Produce'], store: 'Costco', times_min: '2', times_max: 'x', junk: '1' });
  assert.deepEqual(f.category, ['Dairy', 'Produce']);
  assert.deepEqual(f.store, ['Costco']);
  assert.deepEqual(f.times, { min: 2, max: null });
  assert.deepEqual(query.parse({ times_min: '0' }).times, { min: null, max: null }, 'fewer than one receipt is no bound');
});

test('a product with no value in a group that is on is a miss, not a pass', () => {
  const all = books();
  const dairy = all.filter((p) => query.matches(p, query.parse({ category: 'Dairy' })));
  assert.deepEqual(dairy.map((p) => p.line).sort(), ['sku:1', 'sku:4']);
  assert.equal(all.filter((p) => query.matches(p, query.parse({ tag: 'x' }))).length, 0);
});

test('named: review beats resolver, member is the member’s, nobody has no title', () => {
  const byLine = Object.fromEntries(books().map((p) => [p.line, query.namedAs(p.item)]));
  assert.equal(byLine['sku:4'], 'review');
  assert.equal(byLine['sku:5'], 'member');
  assert.equal(byLine['sku:1'], 'resolver');
  assert.equal(byLine['raw:RAW THING'], 'nobody');
});

test('the times range applies only at the end that is set', () => {
  const all = books();
  assert.deepEqual(all.filter((p) => query.matches(p, query.parse({ times_min: '2' }))).map((p) => p.line), ['sku:1']);
  assert.equal(all.filter((p) => query.matches(p, query.parse({ times_max: '1' }))).length, all.length - 1);
});

test('facet counts are the OTHER groups’ counts, and named keeps its fixed order', () => {
  const all = books();
  const fc = query.facets(all, query.parse({ category: 'Dairy' }));
  // Ticking Dairy must not zero Produce: its count is what ticking it would leave.
  assert.equal(fc.counts.category.Produce, 1);
  assert.equal(fc.counts.category.Dairy, 2);
  // The store counts DO see the category filter.
  assert.deepEqual(fc.counts.store, { "Sam's Club": 2 });
  assert.deepEqual(fc.options.store, ['Costco', "Sam's Club"]);
  assert.deepEqual(fc.options.named, ['review', 'member', 'resolver', 'nobody']);
  assert.deepEqual(fc.bounds.times, { lo: 1, hi: 3 });
  assert.deepEqual(fc.options.tag, [], 'nobody has tagged anything, so there is no tag group');
});

test('every order sorts before the slice, with the name then the id as tie-breaks', () => {
  const all = books();
  const order = (s) => query.sortProducts(all, s).map((p) => p.line);
  assert.equal(order('recent')[0], 'sku:5');
  assert.equal(order('earliest')[0], 'raw:RAW THING');
  assert.equal(order('most_often')[0], 'sku:1');
  assert.equal(order('most_spent')[0], 'sku:5');
  assert.equal(order('least_spent')[0], 'raw:RAW THING');
  assert.deepEqual(order('name_az').slice(0, 2), ['sku:3', 'sku:4']); // apples, cheese
  assert.equal(order('name_za')[0], 'sku:5'); // television
  assert.deepEqual(order('bogus'), order('recent'), 'an unknown order is the default, not a 400');
});

test('the page envelope counts the books, slices the matches, and counts the unpictured', () => {
  const all = books();
  const env = query.page(all, query.parse({ category: 'Dairy' }), 'name_az', { limit: 1, offset: 0 });
  assert.equal(env.total, all.length);
  assert.equal(env.matched, 2);
  assert.equal(env.records.length, 1);
  assert.equal(env.more, true);
  assert.equal(env.receipts, 3, 'the Dairy products came off three receipts');
  assert.equal(env.categories, 1, 'the categories behind what matched, not the slice');
  const dairy = all.filter((p) => query.valueOf(p, 'category') === 'Dairy');
  assert.equal(env.spent, Math.round(dairy.reduce((a, p) => a + p.spent, 0) * 100) / 100,
    'what matched came to, not what is on the page');
  assert.equal(env.unpictured, all.length);
});

test('a total with no priced line behind it is null, never 0', () => {
  const recs = [{ id: 'u', status: 'done', store: { name: 'X' }, items: [{ description: 'MILK', price: null }] }];
  const all = project.assemble(recs.flatMap((r) => project.purchases(r)));
  const env = query.page(all, query.parse({}), 'recent', { limit: 24, offset: 0 });
  assert.equal(env.matched, 1);
  assert.equal(env.categories, 0);
  assert.equal(env.spent, null);
});

test('the Sam’s Club fuel graphic is not a picture of anything', () => {
  assert.equal(query.pictured({ imageUrl: 'https://scene7.samsclub.com/is/image/samsclub/sams-fuel-nobg-img.jpg' }), false);
  assert.equal(query.pictured({ imageUrl: 'https://scene7.samsclub.com/is/image/samsclub/0005783616823_A' }), true);
  assert.equal(query.pictured({ imageUrl: 'javascript:alert(1)' }), false);
  assert.equal(query.pictured({ enrichment: { imageUrl: 'https://i.example/x.jpg' } }), true);
});
