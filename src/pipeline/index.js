'use strict';

const config = require('../config');
const store = require('../store');
const ocr = require('../ocr');
const parser = require('../parse/receiptParser');
const retailerIngest = require('../retailers/ingestService');
const { enrichItems } = require('../enrich');
const identity = require('../identity');
const catalogue = require('../catalogue');
const logger = require('../logger');

function money(n) {
  return n === null || n === undefined ? 'n/a' : `$${Number(n).toFixed(2)}`;
}

function buildSummary(record) {
  const storeName = record.store?.name || 'Unknown store';
  const date = record.store?.date ? ` on ${record.store.date}` : '';
  const { itemCount, subtotal, total, sumOfItems } = record.totals;
  const enrichedCount = record.items.filter((i) => i.enrichment && i.enrichment.imageUrl).length;
  const totalStr = total != null ? money(total) : money(sumOfItems) + ' (summed from items)';
  // Flag a *shortfall*: items summing to less than the printed subtotal is a
  // hint that a line was missed during extraction. An overage is expected when
  // the model excludes a discount/savings line, so it isn't flagged.
  const warn = subtotal != null && sumOfItems + 0.02 < subtotal
    ? ` ⚠ items sum to ${money(sumOfItems)} — under the ${money(subtotal)} subtotal (a line may be missing)`
    : '';
  // A photographed receipt is enriched to get product images; a retailer payload
  // arrives with its own, so saying "0 matched" there would read as a failure.
  const enrichNote = record.kind === 'json' && !enrichedCount
    ? ''
    : ` ${enrichedCount} item(s) matched with images/metadata.`;
  return `${storeName}${date}: ${itemCount} item(s), total ${totalStr}.${enrichNote}${warn}`;
}

/**
 * Stage 1 for a photographed receipt: OCR the bytes, then parse the text (or the
 * vision model's structured output) into the canonical shape.
 */
async function extractFromImage(record) {
  const { rawText, structured, provider, reader } = await ocr.extract(record);
  const parsed = structured
    ? parser.normalizeStructured(structured, rawText)
    : parser.parseText(rawText);
  const extraction = { provider, rawText: rawText ? rawText.slice(0, 20000) : null };
  // Which model read it, when a vision reader did: the order can put a
  // different one first from one receipt to the next.
  if (reader) extraction.reader = reader;
  return { parsed, extraction };
}

/**
 * Stage 1 for a retailer JSON receipt: no OCR at all — the retailer's adapter
 * normalizes its own payload straight into the canonical shape. The payload IS
 * the extraction, so `rawText` stays null and the adapter's warnings ride along
 * on the record (a half-present payload, an unmodelled charge, a returned line).
 */
async function extractFromDocument(record) {
  const out = await retailerIngest.normalizeReceipt(record);
  return {
    parsed: { store: out.store, items: out.items, totals: out.totals },
    extraction: {
      provider: out.provider,
      rawText: null,
      retailer: record.retailer,
      source: out.source,
      warnings: out.warnings,
    },
  };
}

// Whether to run the enrichment stage for this receipt. Set per-upload at
// creation (`options.enrich`); a record without the field — every receipt
// written before retailer ingest existed — enriches, as it always did.
function wantsEnrichment(record) {
  return !(record.options && record.options.enrich === false);
}

// Where enrichment looks first for this receipt: 'retailer' or 'web'.
//
// READ OFF THE RECORD, NEVER OFF THE MEMBER'S CURRENT SETTINGS, and that is the
// point rather than a shortcut. The answer was resolved once when the receipt
// was accepted (src/ingest/acceptService.js) and frozen here, so a retry, a
// re-normalization after an adapter improvement, or any other second pass reads
// a receipt exactly as it was read the first time. That is what makes the
// Settings screen's "applies to receipts imported from here on" true of the
// system rather than merely true of the happy path.
//
// Absent means 'web': every receipt written before this existed was enriched by
// the web search, so absence describes those records correctly.
function enrichmentSource(record) {
  return record.options && record.options.enrichSource === 'retailer' ? 'retailer' : 'web';
}

/**
 * Run the full pipeline for a receipt id, updating the durable record at each
 * stage so progress is observable even if a later stage fails.
 *
 * Stage 1 has two implementations selected by `record.kind` — OCR for a photo,
 * a retailer adapter for a JSON payload. Both produce the same canonical
 * `{ store, items, totals }`, so stages 2-4 are shared.
 */
async function processReceipt(receiptId) {
  const t0 = Date.now();
  await store.update(receiptId, { status: 'processing', error: null });

  // 1. Extraction (OCR for an image, retailer adapter for a JSON payload)
  const extractStart = Date.now();
  const record = await store.get(receiptId);
  const isDocument = record.kind === 'json';
  const { parsed, extraction } = isDocument
    ? await extractFromDocument(record)
    : await extractFromImage(record);
  await store.update(receiptId, {
    extraction,
    timings: { ocrMs: Date.now() - extractStart },
  });

  // 2. Canonical structure (already canonical on the document path)
  await store.update(receiptId, {
    store: parsed.store,
    items: parsed.items,
    totals: parsed.totals,
  });
  logger.info(
    { id: receiptId, items: parsed.items.length, provider: extraction.provider },
    isDocument ? 'normalized receipt payload' : 'parsed receipt'
  );

  // 3. Enrich items (Tavily); mutates items in place. The enrichment cache is
  // tenant-scoped, so pass the receipt's tenant (parsed from its composite id).
  // Optional per receipt: retailer payloads already carry product names and
  // their own thumbnails, so enrichment is off by default for them.
  const enrichStart = Date.now();
  const items = parsed.items;
  if (wantsEnrichment(record)) {
    const { tenantId } = identity.scopeOf(receiptId);
    const source = enrichmentSource(record);
    const enrichStats = await enrichItems(items, parsed.store?.name, { tenantId, source });
    logger.info({ id: receiptId, source, ...enrichStats }, 'enrichment complete');
  } else {
    logger.info({ id: receiptId, items: items.length }, 'enrichment skipped for this receipt');
  }
  const current = await store.get(receiptId);
  current.items = items;
  current.timings = { ...current.timings, enrichMs: Date.now() - enrichStart };
  await store.save(current);

  // 4. Summarize and finalize
  const finalRecord = await store.get(receiptId);
  // Every line with no category gets one -- the one the member's books already
  // give the same product, else one batched model call -- so the receipt's
  // products arrive in the Products screen's category list with it. Before the
  // remembered names, so a category the member gave a product is the one that
  // stands. Never throws. See src/catalogue/categorize.js.
  const categorized = await catalogue.categorizeReceipt(finalRecord);
  if (categorized) logger.info({ id: receiptId, lines: categorized }, 'categorized lines that had no category');
  // A product the member has named before is named the same way here, before
  // the receipt is done -- so the receipt page and the Products card both say
  // what the member said, from the first look. Never throws.
  const remembered = await catalogue.applyRememberedNames(finalRecord);
  if (remembered) logger.info({ id: receiptId, lines: remembered }, 'applied names the member gave these products before');
  finalRecord.summary = buildSummary(finalRecord);
  finalRecord.status = 'done';
  finalRecord.timings = { ...finalRecord.timings, totalMs: Date.now() - t0 };
  await store.save(finalRecord);

  // 5. File its products in the member's catalogue: one purchase row per
  // product on this receipt. AFTER the receipt is done and saved -- the rows are
  // a projection of the record, so the record has to be final first -- and
  // best-effort: a receipt that read perfectly is not failed because its
  // products could not be filed. A miss is drift that `scripts/catalogue.js
  // verify` names and `backfill` repairs. See docs/CATALOGUE.md.
  await catalogue.indexReceiptSafely(finalRecord);

  // 6. Drop the raw payload if this deployment keeps only the normalized record.
  if (isDocument && !config.retailers.storeRawPayload) {
    return store.discardDocument(receiptId);
  }
  return finalRecord;
}

module.exports = { enrichmentSource, processReceipt };
