'use strict';

// Sam's Club receipt adapter.
//
// Input is the `{ summary, detail }` envelope assembled by the receipt-sync
// collector from two persisted GraphQL operations (PurchaseHistoryV2 and
// getOrder). The payload's shape, its traps, and the counts behind every
// judgement below are documented in docs/samsclub-receipt-schema.md, derived
// from 248 real payloads — read that file before changing this one.
//
// Traps this adapter deliberately handles (numbering follows §8 of the doc):
//   1. Items appear TWICE. `groups_2101[].items[]` is an 18-key projection with
//      no unitPrice/quantityString; `groups_2101[].categories[].items[]` is the
//      authoritative 68-key list. We read categories, and only fall back to the
//      projection (with a warning) when categories are absent.
//   2. `itemCount` is a display figure that disagrees with reality on 113/248
//      receipts. We count items ourselves and keep theirs as `reportedItemCount`.
//   3. `quantity` is 1 on lines sold by weight/volume; the measure lives in
//      `quantityString` and the rate in `priceInfo.unitPrice`. We take unitPrice
//      from the payload and NEVER recompute it as price/qty.
//   4. `groups_2101[].subtotal` is always $0 — order-level `priceDetails` is the
//      only money.
//   5/6. `status.statusType` and `statusCode: "2112"` carry no information; unread.
//   7/8. `discounts[]` is always empty; savings live in `priceDetails.savings`
//      as a POSITIVE number that is subtracted.
//   11. Add-ons are separately charged lines nested under their parent item and
//      counted in subTotal — flattened into the item list, or the receipt does
//      not add up.
//   13. `groups_2101` is version-suffixed and moves with the persisted-query
//      hash: a missing key means "detail unavailable", not "order with no items".

const { finalize } = require('../../parse/receiptParser');

const ID = 'samsclub.com';

// Fulfillment kinds seen across the corpus (§2). Used as a detection marker and
// surfaced on `source.fulfillment`; an unseen value is passed through, not rejected.
const FULFILLMENT_TYPES = new Set([
  'SCAN_AND_GO',
  'IN_STORE',
  'FUEL',
  'DELIVERY',
  'ELECTRONIC',
  'ACC_TIRE',
  'CURBSIDE',
  'SHIPPING',
]);

// Item prices should add to the printed subtotal, and subtotal+fees-savings+tax
// to the grand total. Same tolerance the OCR path uses for its subtotal check,
// which reproduces the doc's 247/248 and 246/248 pass rates exactly.
const MONEY_TOLERANCE = 0.02;

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Every money row in priceDetails is the same wrapper; only value/displayValue
// are ever populated (§4).
function money(row) {
  if (row === null || row === undefined) return null;
  if (typeof row === 'number') return row;
  return num(row.value);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function text(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

/**
 * Split a `quantityString` into its measure and unit: "1.66 lb" -> 1.66 + 'lb',
 * "13.324 gal" -> 13.324 + 'gal', "1" -> no unit (a plain count), "" -> null.
 * This is the ONLY reliable quantity for weighed and pumped lines (trap 3);
 * `quantityLabel` says "Qty" even on fuel and `salesUnitType` says "EACH" on all
 * 1,435 lines including the 191 that are not.
 */
function parseQuantityString(s) {
  const str = text(s);
  if (!str) return null;
  const m = str.match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)?$/);
  if (!m) return null;
  const value = num(m[1]);
  if (value === null) return null;
  return { value, unit: m[2] ? m[2].toLowerCase() : null };
}

// `cardType` is free-form and case-inconsistent across eras of the same system
// (Amex/AMEX, Visa/VISA) — normalize before anything groups on it (§4).
function cardBrand(v) {
  const s = text(v);
  return s ? s.toUpperCase().replace(/_/g, ' ') : null;
}

// SKU namespace flips with the channel: GLASS lines carry a catalogue
// `usItemId`, in-club lines carry a truncated receipt-tape `offerId` like
// "MINI CUCUMBE" (§5). Tag which one we got — they are not joinable.
function skuOf(productInfo) {
  const usItemId = text(productInfo && productInfo.usItemId);
  if (usItemId) return { sku: usItemId, skuKind: 'usItemId' };
  const offerId = text(productInfo && productInfo.offerId);
  if (offerId) return { sku: offerId, skuKind: 'offerId' };
  return { sku: null, skuKind: null };
}

function thumbnailOf(productInfo) {
  return text(productInfo && productInfo.imageInfo && productInfo.imageInfo.thumbnailUrl);
}

/** One authoritative `categories[].items[]` entry -> a canonical item. */
function itemFrom(raw, { returned, groupIndex }) {
  const productInfo = raw.productInfo || {};
  const priceInfo = raw.priceInfo || {};
  const { sku, skuKind } = skuOf(productInfo);
  const measured = parseQuantityString(raw.quantityString);
  const price = money(priceInfo.linePrice);
  const qty = num(raw.quantity);

  // A real row on the ticket that cost nothing — membership renewals and
  // removed produce lines, marked by an `additionalLines: [{name:'Voided'}]`.
  // Dropping them makes our ticket disagree with the paper one.
  const additional = Array.isArray(priceInfo.additionalLines) ? priceInfo.additionalLines : [];
  const informational = (qty === 0 || qty === null) && !price;

  return {
    // --- canonical (shared with the OCR path) ---
    description: text(productInfo.name) || '',
    sku,
    qty,
    // Straight from the payload. price/qty is wrong on 160 of 1,435 lines.
    unitPrice: money(priceInfo.unitPrice),
    price,
    enrichment: null,
    // --- additive, retailer-specific ---
    skuKind,
    quantityText: text(raw.quantityString),
    measuredQty: measured && measured.unit ? measured.value : null,
    unit: measured ? measured.unit : null,
    imageUrl: thumbnailOf(productInfo),
    lineId: text(raw.id),
    informational: informational || undefined,
    returned: returned || undefined,
    voided: additional.some((a) => /voided/i.test(String(a && a.name))) || undefined,
    groupIndex: groupIndex || undefined,
  };
}

/**
 * An `addOns[]` entry -> its own canonical line. Add-ons are separately charged
 * (tire installation, $39.98-$80.00) and ARE counted in subTotal, so a reader
 * that walks only the items reports a receipt that does not add up.
 * They carry `linePrice` only — no unitPrice — so unitPrice stays null rather
 * than being invented as price/qty.
 */
function addOnItemFrom(raw, parent) {
  const productInfo = raw.productInfo || {};
  const priceInfo = raw.priceInfo || {};
  const { sku, skuKind } = skuOf(productInfo);
  return {
    description: text(productInfo.name) || '',
    sku,
    qty: num(raw.quantity),
    unitPrice: null,
    price: money(priceInfo.linePrice),
    enrichment: null,
    skuKind,
    quantityText: text(raw.quantityString),
    measuredQty: null,
    unit: null,
    imageUrl: thumbnailOf(productInfo),
    lineId: text(raw.lineId),
    addOnOf: parent.sku || null,
    addOnType: text(raw.type),
  };
}

/** Items from the authoritative `categories[].items[]`, add-ons flattened in. */
function itemsFromGroups(groups, warnings) {
  const items = [];
  groups.forEach((group, groupIndex) => {
    const categories = Array.isArray(group.categories) ? group.categories : null;
    if (categories && categories.length) {
      for (const category of categories) {
        // A RETURNED category still lists the line at its ORIGINAL positive
        // price — the return is expressed by the category, not the money (§6).
        const returned = String(category && category.type).toUpperCase() === 'RETURNED';
        for (const raw of category.items || []) {
          const item = itemFrom(raw, { returned, groupIndex });
          items.push(item);
          for (const addOn of raw.addOns || []) items.push(addOnItemFrom(addOn, item));
        }
      }
      return;
    }
    // Fallback: the 18-key projection. Same items, but no unitPrice and no
    // quantityString, so weighed lines lose their rate and measure.
    const projected = Array.isArray(group.items) ? group.items : [];
    if (projected.length) {
      warnings.push(
        `group ${groupIndex} has no categories[]; read the lower-fidelity items[] projection (no unit prices)`
      );
      for (const raw of projected) {
        const item = itemFrom(raw, { returned: false, groupIndex });
        items.push(item);
        for (const addOn of raw.addOns || []) items.push(addOnItemFrom(addOn, item));
      }
    }
  });
  return items;
}

/**
 * Items from the summary half alone — names and quantities, no prices. Used
 * when the detail call failed at collection (`detailError`) or when
 * `groups_2101` has moved, so a half-present payload still yields a readable
 * receipt flagged `incomplete`.
 */
function itemsFromSummary(summary) {
  return (summary.items || []).map((raw) => {
    const { sku, skuKind } = skuOf(raw);
    return {
      description: text(raw.name) || '',
      sku,
      qty: num(raw.quantity),
      unitPrice: null,
      price: null,
      enrichment: null,
      skuKind,
      quantityText: null,
      measuredQty: null,
      unit: null,
      imageUrl: thumbnailOf(raw),
      lineId: text(raw.id),
    };
  });
}

/** The club this order was rung up at: the first group that names one (§6). */
function branchOf(groups) {
  for (const group of groups) {
    const store = group && group.store;
    if (!store) continue;
    const address = store.address || {};
    return {
      id: text(store.id),
      name: text(store.name),
      address: text(address.addressString),
      city: text(address.city),
      state: text(address.state),
      postalCode: text(address.postalCode),
    };
  }
  return null;
}

/**
 * Tender, so a synced receipt can say "MASTERCARD *7375" the way a photographed
 * one does. `description` is the card last-4 already printed on the paper
 * receipt; no other cardholder data is copied out of the payload.
 */
function paymentFrom(detail) {
  return (detail.paymentMethods || []).map((p) => ({
    brand: cardBrand(p.cardType),
    type: text(p.paymentType),
    description: text(p.description),
    amount: num((p.displayValues || [])[0]),
  }));
}

function totalsFrom(detail, items) {
  const priceDetails = (detail && detail.priceDetails) || {};
  const subtotal = money(priceDetails.subTotal);
  const tax = money(priceDetails.taxTotal);
  const total = money(priceDetails.grandTotal);

  const fees = (priceDetails.fees || [])
    .map((f) => ({ label: text(f.label), value: money(f) }))
    .filter((f) => f.value !== null);
  // A positive number that is SUBTRACTED (§7). Same for refund rows.
  const savings = money(priceDetails.savings);
  const refunds = (priceDetails.refund || [])
    .map((r) => ({ label: text(r.label), value: money(r) }))
    .filter((r) => r.value !== null);

  // `finalize` computes itemCount / sumOfItems / subtotalMatch identically to
  // the OCR path — subtotalMatch IS the doc's "items" check.
  const base = finalize(null, items, { subtotal, tax, total });

  const feeTotal = round2(fees.reduce((acc, f) => acc + f.value, 0));
  // The second, independent check: is there a charge we are not modelling?
  // Keeping it apart from the items check matters — a failed items check means
  // we are missing data, a failed total check means the payload is (§7).
  const expectedTotal =
    subtotal === null || total === null
      ? null
      : round2(subtotal + feeTotal - (savings || 0) + (tax || 0));
  const totalMatch = expectedTotal === null ? null : Math.abs(expectedTotal - total) <= MONEY_TOLERANCE;

  return {
    ...base.totals,
    fees,
    feeTotal,
    savings,
    refunds: refunds.length ? refunds : undefined,
    expectedTotal,
    totalMatch,
    // "Reconciled" in the sync tool's sense: both checks pass.
    reconciled: base.totals.subtotalMatch === null || totalMatch === null
      ? null
      : base.totals.subtotalMatch && totalMatch,
    reportedItemCount: num(detail && detail.itemCount),
    currency: 'USD',
  };
}

/** Cheap "is this plausibly a Sam's Club payload?" check — runs at upload. */
function detect(payload) {
  if (!isObject(payload)) return false;
  const summary = isObject(payload.summary) ? payload.summary : null;
  const detail = isObject(payload.detail) ? payload.detail : null;
  if (!summary && !detail) return false;
  const orderId = (summary && (summary.orderId || summary.purchaseOrderId)) || (detail && detail.id);
  if (!orderId) return false;
  // At least one marker only this payload shape has.
  return !!(
    (detail && Object.keys(detail).some((k) => k.startsWith('groups_'))) ||
    (summary && summary.derivedFulfillmentType) ||
    (summary && FULFILLMENT_TYPES.has(String(summary.fulfillmentType))) ||
    payload.detailError
  );
}

/** The versioned items container (§1): `groups_2101` today, `groups_<n>` later. */
function groupsKeyOf(detail) {
  return Object.keys(detail).find((k) => /^groups_\d+$/.test(k)) || null;
}

function normalize(payload, ctx = {}) {
  const warnings = [];
  const summary = isObject(payload && payload.summary) ? payload.summary : {};
  const detail = isObject(payload && payload.detail) ? payload.detail : null;

  const orderId = text(summary.orderId) || text(summary.purchaseOrderId) || text(detail && detail.id);
  const displayId = text(detail && detail.displayId) || text(summary.displayId);

  if (payload && payload.detailError) {
    warnings.push('collector reported detailError: the order-detail call failed, so this receipt has no prices');
  }

  let groups = [];
  if (!detail) {
    warnings.push('payload has no detail half; read the summary projection (names and quantities only)');
  } else {
    const groupsKey = groupsKeyOf(detail);
    if (!groupsKey) {
      // NOT "an order with no items" — the versioned key moved (§1, trap 13).
      warnings.push('detail has no groups_<version> key; treating detail as unavailable (the persisted-query hash may have gone stale)');
    } else {
      if (groupsKey !== 'groups_2101') {
        warnings.push(`detail items came from "${groupsKey}", not the expected "groups_2101"`);
      }
      groups = Array.isArray(detail[groupsKey]) ? detail[groupsKey] : [];
    }
  }

  const usingDetail = groups.length > 0;
  const items = usingDetail ? itemsFromGroups(groups, warnings) : itemsFromSummary(summary);
  const incomplete = !usingDetail;

  const branch = usingDetail ? branchOf(groups) : null;
  if (usingDetail && !branch) {
    // Shipped, delivered and electronic groups have no club — expected, not an error.
    warnings.push('no club on any fulfillment group (shipped, delivered or electronic order)');
  }

  // The account's offset, not the club's (trap 12) — but it is what the payload
  // asserts, so the receipt date is read in the offset the payload carries.
  const orderDate = text(detail && detail.orderDate);
  const date = orderDate ? orderDate.slice(0, 10) : null;

  const totals = incomplete
    ? { ...finalize(null, items, { subtotal: null, tax: null, total: null }).totals, incomplete: true, currency: 'USD' }
    : totalsFrom(detail, items);

  if (totals.subtotalMatch === false) {
    warnings.push(`line items sum to ${totals.sumOfItems} but the receipt's subtotal is ${totals.subtotal} — a line may be voided or missing`);
  }
  if (totals.totalMatch === false) {
    warnings.push(`subtotal + fees - savings + tax = ${totals.expectedTotal} but the receipt's total is ${totals.total} — an unmodelled charge`);
  }

  const returnedCount = items.filter((i) => i.returned).length;
  if (returnedCount) {
    warnings.push(`${returnedCount} returned line(s) still carry their original price — the line sum is what was paid, not what it cost`);
  }

  const channel = text(summary.type) || text(detail && detail.type);
  const fulfillment = text(summary.fulfillmentType) || text(summary.derivedFulfillmentType);

  if (ctx.log) {
    ctx.log('samsclub payload normalized', {
      orderId,
      items: items.length,
      groups: groups.length,
      incomplete,
      warnings: warnings.length,
    });
  }

  return {
    store: {
      // The canonical chain name, matching src/parse/store-aliases.json, so a
      // synced receipt groups with a photographed one. The club is on `branch`.
      name: "Sam's Club",
      date,
      branch,
      channel,
      fulfillment,
    },
    items,
    totals,
    source: {
      retailer: ID,
      orderId,
      displayId,
      externalId: orderId ? `${ID}:${orderId}` : null,
      orderDate,
      timezone: text(detail && detail.timezone),
      channel,
      fulfillment,
      groupCount: groups.length,
      isFuelPurchase: !!(detail && detail.isFuelPurchase),
      isExchange: !!(detail && detail.isExchange),
      payment: detail ? paymentFrom(detail) : [],
      incomplete,
    },
    warnings,
  };
}

module.exports = {
  id: ID,
  aliases: ['samsclub', 'sams-club', "sam's club", 'samsclub.com', 'www.samsclub.com'],
  meta: {
    name: "Sam's Club",
    storeName: "Sam's Club",
    schema: 'docs/samsclub-receipt-schema.md',
    payload: '{ summary, detail } — PurchaseHistoryV2 + getOrder, assembled by the collector',
    channels: ['IN_STORE', 'GLASS'],
  },
  detect,
  normalize,
};
