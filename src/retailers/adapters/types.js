'use strict';

// The retailer adapter contract — documentation only. This module is NOT
// registered (src/retailers/registry.js skips `types.js`, mirroring how the
// transformer and product-resolver registries skip theirs).
//
// A retailer adapter turns ONE retailer's own order/receipt JSON into the
// engine's canonical parsed shape — the same `{ store, items, totals }` that
// src/parse/receiptParser.js produces from OCR text. Because the output is
// canonical, everything downstream of extraction (enrichment, summary, receipt
// profiles, product resolution, the web views) is shared with the photo path
// and needs no retailer-specific code.
//
// Adapters are shipped WITH the app and selected by the retailer id in the
// request URL (`/api/retailer:<id>/receipts`) via a Map lookup — request input
// never becomes a module path, so there is no RCE surface.
//
// An adapter module exports:
//
//   id       {string}    canonical retailer id, domain-shaped: 'samsclub.com'
//   aliases  {string[]}  other accepted ids, e.g. ['samsclub', "sam's club"]
//   meta     {object}    { name, storeName, schema, channels? } — public listing
//   detect   {(payload) => boolean}
//              Cheap shape check answering "is this plausibly OUR payload?".
//              Runs SYNCHRONOUSLY at upload so a mis-routed payload gets a 400
//              instead of a job that fails three times. Be permissive about
//              optional halves, strict about markers unique to this retailer.
//   normalize{(payload, ctx) => NormalizedReceipt}
//              Full extraction. Runs in the WORKER, inside `process-receipt`.
//              Must not throw on a partial payload — degrade and warn instead.
//
// ctx: { receiptId, retailerId, log(msg, extra) }
//
// NormalizedReceipt:
//   store   {{ name, date, ...extras }|null}
//             `name` should be the CANONICAL chain name (matching
//             src/parse/store-aliases.json) so JSON and photographed receipts
//             from the same chain group together. `date` is `YYYY-MM-DD`.
//             Extras (branch, channel, fulfillment, ...) are additive.
//   items   {Array<CanonicalItem>}
//   totals  {{ subtotal, tax, total, ...extras }}
//             Pass through `finalize()` from src/parse/receiptParser.js so
//             `itemCount`, `sumOfItems` and `subtotalMatch` are computed the
//             same way as on the OCR path, then merge retailer extras on top.
//   source  {object}  provenance: order id, channel, tender, externalId.
//                     Adapters should NOT copy personal data (member name,
//                     address, phone, email) out of the payload.
//   warnings{string[]} human-readable notes about what the payload lacked.
//
// CanonicalItem (the five canonical fields every consumer relies on, plus any
// number of additive retailer fields):
//   { description, sku, qty, unitPrice, price, enrichment: null, ...extras }

module.exports = {};
