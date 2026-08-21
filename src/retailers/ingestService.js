'use strict';

// "Normalize a retailer receipt payload" service — the JSON counterpart of
// src/ocr + src/parse. Given a `kind: 'json'` receipt record, it reads the
// stored payload, runs the retailer's adapter, and returns the same canonical
// `{ store, items, totals }` the OCR path produces, so the pipeline's remaining
// stages (enrich, summarize) and everything after it (profiles, products,
// views) are shared verbatim.
//
// Pure JS — no Express, no Redis — so it is reused by the BullMQ worker (via
// src/pipeline) and directly testable. Mirrors receiptProfiles/applyService.js
// and products/resolveService.js.

const store = require('../store');
const registry = require('./registry');
const logger = require('../logger');

// Error with an HTTP-ish status so a sync caller can map it; inside the worker
// it just propagates and the job retries/fails.
class RetailerIngestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RetailerIngestError';
    this.status = status;
  }
}

/**
 * Validate an uploaded payload at REQUEST time, before a job is queued: the
 * retailer must be registered and the payload must look like that retailer's.
 * Returns `{ adapter, origin }`, where `origin` is the cheap provenance peek
 * (order id) used for the dedupe index and the accepted-response body.
 *
 * @throws {RetailerIngestError} 400 unknown retailer | 400 payload not recognized
 */
function acceptPayload(retailerId, payload) {
  const adapter = registry.get(retailerId);
  if (!adapter) {
    const known = registry.list().map((r) => r.id).join(', ') || 'none';
    throw new RetailerIngestError(400, `unknown retailer "${retailerId}" (registered: ${known})`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RetailerIngestError(400, 'receipt payload must be a JSON object');
  }
  if (!adapter.detect(payload)) {
    throw new RetailerIngestError(400, `payload does not look like a ${adapter.id} receipt`);
  }
  return { adapter, origin: peek(adapter, payload) };
}

/**
 * Cheap provenance peek used at upload time. Runs the adapter's own normalize
 * and keeps only the identity fields — adapters must not throw on a partial
 * payload, but if one does, an unidentified receipt is still ingestable.
 */
function peek(adapter, payload) {
  try {
    const { source } = adapter.normalize(payload, { retailerId: adapter.id });
    return {
      retailer: adapter.id,
      orderId: (source && source.orderId) || null,
      displayId: (source && source.displayId) || null,
      externalId: (source && source.externalId) || null,
    };
  } catch (err) {
    logger.warn({ retailer: adapter.id, err: err.message }, 'retailer payload peek failed; ingesting without provenance');
    return { retailer: adapter.id, orderId: null, displayId: null, externalId: null };
  }
}

/**
 * Read a JSON receipt's stored payload and normalize it. Called by the pipeline
 * in place of the OCR + parse stages.
 *
 * @param {object} record  a `kind: 'json'` receipt record
 * @returns {Promise<{ store, items, totals, source, warnings, provider }>}
 * @throws {RetailerIngestError} 422 when the record names an adapter that is gone
 */
async function normalizeReceipt(record) {
  const adapter = registry.get(record.retailer);
  if (!adapter) {
    // Validated at upload, but an adapter can be removed between then and now.
    throw new RetailerIngestError(422, `retailer adapter "${record.retailer}" is not available`);
  }

  const payload = await store.readDocument(record);
  const out = adapter.normalize(payload, {
    receiptId: record.id,
    retailerId: adapter.id,
    log: (msg, extra) => logger.info({ ...extra, receiptId: record.id, retailer: adapter.id }, msg),
  });

  return {
    store: out.store || null,
    items: out.items || [],
    totals: out.totals || null,
    source: out.source || null,
    warnings: out.warnings || [],
    provider: `retailer:${adapter.id}`,
  };
}

module.exports = { acceptPayload, normalizeReceipt, peek, RetailerIngestError };
