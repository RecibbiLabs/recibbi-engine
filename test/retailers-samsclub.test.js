'use strict';

// The Sam's Club adapter, against ten REAL payloads (scrubbed of personal data
// — see test/fixtures/retailers/samsclub/README.md). Every assertion here traces
// to a documented claim or trap in docs/samsclub-receipt-schema.md, so this file
// is the executable half of that document: if a future payload change breaks a
// claim, a test says which one.
//
// Pure module tests — no Redis, no HTTP, no filesystem beyond the fixtures.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const adapter = require('../src/retailers/adapters/samsclub.com.js');

const DIR = path.join(__dirname, 'fixtures', 'retailers', 'samsclub');
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const normalize = (name) => adapter.normalize(load(name));
const byDescription = (items, needle) => items.find((i) => i.description.includes(needle));

// --- detect(): does this payload belong to this adapter? ---------------------

test('detect() accepts every fixture', () => {
  for (const { file } of load('index.json')) {
    assert.equal(adapter.detect(load(file)), true, `${file} is recognized`);
  }
});

test('detect() rejects payloads that are not ours', () => {
  assert.equal(adapter.detect(null), false);
  assert.equal(adapter.detect('a string'), false);
  assert.equal(adapter.detect([]), false);
  assert.equal(adapter.detect({}), false);
  // Shaped like a receipt, but not this retailer's envelope.
  assert.equal(adapter.detect({ orderId: '123', items: [{ name: 'milk' }] }), false);
  // Right envelope keys, no order id.
  assert.equal(adapter.detect({ summary: {}, detail: {} }), false);
  // An order id but no Sam's marker anywhere.
  assert.equal(adapter.detect({ detail: { id: '123' } }), false);
});

test('detect() accepts a half-present payload (detail call failed at collection)', () => {
  const payload = { summary: load('scan-and-go.json').summary, detailError: 'HTTP 500' };
  assert.equal(adapter.detect(payload), true, 'names and quantities are still worth ingesting');
});

// --- The canonical shape every downstream consumer relies on -----------------

test('output is the same canonical shape the OCR path produces', () => {
  const out = normalize('scan-and-go.json');
  assert.deepEqual(Object.keys(out).sort(), ['items', 'source', 'store', 'totals', 'warnings']);
  for (const item of out.items) {
    for (const field of ['description', 'sku', 'qty', 'unitPrice', 'price', 'enrichment']) {
      assert.ok(field in item, `every item carries the canonical "${field}"`);
    }
    assert.equal(item.enrichment, null, 'enrichment is left for the pipeline to fill');
    assert.equal(typeof item.description, 'string');
  }
  for (const field of ['subtotal', 'tax', 'total', 'itemCount', 'sumOfItems', 'subtotalMatch']) {
    assert.ok(field in out.totals, `totals carry the canonical "${field}"`);
  }
});

test('store.name is the canonical chain, so a synced receipt groups with a photographed one', () => {
  // NOT "Daytona Beach Sam's Club" — that is the club, and it lives on `branch`.
  const out = normalize('scan-and-go.json');
  assert.equal(out.store.name, "Sam's Club");
  assert.equal(out.store.branch.name, "Daytona Beach Sam's Club");
  assert.equal(out.store.branch.id, '8138');
  assert.equal(out.store.branch.city, 'Daytona Beach');
});

test('store.date is the order date, not the decorative title', () => {
  assert.equal(normalize('scan-and-go.json').store.date, '2025-10-05');
  assert.equal(normalize('fuel.json').store.date, '2026-08-03');
  assert.match(normalize('scan-and-go.json').source.orderDate, /^2025-10-05T/);
});

// --- Trap 1: two copies of every item ---------------------------------------

test('items come from the authoritative categories[] list, which carries unit prices', () => {
  const payload = load('scan-and-go.json');
  const out = adapter.normalize(payload);
  const group = payload.detail.groups_2101[0];
  const authoritative = group.categories.flatMap((c) => c.items);
  assert.equal(out.items.length, authoritative.length);
  // The projection under groups_2101[].items[] has no unitPrice at all; if we
  // had read it, this would be null.
  assert.equal(group.items[0].priceInfo.unitPrice, undefined);
  assert.ok(out.items.every((i) => i.unitPrice !== undefined));
});

test('a group with no categories falls back to the projection and says so', () => {
  const payload = load('scan-and-go.json');
  const group = payload.detail.groups_2101[0];
  const expected = group.items.length;
  delete group.categories;
  const out = adapter.normalize(payload);
  assert.equal(out.items.length, expected, 'still reads the items');
  assert.match(out.warnings.join(' '), /no categories\[\].*lower-fidelity/, 'and warns about the fidelity loss');
});

// --- Trap 2: itemCount is a display figure ----------------------------------

test('itemCount is counted, not copied — the payload disagrees with itself', () => {
  const fuel = normalize('fuel.json');
  assert.equal(fuel.items.length, 1, 'a fuel receipt is one line');
  assert.equal(fuel.totals.itemCount, 1, 'counted ourselves');
  assert.equal(fuel.totals.reportedItemCount, 13, "the payload's own figure, kept for reference");
});

// --- Trap 3: quantity is not the quantity for weighed/pumped lines -----------

test('a line sold by the pound keeps the payload unit price, not price / qty', () => {
  const steak = byDescription(normalize('scan-and-go.json').items, 'NY Strip Steak');
  assert.equal(steak.price, 24.87);
  assert.equal(steak.qty, 1, 'the payload says quantity 1');
  assert.equal(steak.unitPrice, 14.98, 'per POUND, straight from the payload');
  assert.notEqual(steak.unitPrice, steak.price / steak.qty, 'price/qty would have been 24.87 — wrong');
  assert.equal(steak.measuredQty, 1.66, 'the real measure, parsed from quantityString');
  assert.equal(steak.unit, 'lb');
  assert.equal(steak.quantityText, '1.66 lb');
  // The receipt can now say "1.66 lb @ $14.98/lb" the way the paper one does.
  assert.ok(Math.abs(steak.measuredQty * steak.unitPrice - steak.price) <= 0.01);
});

test('fuel carries gallons and a three-decimal rate', () => {
  const [gas] = normalize('fuel.json').items;
  assert.equal(gas.description, 'UNLEAD GASOLINE');
  assert.equal(gas.unit, 'gal', "quantityLabel says 'Qty'; the unit is in quantityString");
  assert.equal(gas.measuredQty, 13.324);
  assert.equal(gas.unitPrice, 3.659, 'three decimals survive');
  assert.equal(gas.price, 48.75, 'linePrice is the pump total');
  assert.equal(normalize('fuel.json').source.isFuelPurchase, true);
});

test('a plain counted line has no unit and no measured quantity', () => {
  const items = normalize('scan-and-go.json').items;
  const counted = items.find((i) => i.quantityText === '1');
  assert.equal(counted.unit, null);
  assert.equal(counted.measuredQty, null, 'a count is not a measure');
});

// --- Trap 5 / 10: the channel split in product identity ----------------------

test('in-club lines carry truncated receipt-tape SKUs, tagged as such', () => {
  const steak = byDescription(normalize('scan-and-go.json').items, 'NY Strip Steak');
  assert.equal(steak.sku, 'BF STRIPLOIN', 'what the register printed');
  assert.equal(steak.skuKind, 'offerId', 'not joinable to a catalogue — and it says so');
});

test('GLASS lines carry a catalogue usItemId instead', () => {
  const out = normalize('delivery-glass.json');
  assert.equal(out.store.channel, 'GLASS');
  assert.equal(out.items[0].skuKind, 'usItemId');
  assert.match(out.items[0].sku, /^\d+$/, 'a numeric catalogue id, not a tape string');
});

// --- Add-ons: separately charged lines nested under their parent -------------

test('add-ons are flattened into the item list, or the receipt does not add up', () => {
  const out = normalize('tire-addons.json');
  const addOn = out.items.find((i) => i.addOnType);
  assert.ok(addOn, 'the installation package became its own line');
  assert.equal(addOn.description, 'Tire Installation Package');
  assert.equal(addOn.addOnType, 'TIRE_INSTALLATION');
  assert.equal(addOn.price, 80);
  assert.equal(addOn.qty, 4);
  assert.equal(addOn.unitPrice, null, 'add-ons carry only a linePrice — none is invented');
  const parent = out.items.find((i) => i.sku === addOn.addOnOf);
  assert.ok(parent && !parent.addOnType, 'addOnOf points at the item it attaches to');
  // And it is counted: without the add-on the lines miss the subtotal by $80.
  assert.equal(out.totals.subtotalMatch, true);
  assert.equal(out.totals.sumOfItems, out.totals.subtotal);
});

// --- Informational rows ------------------------------------------------------

test('voided zero-cost rows are kept and flagged, not dropped', () => {
  const out = normalize('electronic-voided.json');
  const voided = out.items.filter((i) => i.informational);
  assert.equal(voided.length, 2, 'two membership-renewal rows');
  for (const row of voided) {
    assert.equal(row.price, 0);
    assert.equal(row.qty, 0);
    assert.equal(row.voided, true);
  }
  // They are real rows on the ticket; dropping them makes it disagree with paper.
  assert.equal(out.totals.itemCount, 9);
  assert.equal(out.totals.subtotalMatch, true, 'costing nothing, they do not disturb the sum');
});

// --- Returns -----------------------------------------------------------------

test('a returned line keeps its original positive price and is flagged', () => {
  const out = normalize('returned.json');
  const returned = out.items.filter((i) => i.returned);
  assert.equal(returned.length, 1);
  assert.ok(returned[0].price > 0, 'the return is expressed by the category, not the money');
  assert.match(out.warnings.join(' '), /returned line\(s\) still carry their original price/);
});

// --- Money: two independent checks, deliberately kept apart ------------------

test('both money checks pass on a well-formed receipt', () => {
  const out = normalize('savings.json');
  assert.equal(out.totals.subtotal, 219.25);
  assert.equal(out.totals.savings, 5, 'a POSITIVE number in the payload');
  assert.equal(out.totals.total, 215.55, 'that is SUBTRACTED: 219.25 + 0 - 5 + 1.30');
  assert.equal(out.totals.expectedTotal, 215.55);
  assert.equal(out.totals.subtotalMatch, true);
  assert.equal(out.totals.totalMatch, true);
  assert.equal(out.totals.reconciled, true);
});

test('fees are itemized and added after the subtotal', () => {
  const out = normalize('delivery-glass.json');
  assert.deepEqual(out.totals.fees, [{ label: 'Shipping', value: 5.16 }]);
  assert.equal(out.totals.feeTotal, 5.16);
  assert.equal(out.totals.expectedTotal, out.totals.total);
});

test('a missing line fails the ITEMS check only — we are missing data', () => {
  const out = normalize('items-check-fails.json');
  assert.equal(out.totals.sumOfItems, 147.21);
  assert.equal(out.totals.subtotal, 141.97);
  assert.equal(out.totals.subtotalMatch, false, 'lines overshoot: one was voided at the register');
  assert.equal(out.totals.totalMatch, true, 'but the totals still model correctly');
  assert.equal(out.totals.reconciled, false);
  assert.match(out.warnings.join(' '), /line items sum to 147\.21.*subtotal is 141\.97/);
});

test('an unmodelled charge fails the TOTAL check only — the payload is missing data', () => {
  const out = normalize('total-check-fails.json');
  assert.equal(out.totals.subtotalMatch, true, 'every line we were given is accounted for');
  assert.equal(out.totals.expectedTotal, 333.13);
  assert.equal(out.totals.total, 335.13, 'a $2.00 counter fee that appears in no fees[] row');
  assert.equal(out.totals.totalMatch, false);
  assert.match(out.warnings.join(' '), /unmodelled charge/);
});

test('group-level subtotal is ignored — it is always $0', () => {
  const payload = load('scan-and-go.json');
  assert.equal(payload.detail.groups_2101[0].subtotal.value, 0);
  assert.equal(adapter.normalize(payload).totals.subtotal, 39.66, 'order-level priceDetails is the only money');
});

// --- Groups ------------------------------------------------------------------

test('an order split across two fulfillment groups yields one item list', () => {
  const out = normalize('two-groups.json');
  assert.equal(out.source.groupCount, 2);
  assert.equal(out.totals.subtotalMatch, true, 'order-level priceDetails covers both groups');
  assert.ok(out.items.some((i) => i.groupIndex === 1), 'the second group contributed lines');
});

test('a shipped order has no club, and that is noted rather than treated as an error', () => {
  const out = normalize('delivery-glass.json');
  assert.equal(out.store.branch, null);
  assert.match(out.warnings.join(' '), /no club on any fulfillment group/);
  assert.equal(out.totals.reconciled, true, 'still a perfectly good receipt');
});

// --- Tender ------------------------------------------------------------------

test('card brands are case-normalized so they group', () => {
  // The payload writes Amex/AMEX and Visa/VISA interchangeably.
  const out = normalize('returned.json');
  assert.deepEqual(
    out.source.payment.map((p) => p.brand),
    ['SAMS CASH', 'AMEX']
  );
  assert.equal(out.source.payment[1].description, '*0000', 'card last-4 as printed');
  assert.equal(out.source.payment.reduce((a, p) => a + p.amount, 0).toFixed(2), out.totals.total.toFixed(2));
});

test('an order with no tender at all normalizes fine', () => {
  const out = normalize('tire-addons.json');
  assert.deepEqual(out.source.payment, []);
});

test('personal data is not copied out of the payload', () => {
  const out = normalize('delivery-glass.json');
  const text = JSON.stringify(out);
  // The fixture HAS a delivery address and a customer; the normalized receipt
  // must not carry them, whatever the payload holds.
  assert.ok(!/Ada|Member@|member@example/.test(text), 'no member name or email');
  assert.ok(!/1 Example Way/.test(text), 'no delivery address');
  assert.equal(out.source.customer, undefined);
});

// --- Half-present and moved-key payloads (traps 1 and 13) --------------------

test('a payload whose detail call failed yields a priceless but readable receipt', () => {
  const full = load('scan-and-go.json');
  const payload = { summary: full.summary, detailError: 'HTTP 500' };
  const out = adapter.normalize(payload);
  assert.equal(out.source.incomplete, true);
  assert.ok(out.items.length > 0, 'names and quantities survive');
  assert.ok(out.items.every((i) => i.price === null), 'but there are no prices');
  assert.equal(out.totals.subtotal, null);
  assert.equal(out.totals.incomplete, true);
  assert.match(out.warnings.join(' '), /detailError/);
  assert.match(out.warnings.join(' '), /no detail half/);
});

test('a moved groups_<version> key means "detail unavailable", not "an order with no items"', () => {
  const payload = load('scan-and-go.json');
  delete payload.detail.groups_2101; // the persisted-query hash went stale
  const out = adapter.normalize(payload);
  assert.equal(out.source.incomplete, true);
  assert.ok(out.items.length > 0, 'falls back to the summary projection instead of reporting zero items');
  assert.match(out.warnings.join(' '), /persisted-query hash may have gone stale/);
});

test('a renamed groups_<version> key is still read, with a warning', () => {
  const payload = load('scan-and-go.json');
  payload.detail.groups_2200 = payload.detail.groups_2101;
  delete payload.detail.groups_2101;
  const out = adapter.normalize(payload);
  assert.equal(out.source.incomplete, false);
  assert.equal(out.items.length, 4, 'the version suffix moved; the items did not');
  assert.equal(out.totals.reconciled, true);
  assert.match(out.warnings.join(' '), /came from "groups_2200"/);
});

test('normalize() never throws on a degenerate payload', () => {
  for (const payload of [{}, { summary: {} }, { detail: {} }, { summary: { items: [] }, detail: { groups_2101: [] } }]) {
    const out = adapter.normalize(payload);
    assert.ok(Array.isArray(out.items));
    assert.equal(out.totals.itemCount, out.items.length);
  }
});
