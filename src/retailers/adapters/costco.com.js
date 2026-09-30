'use strict';

// Costco receipt adapter.
//
// Input is ONE receipt exactly as Costco's order API returns it -
// `receiptsWithCounts(barcode, documentType: 'all').receipts[0]`, or the same
// object from the bulk `receipts(startDate, endDate)` call - collected in the
// member's own browser by the Recibbi Link add-on and posted verbatim. The
// field set is the one ../recibbi-serverside-integration-costco verified live.
// docs/costco-receipt-schema.md holds the measurements behind every judgement
// below, taken over 216 real receipts (138 in-warehouse, 78 gas).
//
// What the corpus settled, and this adapter relies on:
//   1. `itemArray[].amount` sums to `subTotal` on 216/216 receipts, and
//      `subTotal + taxes == total` on 216/216. `instantSavings` is a SUMMARY of
//      discounts already inside the item lines - subtracting it again would
//      double-count every coupon.
//   2. Instant savings are separate item lines: negative `amount`, `unit: -1`,
//      and a description starting with "/". `frenchItemDescription1` carries
//      "/<parent itemNumber>" and the parent was on the same receipt 86/86
//      times. Each is FOLDED into its parent (price = what was paid), so the
//      member's books and the product catalogue see one line per product and
//      enrichment is never asked to look up a coupon.
//   3. `itemUnitPriceAmount` is the SHELF rate, not amount/unit: on weighed
//      lines it is per-pound (BEEF FLANK 9.99, amount 27.77, unit 1). It is
//      taken as given and never recomputed - 69 of 1044 lines would be wrong.
//   4. Gas receipts carry exactly one line, with the gallons in
//      `fuelUnitQuantity` and the grade in `fuelGradeDescription`.
//   5. A return is its own transaction (`transactionType: 'Refund'`) with
//      negative money throughout, not a flag on the original sale.
//   6. `transactionBarcode` identifies a transaction; every public Costco tool
//      keys on it. It is the order id here, which is what the engine dedupes on.

const { finalize } = require('../../parse/receiptParser');

const ID = 'costco.com';

const DOCUMENT_TYPES = new Set(['WarehouseReceiptDetail', 'FuelReceipts']);

// Same tolerance the OCR path and the Sam's Club adapter use.
const MONEY_TOLERANCE = 0.02;

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function text(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** An instant-savings line (§2): negative, and described "/<something>". */
function isDiscount(raw, refund) {
  if (refund) return false; // on a refund every line is negative
  const amount = num(raw.amount);
  return amount !== null && amount < 0 && /^\//.test(text(raw.itemDescription01) || '');
}

/** The itemNumber a discount line applies to, read off its "/<n>" reference. */
function discountTarget(raw) {
  for (const field of [raw.frenchItemDescription1, raw.itemDescription01]) {
    const m = (text(field) || '').match(/^\/\s*(\d+)$/);
    if (m) return m[1];
  }
  return null;
}

function itemFrom(raw, { refund }) {
  const fuel = num(raw.fuelUnitQuantity) !== null && text(raw.fuelGradeCode) !== null;
  const unitPrice = num(raw.itemUnitPriceAmount);
  return {
    description: text(raw.itemDescription01) || '',
    sku: text(raw.itemNumber),
    qty: num(raw.unit),
    // The shelf rate as printed (§3) - per pound on weighed lines, per gallon
    // on fuel. Zero means "not stated", not free.
    unitPrice: unitPrice ? unitPrice : null,
    price: num(raw.amount),
    enrichment: null,
    skuKind: 'itemNumber',
    // Pack size and count, e.g. "24/500ML 16.9OZ" - the second receipt line.
    detail: text(raw.itemDescription02),
    department: num(raw.itemDepartmentNumber),
    taxFlag: text(raw.taxFlag),
    measuredQty: fuel ? num(raw.fuelUnitQuantity) : null,
    unit: fuel ? (text(raw.fuelUomCode) || 'gal').toLowerCase() : null,
    fuelGrade: fuel ? text(raw.fuelGradeDescription) : undefined,
    returned: refund || undefined,
  };
}

/** Item lines, with each instant-savings line folded into the item it discounts (§2). */
function itemsFrom(receipt, refund, warnings) {
  const raws = Array.isArray(receipt.itemArray) ? receipt.itemArray.filter(isObject) : [];
  const items = [];
  const discounts = [];
  for (const raw of raws) {
    if (isDiscount(raw, refund)) discounts.push(raw);
    else items.push(itemFrom(raw, { refund }));
  }

  for (const raw of discounts) {
    const target = discountTarget(raw);
    const amount = num(raw.amount);
    // The LAST matching line without a discount yet: the coupon prints under
    // the item it applies to, and the same product can be rung up twice.
    const parent = target
      ? [...items].reverse().find((i) => i.sku === target && !i.savings) ||
        [...items].reverse().find((i) => i.sku === target)
      : null;
    if (parent && parent.price !== null) {
      parent.grossPrice = parent.grossPrice ?? parent.price;
      parent.savings = round2((parent.savings || 0) - amount);
      parent.price = round2(parent.price + amount);
      parent.couponNumber = text(raw.itemNumber);
      continue;
    }
    warnings.push(`instant savings line ${text(raw.itemDescription01)} names no item on this receipt; kept as its own line`);
    items.push({ ...itemFrom(raw, { refund }), sku: null, skuKind: null, discount: true });
  }
  return items;
}

function paymentFrom(receipt) {
  return (Array.isArray(receipt.tenderArray) ? receipt.tenderArray : []).filter(isObject).map((t) => ({
    // Card brand for a card, the tender code otherwise ("064" is a
    // numeric code on older receipts; nothing public maps it).
    brand: text(t.tenderSubTypeCode),
    type: text(t.tenderTypeCode),
    description: text(t.tenderDescription) || text(t.tenderTypeName),
    entryMethod: text(t.tenderEntryMethodDescription),
    amount: num(t.amountTender),
  }));
}

function detect(payload) {
  if (!isObject(payload)) return false;
  if (!text(payload.transactionBarcode)) return false;
  // At least one marker only this payload shape has.
  return !!(
    DOCUMENT_TYPES.has(String(payload.documentType)) ||
    (Array.isArray(payload.itemArray) && payload.itemArray.some((i) => isObject(i) && 'itemDescription01' in i))
  );
}

function normalize(payload, ctx = {}) {
  const warnings = [];
  const receipt = isObject(payload) ? payload : {};
  const barcode = text(receipt.transactionBarcode);
  const refund = /refund|return/i.test(String(receipt.transactionType || ''));
  const fuel = receipt.documentType === 'FuelReceipts';

  const items = itemsFrom(receipt, refund, warnings);
  if (!items.length) warnings.push('receipt carries no line items');

  const subtotal = num(receipt.subTotal);
  const tax = num(receipt.taxes);
  const total = num(receipt.total);
  const base = finalize(null, items, { subtotal, tax, total }).totals;
  const expectedTotal = subtotal === null ? null : round2(subtotal + (tax || 0));
  const totalMatch = expectedTotal === null || total === null ? null : Math.abs(expectedTotal - total) <= MONEY_TOLERANCE;

  const totals = {
    ...base,
    // A summary of the coupons already inside the lines (§1) - reported, never
    // subtracted.
    savings: num(receipt.instantSavings) || 0,
    expectedTotal,
    totalMatch,
    reconciled: base.subtotalMatch === null || totalMatch === null ? null : base.subtotalMatch && totalMatch,
    reportedItemCount: num(receipt.totalItemCount),
    currency: 'USD',
  };
  if (totals.subtotalMatch === false) {
    warnings.push(`line items sum to ${totals.sumOfItems} but the receipt's subtotal is ${subtotal}`);
  }
  if (totalMatch === false) {
    warnings.push(`subtotal + tax = ${expectedTotal} but the receipt's total is ${total}`);
  }

  // `transactionDateTime` is the warehouse's local time with no offset; the
  // date on the paper receipt is its first ten characters.
  const at = text(receipt.transactionDateTime) || text(receipt.transactionDate);
  const date = at ? at.slice(0, 10) : null;
  const channel = text(receipt.receiptType);

  if (ctx.log) {
    ctx.log('costco payload normalized', { orderId: barcode, items: items.length, fuel, refund, warnings: warnings.length });
  }

  return {
    store: {
      // The canonical chain name (src/parse/store-aliases.json), so a synced
      // receipt groups with a photographed "COSTCO WHOLESALE" one.
      name: 'Costco',
      date,
      branch: {
        id: text(receipt.warehouseNumber),
        name: text(receipt.warehouseName),
        address: text(receipt.warehouseAddress1),
        city: text(receipt.warehouseCity),
        state: text(receipt.warehouseState),
        postalCode: text(receipt.warehousePostalCode),
      },
      channel,
      fulfillment: fuel ? 'FUEL' : 'IN_STORE',
    },
    items,
    totals,
    // No membershipNumber, no card digits, no authorization codes: provenance,
    // not personal data.
    source: {
      retailer: ID,
      orderId: barcode,
      displayId: barcode,
      externalId: barcode ? `${ID}:${barcode}` : null,
      orderDate: at,
      channel,
      documentType: text(receipt.documentType),
      transactionType: text(receipt.transactionType),
      warehouseNumber: text(receipt.warehouseNumber),
      registerNumber: text(receipt.registerNumber),
      transactionNumber: text(receipt.transactionNumber),
      isFuelPurchase: fuel,
      isRefund: refund,
      payment: paymentFrom(receipt),
    },
    warnings,
  };
}

module.exports = {
  id: ID,
  aliases: ['costco', 'costco wholesale', 'costco.com', 'www.costco.com'],
  meta: {
    name: 'Costco',
    storeName: 'Costco',
    schema: 'docs/costco-receipt-schema.md',
    payload: "one receipt as Costco's order API returns it (receiptsWithCounts by barcode, or receipts)",
    channels: ['In-Warehouse', 'Gas Station'],
  },
  detect,
  normalize,
};
