'use strict';

// The Costco adapter, against invented receipts in the real API shape (see
// test/fixtures/retailers/costco/receipts.json). Each assertion traces to a
// numbered claim in the adapter's header / docs/costco-receipt-schema.md.
//
// Pure module tests — no Redis, no HTTP, no filesystem beyond the fixtures.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const adapter = require('../src/retailers/adapters/costco.com.js');
const registry = require('../src/retailers/registry');

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'retailers', 'costco', 'receipts.json'), 'utf8')
);
const load = (name) => JSON.parse(JSON.stringify(FIXTURES[name]));
const bySku = (items, sku) => items.find((i) => i.sku === sku);

test('the adapter is registered under the ids ux-main and the add-on use', () => {
  for (const id of ['costco.com', 'costco', 'Costco', 'www.costco.com']) {
    assert.equal(registry.get(id) && registry.get(id).id, 'costco.com', `${id} resolves`);
  }
});

test('detect() accepts every fixture and refuses other retailers', () => {
  for (const name of ['warehouse', 'fuel', 'refund']) assert.equal(adapter.detect(load(name)), true, name);
  assert.equal(adapter.detect(null), false);
  assert.equal(adapter.detect([]), false);
  assert.equal(adapter.detect({}), false);
  // A Sam's Club envelope must not be read as Costco's.
  assert.equal(adapter.detect({ summary: { orderId: '1' }, detail: { groups_2101: [] } }), false);
  // A barcode alone is not enough.
  assert.equal(adapter.detect({ transactionBarcode: '1' }), false);
});

test('output is the canonical shape the OCR path produces', () => {
  const out = adapter.normalize(load('warehouse'));
  assert.deepEqual(Object.keys(out).sort(), ['items', 'source', 'store', 'totals', 'warnings']);
  for (const item of out.items) {
    for (const field of ['description', 'sku', 'qty', 'unitPrice', 'price', 'enrichment']) {
      assert.ok(field in item, `every item carries "${field}"`);
    }
    assert.equal(item.enrichment, null);
  }
  assert.equal(out.store.name, 'Costco', 'the canonical chain name, so it groups with a photographed receipt');
  assert.equal(out.store.date, '2026-03-14');
});

test('§1/§2 an instant-savings line is folded into its item, and the receipt still reconciles', () => {
  const out = adapter.normalize(load('warehouse'));
  assert.equal(out.items.length, 3, 'three products, not four lines');
  assert.ok(!out.items.some((i) => /^\//.test(i.description)), 'no coupon line survives as an item');
  const cheese = bySku(out.items, '1111111');
  assert.equal(cheese.price, 9.49, 'price is what was paid');
  assert.equal(cheese.grossPrice, 13.79);
  assert.equal(cheese.savings, 4.3);
  assert.equal(out.totals.sumOfItems, 58.43);
  assert.equal(out.totals.subtotalMatch, true);
  assert.equal(out.totals.totalMatch, true, 'subtotal + tax == total; instantSavings is NOT subtracted again');
  assert.equal(out.totals.reconciled, true);
  assert.equal(out.totals.savings, 4.3);
  assert.deepEqual(out.warnings, []);
});

test('§3 the shelf rate is taken as given, never price / qty', () => {
  const out = adapter.normalize(load('warehouse'));
  const beef = bySku(out.items, '2222222');
  assert.equal(beef.unitPrice, 9.99, 'per pound');
  assert.equal(beef.price, 27.77);
  assert.equal(bySku(out.items, '3333333').detail, '24/500ML 16.9OZ', 'the pack line is kept');
});

test('§4 a gas receipt carries its gallons and grade', () => {
  const out = adapter.normalize(load('fuel'));
  assert.equal(out.items.length, 1);
  const [gas] = out.items;
  assert.equal(gas.measuredQty, 8.969);
  assert.equal(gas.unit, 'gal');
  assert.equal(gas.unitPrice, 2.899);
  assert.equal(gas.fuelGrade, 'Regular');
  assert.equal(out.source.isFuelPurchase, true);
  assert.equal(out.store.fulfillment, 'FUEL');
  assert.equal(out.totals.reconciled, true);
});

test('§5 a refund is negative throughout and is not mistaken for a discount', () => {
  const out = adapter.normalize(load('refund'));
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].price, -299.99);
  assert.equal(out.items[0].returned, true);
  assert.equal(out.items[0].savings, undefined);
  assert.equal(out.source.isRefund, true);
  assert.equal(out.totals.reconciled, true);
});

test('§6 the barcode is the order id the engine dedupes on', () => {
  const out = adapter.normalize(load('warehouse'));
  assert.equal(out.source.orderId, '29999007010126031412100');
  assert.equal(out.source.externalId, 'costco.com:29999007010126031412100');
});

test('no personal data is copied out of the payload', () => {
  const out = JSON.stringify(adapter.normalize(load('warehouse')));
  for (const secret of ['000000000001', '000000000000', 'tenderAuthorizationCode', 'displayAccountNumber']) {
    assert.ok(!out.includes(secret), `${secret} stays in the raw payload`);
  }
});

test('a coupon naming no item on the receipt is kept as its own line, and said', () => {
  const r = load('warehouse');
  r.itemArray[1].frenchItemDescription1 = '/9999999';
  const out = adapter.normalize(r);
  const orphan = out.items.find((i) => i.discount);
  assert.ok(orphan, 'kept, so the receipt still adds up');
  assert.equal(orphan.sku, null, 'and never looked up as a product');
  assert.equal(out.totals.subtotalMatch, true);
  assert.equal(out.warnings.length, 1);
});

test('a partial payload degrades instead of throwing', () => {
  const out = adapter.normalize({ transactionBarcode: '1', documentType: 'WarehouseReceiptDetail' });
  assert.deepEqual(out.items, []);
  assert.ok(out.warnings.includes('receipt carries no line items'));
  assert.equal(out.source.orderId, '1');
});
