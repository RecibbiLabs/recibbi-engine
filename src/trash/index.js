'use strict';

// The trash: a deleted receipt is still a receipt for TRASH_RETENTION.
//
// WHY THIS EXISTS. A receipt is the one kind of data in this product that
// cannot be re-derived from anywhere -- a photograph of a till roll from three
// months ago does not exist twice -- so "delete" must not mean "gone" on the
// first press. It means out of the books, still on disk, for the retention
// (thirty days unless the deployment says otherwise), and then a sweep. The
// design is ../recibbi-ux-design-atlas docs/proposals.md § 6 and flows/trash.html.
//
// FOUR OPERATIONS, and only one of them destroys anything:
//
//   trash(id, by)   stamps `deletedAt` and `deletedBy` on the record. Nothing
//                   else about it changes. It leaves the books (store.query),
//                   the catalogue (its purchase rows are un-filed) and its
//                   share link stops resolving.
//   restore(id)     removes the two fields and files it again. The share link,
//                   if it had one, works again: the member deleted a receipt,
//                   they never revoked a link.
//   purge(id)       THE ONLY IRREVERSIBLE CALL, and it refuses a receipt that
//                   is not already in the trash, so nothing reaches it from the
//                   books in one step. Record, blob, profile and product
//                   results, catalogue rows, share link.
//   sweep(now)      purges every receipt whose retention is up. Scheduled by
//                   TRASH_EMPTY_CRON in the worker (src/trash/sweeper.js).
//
// `deletedBy` IS 'member' OR 'recibbi'. Half of what lands in a trash was not
// put there by the member -- the duplicate scan does it -- and a list of
// receipts somebody does not remember deleting, with nothing to say it was not
// them, reads as data loss. No reason is stored beside it; that is not a feature.
//
// WHEN A RECEIPT GOES IS DERIVED, NEVER STORED. `purgeAt` is `deletedAt` plus
// the retention in force at the moment of asking, so it is computed on every
// read (fields()) and by the sweep, and a changed TRASH_RETENTION moves every
// receipt already in the trash.
//
// THE ENGINE HAS NO AUTHENTICATION, as everywhere else: ownership is the
// caller's to check (recibbi-ux-main asserts it before any of these routes are
// reached), and a receipt's scope is structural in its composite id.

const fs = require('fs/promises');
const config = require('../config');
const logger = require('../logger');
const store = require('../store');
const receiptQuery = require('../receiptQuery');
const shares = require('../shares');
const catalogue = require('../catalogue');
const productStore = require('../products/productStore');
const resultStore = require('../receiptProfiles/resultStore');
const schedule = require('./schedule');

const WHO = new Set(['member', 'recibbi']);
const PENDING = new Set(['queued', 'processing']);

/** A refused trash operation, carrying the status a route should answer. */
class TrashError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TrashError';
    this.status = status;
  }
}

function retentionMs() {
  return config.trash.retentionMs;
}

/** When a trashed record is due to go, as a Date, or null when it is not in the trash. */
function purgeAtOf(record) {
  if (!store.inTrash(record)) return null;
  const at = Date.parse(record.deletedAt);
  return Number.isFinite(at) ? new Date(at + retentionMs()) : null;
}

/**
 * What the trash adds to a record on the way out of a route: `purgeAt`, derived
 * now. Empty for a record in the books, so a spread of it is a no-op there.
 */
function fields(record) {
  const at = purgeAtOf(record);
  return at ? { purgeAt: at.toISOString() } : {};
}

/** The deployment's settings, in the shape a caller prints. */
function settings(now = new Date()) {
  const ms = retentionMs();
  const next = schedule.nextRun(config.trash.cron, now);
  return {
    retention: { ms, days: ms / schedule.DAY, label: schedule.describe(ms) },
    sweep: { cron: config.trash.cron, next: next ? next.toISOString() : null },
  };
}

/**
 * A trash row: what the member needs to recognise the receipt -- store, day,
 * items, total -- and who put it here and when it goes. The whole record is a
 * GET /api/receipts/:id away; the trash row opens it.
 */
function row(record) {
  const total = receiptQuery.receiptTotal(record);
  return {
    id: record.id,
    status: record.status,
    store: (record.store && record.store.name) || null,
    date: (record.store && record.store.date) || null,
    // The books' own two readings, so a receipt says the same count and the
    // same total in the trash as it did on its card.
    items: receiptQuery.itemCount(record),
    total: total === undefined ? null : total,
    createdAt: record.createdAt,
    deletedAt: record.deletedAt,
    deletedBy: record.deletedBy,
    ...fields(record),
  };
}

async function load(id) {
  const record = await store.get(id);
  if (!record) throw new TrashError(404, 'not found');
  return record;
}

/**
 * Move a receipt to the trash. Idempotent: a receipt already there keeps the
 * `deletedAt` it has, because moving it again must not buy it more time.
 */
async function trash(id, { by = 'member' } = {}) {
  if (!WHO.has(by)) throw new TrashError(400, `deletedBy must be one of: ${[...WHO].join(', ')}`);
  const record = await load(id);
  if (store.inTrash(record)) return record;
  // NOT WHILE IT IS BEING READ. The pipeline writes the record when it
  // finishes, and a receipt deleted under it would come back into the books
  // with its lines. The receipt page offers no trash icon on a pending read
  // for the same reason.
  if (PENDING.has(record.status)) {
    throw new TrashError(409, 'that receipt is still being read; it can go in the trash once it has finished');
  }
  const next = await store.update(id, { deletedAt: new Date().toISOString(), deletedBy: by });
  await catalogue.indexReceiptSafely(next); // un-files its products
  logger.info({ receiptId: id, deletedBy: by }, 'receipt moved to the trash');
  return next;
}

/** Take a receipt out of the trash and back into the books. Idempotent. */
async function restore(id) {
  const record = await load(id);
  if (!store.inTrash(record)) return record;
  const { deletedAt, deletedBy, ...rest } = record;
  const next = await store.save(rest);
  await catalogue.indexReceiptSafely(next); // files its products again
  logger.info({ receiptId: id, deletedAt, deletedBy }, 'receipt put back from the trash');
  return next;
}

/**
 * DELETE A RECEIPT FOR GOOD. The only irreversible call in the engine.
 *
 * Refuses anything not already in the trash (409): the one path to this is
 * through the trash, so a single mistaken request can never destroy a receipt
 * that is in the books.
 *
 * ORDER: everything filed beside the receipt first, the record last. A failure
 * part-way leaves a record still in the trash, which the next sweep or the next
 * press finishes -- the other order would leave orphans nothing could find.
 */
async function purge(id, { reason = 'member' } = {}) {
  const record = await load(id);
  if (!store.inTrash(record)) {
    throw new TrashError(409, 'only a receipt in the trash can be deleted for good; move it to the trash first');
  }

  await shares.revokeReceipt(record.id);
  await catalogue.indexReceipt(record); // in the trash: removes any rows left, and the index
  await productStore.removeAll(record.id);
  await resultStore.removeAll(record.id);
  if (record.image || record.document) {
    try {
      await fs.unlink(store.blobPathFor(record));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  await store.remove(record.id);
  logger.info({ receiptId: record.id, deletedAt: record.deletedAt, deletedBy: record.deletedBy, reason }, 'receipt purged');
  return { id: record.id, purged: true };
}

/** One identity's trash, as rows, most recently deleted first. */
async function list(scope) {
  return (await store.listTrash(scope)).map(row);
}

/**
 * EMPTY THE TRASH OF EVERYTHING WHOSE TIME IS UP, across the deployment.
 *
 * A receipt goes on the first sweep at or after its `purgeAt`, never before.
 * Each purge re-reads the record, so one put back between the scan and its
 * turn is refused by purge() rather than destroyed. One failure does not stop
 * the rest; it is logged and the next sweep tries again.
 *
 * @returns {{ checked, purged, failed }}
 */
async function sweep({ now = new Date() } = {}) {
  let checked = 0;
  let purged = 0;
  let failed = 0;
  for (const scope of await catalogue.scopes()) {
    for (const record of await store.listTrash(scope)) {
      checked += 1;
      const at = purgeAtOf(record);
      if (!at || at > now) continue;
      try {
        await purge(record.id, { reason: 'sweep' });
        purged += 1;
      } catch (err) {
        if (err instanceof TrashError && err.status !== 500) continue; // put back, or gone already
        failed += 1;
        logger.error({ err: err.message, receiptId: record.id }, 'trash sweep could not purge a receipt');
      }
    }
  }
  return { checked, purged, failed };
}

module.exports = {
  TrashError,
  WHO,
  purgeAtOf,
  fields,
  settings,
  row,
  trash,
  restore,
  purge,
  list,
  sweep,
};
