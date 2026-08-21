'use strict';

const fsp = require('fs/promises');
const path = require('path');
const identity = require('./identity');
const persistence = require('./persistence');

// Receipt records are durable DOCUMENTS keyed by identity, persisted through the
// pluggable persistence layer (src/persistence — filesystem or sqlite):
//   kind='receipts', { tenant, user, id: cacheId }
// A receipt's public `id` is the COMPOSITE id `<tenant>:<user>:<cacheId>`, which
// the store parses (src/identity.js) to derive the document key.
//
// Uploaded blobs are NOT records — they always live on the filesystem at
// `<dataDir>/<tenant>/<user>/uploads/<cacheId>.<ext>` regardless of persistence
// backend (a dedicated blob-store abstraction comes later). `imagePathFor` and
// `createReceipt`'s image write therefore stay on fs/promises.
//
// A receipt has a `kind`, which decides what its blob is and which extraction
// path the pipeline runs:
//   'image' - a photographed receipt; blob is the photo, described by `image`.
//             Extracted by OCR (src/ocr) and parsed heuristically.
//   'json'  - a retailer's own receipt payload posted to
//             /api/retailer:<id>/receipts; blob is the payload, described by
//             `document`. Normalized by a retailer adapter (src/retailers).
// Records written before `kind` existed have none; absent means 'image'.

function newId() {
  return identity.newCacheId();
}

function uploadsDir(scope) {
  return identity.userDataDir(scope, 'uploads');
}

// Resolve a composite (or bare) id to its persistence key, or null if the id is
// malformed (so callers surface a clean 404 rather than throwing).
function keyOf(id) {
  try {
    const r = identity.resolveId(id);
    return { kind: 'receipts', tenant: r.tenantId, user: r.userId, id: r.cacheId };
  } catch {
    return null;
  }
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/json': '.json',
};

function extForMime(mime, fallbackName) {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const ext = fallbackName ? path.extname(fallbackName) : '';
  return ext || '.img';
}

// Write the uploaded bytes as this receipt's blob and build the record skeleton
// every kind shares. `blobKey` is the record field describing the blob
// ('image' or 'document'), so the two kinds stay distinguishable without either
// having to read the other's field.
async function create({ kind, blobKey, buffer, mimeType, originalName, source, tenantId, userId, extra }) {
  const def = identity.defaultScope();
  const scope = { tenantId: tenantId || def.tenantId, userId: userId || def.userId };
  const cacheId = newId();
  const id = identity.buildId(scope.tenantId, scope.userId, cacheId); // validates scope
  const file = `${cacheId}${extForMime(mimeType, originalName)}`;

  await fsp.mkdir(uploadsDir(scope), { recursive: true });
  await fsp.writeFile(path.join(uploadsDir(scope), file), buffer);

  const now = new Date().toISOString();
  const record = {
    id,
    tenantId: scope.tenantId,
    userId: scope.userId,
    kind,
    status: 'queued', // queued | processing | done | failed
    source: source || 'api',
    createdAt: now,
    updatedAt: now,
    [blobKey]: {
      file,
      mimeType: mimeType || 'application/octet-stream',
      originalName: originalName || null,
      size: buffer.length,
    },
    extraction: { provider: null, rawText: null },
    store: null, // { name, date }
    items: [], // [{ description, sku, qty, unitPrice, price, enrichment }]
    totals: null, // { subtotal, tax, total, itemCount, sumOfItems }
    summary: null,
    error: null,
    timings: {},
    ...extra,
  };
  await save(record);
  return record;
}

/**
 * Persist an uploaded image buffer and create the initial receipt record under
 * the given identity. `tenantId`/`userId` default to the configured identity.
 * @returns {Promise<object>} the created record (its `id` is the composite id)
 */
async function createReceipt({ buffer, mimeType, originalName, source, tenantId, userId, options }) {
  return create({
    kind: 'image',
    blobKey: 'image',
    buffer,
    mimeType,
    originalName,
    source,
    tenantId,
    userId,
    extra: options ? { options } : {},
  });
}

/**
 * Persist a retailer's receipt JSON and create the record for it. The payload is
 * stored as the receipt's blob (the JSON counterpart of the photo) so the worker
 * can normalize it out-of-band and so a receipt can be re-normalized later when
 * its adapter improves — see docs/RETAILER-INGEST.md.
 *
 * @param {object}   args
 * @param {Buffer}   args.payload    raw payload bytes, exactly as uploaded
 * @param {string}   args.retailer   canonical retailer id ('samsclub.com')
 * @param {object}   [args.origin]   provenance peeked at upload (orderId, externalId)
 * @param {object}   [args.options]  per-receipt pipeline options, e.g. { enrich }
 */
async function createRetailerReceipt({ payload, retailer, originalName, source, tenantId, userId, origin, options }) {
  return create({
    kind: 'json',
    blobKey: 'document',
    buffer: payload,
    mimeType: 'application/json',
    originalName,
    source,
    tenantId,
    userId,
    extra: {
      retailer,
      origin: origin || null,
      ...(options ? { options } : {}),
    },
  });
}

async function save(record) {
  const key = keyOf(record.id);
  if (!key) throw new identity.IdentityError(400, `cannot save record with invalid id "${record.id}"`);
  record.updatedAt = new Date().toISOString();
  await persistence.put(key, record);
  return record;
}

async function get(id) {
  const key = keyOf(id);
  if (!key) return null; // malformed id -> treat as not found
  return persistence.get(key);
}

/**
 * Read-modify-write merge. Single-worker concurrency keeps this safe for the
 * scaffold; for multi-worker setups switch to a record-level lock.
 */
async function update(id, patch) {
  const current = await get(id);
  if (!current) throw new Error(`receipt ${id} not found`);
  const next = { ...current, ...patch };
  return save(next);
}

/**
 * List a single identity's receipts, newest first. Scope defaults to the
 * configured identity (so single-tenant callers pass only `{ limit }`).
 */
async function list({ tenantId, userId, limit = 50 } = {}) {
  const def = identity.defaultScope();
  const scope = { tenantId: tenantId || def.tenantId, userId: userId || def.userId };
  let records;
  try {
    records = await persistence.list({ kind: 'receipts', tenant: scope.tenantId, user: scope.userId });
  } catch {
    return []; // invalid scope -> nothing to list
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return records.slice(0, limit);
}

/** Absolute path of a receipt's blob, whichever kind it is. */
function blobPathFor(record) {
  const { tenantId, userId } = identity.resolveId(record.id);
  const blob = record.image || record.document;
  if (!blob || !blob.file) throw new Error(`receipt ${record.id} has no stored blob`);
  return path.join(uploadsDir({ tenantId, userId }), blob.file);
}

function imagePathFor(record) {
  const { tenantId, userId } = identity.resolveId(record.id);
  return path.join(uploadsDir({ tenantId, userId }), record.image.file);
}

function documentPathFor(record) {
  const { tenantId, userId } = identity.resolveId(record.id);
  return path.join(uploadsDir({ tenantId, userId }), record.document.file);
}

/** Read and parse a `kind: 'json'` receipt's stored payload. */
async function readDocument(record) {
  if (!record || !record.document || !record.document.file) {
    throw new Error(`receipt ${record && record.id} has no stored document payload`);
  }
  if (record.document.discarded) {
    throw new Error(`receipt ${record.id}'s payload was discarded after processing (RETAILER_STORE_RAW_PAYLOAD=0)`);
  }
  return JSON.parse(await fsp.readFile(documentPathFor(record), 'utf8'));
}

/**
 * Delete a processed payload from disk, leaving the normalized record. Used when
 * RETAILER_STORE_RAW_PAYLOAD is off: retailer payloads carry personal data
 * (member name, address, phone, email, card last-4) that nothing downstream
 * reads, so a deployment can choose not to keep it once it has been normalized.
 * Marks the record rather than dropping `document`, so the receipt still says
 * what it came from. Best-effort: a missing file is already the desired state.
 */
async function discardDocument(id) {
  const record = await get(id);
  if (!record || !record.document || record.document.discarded) return record;
  try {
    await fsp.unlink(documentPathFor(record));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return update(id, { document: { ...record.document, discarded: true } });
}

module.exports = {
  createReceipt,
  createRetailerReceipt,
  save,
  get,
  update,
  list,
  imagePathFor,
  documentPathFor,
  blobPathFor,
  readDocument,
  discardDocument,
  newId,
};
