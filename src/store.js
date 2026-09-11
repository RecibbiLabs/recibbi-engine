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

// --- "newest first" --------------------------------------------------------
//
// A receipt's recency is the day it was BOUGHT, not the moment this service
// happened to read it. Those coincide for a photo sent minutes after the till,
// and come apart completely for a retailer sync: a backfill walks an order
// history newest-first and posts it as fast as the ingest pool drains, so years
// of purchases all land within a minute of each other. `createdAt` then orders
// a synced ledger by nothing a member can see -- and because the walk starts at
// the newest order, it puts their OLDEST purchase at the top.
//
// This belongs here rather than in a caller, because list() SLICES. A caller
// that re-sorts the page it was handed has put the wrong page in the right
// order.

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const NUMERIC_DATE_RE = /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})$/;

// Below this a parsed year is OCR noise, not a purchase.
const EARLIEST_YEAR = 2000;

function isRealDay(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  if (y < EARLIEST_YEAR || y > new Date().getUTCFullYear() + 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of the next month
}

function toDay(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The latest day a receipt could honestly claim: tomorrow, in UTC.
 *
 * The year bound in isRealDay is a coarse sieve -- it admits every day up to
 * next New Year's Eve, and the future is the one direction a bad date really
 * hurts. A day misread forward does not merely sort wrong, it sorts FIRST, and
 * stays pinned to the top of the member's list until the calendar catches up:
 * a single slipped digit outranks everything they actually bought. One day of
 * slack covers a purchase that is already "tomorrow" in UTC terms across a
 * timezone offset, which is as far ahead as a real receipt ever gets.
 */
function latestPlausibleDay() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** A sortable day, or null when it is not one a receipt could carry. */
function dayIfPlausible(y, m, d) {
  if (!isRealDay(y, m, d)) return null;
  const day = toDay(y, m, d);
  return day <= latestPlausibleDay() ? day : null;
}

/**
 * `store.date` as a sortable YYYY-MM-DD, or null when it cannot be trusted.
 *
 * The field is NOT reliably canonical. A retailer adapter writes an ISO day
 * (src/retailers/adapters/samsclub.com.js slices one off the order date), but a
 * photographed receipt's date comes from detectDate() in
 * src/parse/receiptParser.js, which returns whatever substring matched --
 * "9/11/2026" and "11-9-26" are both shapes it emits. Compared as strings those
 * sort "9/..." after "12/...", which is worse than not sorting at all. So a
 * date has to parse to a real day before it is allowed to order anything.
 */
function parseStoreDay(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const iso = s.match(ISO_DAY_RE);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return dayIfPlausible(y, m, d);
  }

  const parts = s.match(NUMERIC_DATE_RE);
  if (!parts) return null;

  // A four-digit leading field is Y/M/D; otherwise it is the M/D/Y that
  // detectDate() reads off a US receipt. A two-digit year is this century --
  // the alternative is a receipt from before the product existed.
  let [y, m, d] =
    parts[1].length === 4
      ? [Number(parts[1]), Number(parts[2]), Number(parts[3])]
      : [Number(parts[3]), Number(parts[1]), Number(parts[2])];
  if (y < 100) y += 2000;
  if (m > 12 && d <= 12) [m, d] = [d, m]; // written D/M/Y by a member abroad

  return dayIfPlausible(y, m, d);
}

/** The day a receipt is FROM, falling back to the day it was read. */
function receiptDay(record) {
  const read = record && typeof record.createdAt === 'string' ? record.createdAt.slice(0, 10) : '';
  return parseStoreDay(record && record.store && record.store.date) || read;
}

/**
 * Newest first, and TOTAL: it returns 0 only for a record against itself.
 *
 * The comparator this replaced was `a.createdAt < b.createdAt ? 1 : -1`, which
 * reports every tie as "a first" -- not a consistent ordering, and harmless
 * only while ties are rare. Ties stop being rare the moment the key is a day
 * rather than a millisecond, so same-day receipts fall back to when they were
 * read and then to their id. A reload draws the same list in the same order.
 */
function byRecency(a, b) {
  const dayA = receiptDay(a);
  const dayB = receiptDay(b);
  if (dayA !== dayB) return dayA < dayB ? 1 : -1;
  const readA = a.createdAt || '';
  const readB = b.createdAt || '';
  if (readA !== readB) return readA < readB ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * List a single identity's receipts, newest first -- by the date ON the
 * receipt, not the date it was read; see byRecency() above. Scope defaults to
 * the configured identity (so single-tenant callers pass only `{ limit }`).
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
  records.sort(byRecency);
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
  receiptDay,
  imagePathFor,
  documentPathFor,
  blobPathFor,
  readDocument,
  discardDocument,
  newId,
};
