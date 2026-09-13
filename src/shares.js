'use strict';

// The share table: an unlisted link to ONE receipt, for somebody with no
// account at all.
//
// A share is a GRANT, and it lives beside the receipt rather than inside it.
// Nothing was added to the receipt record for this, deliberately: if the token
// were a field on the record then revoking would be an edit to the receipt, and
// every read of a receipt would carry a live capability in it.
//
//   shares      <token>            -> { token, receiptId, createdAt, expiresAt }
//   shareIndex  <tenant>/<user>/<cacheId> -> { token }
//
// THE ROW IS KEYED BY THE TOKEN AND BY NOTHING ELSE, and this is the whole
// design rather than a storage detail. `resolve()` reads the row, takes the
// `receiptId` off it, and loads that receipt BY ID from wherever it lives. It
// must never resolve a token *within* some set of receipts it arrived at
// another way — a tenant's books, a user's books, a page — because the set the
// receipt is in is not a set the reader has any way of naming. They have a
// token; that is the entire input.
//
// The design atlas hit exactly this bug in its stub (recibbi-ux-design-atlas
// fad83dd): `getShared()` resolved a token by scanning the fifteen hand-written
// receipts, so once the books were split in two, every share minted under the
// generated ledger looked perfectly normal to the member and rendered the shut
// door to whoever they sent it to. That asymmetry is what makes this expensive.
// A dead link is bad; a dead link that is invisible on the side that does the
// sharing is the shape of bug you only hear about from the person you sent it
// to. A share table that covers half the receipts is worse than none.
//
// The reverse index is the one lookup that IS scoped, and legitimately so:
// minting starts from a receipt, so it already holds the receipt's own scope.
// Only resolution has nothing but the token.

const crypto = require('crypto');
const config = require('./config');
const identity = require('./identity');
const logger = require('./logger');
const persistence = require('./persistence');

/**
 * The token is random bytes, and it is NOT derived from the receipt id.
 *
 * A receipt id is `<tenant>:<user>:<cacheId>` — it carries the member's own
 * scope in it, so a URL built from one publishes who they are to everybody they
 * are sent to. The token says nothing about the member, and it can be destroyed
 * without touching the receipt.
 *
 * 16 bytes as base64url: 22 characters, unguessable, URL-safe, and inside
 * identity.js's segment alphabet — so it is also safe as a filename and as a
 * key segment, which is what lets the row be addressed by the token directly.
 */
function newToken() {
  return crypto.randomBytes(16).toString('base64url');
}

// A token is only ever read back out of a URL, so it is validated before it is
// used to build a storage key — the same defense the id segments get.
function isValidToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(token);
}

// The share row: global, addressed by the token. `tenant: ''` is not an
// omission — see the header. There is no tenant in the question a reader asks.
function shareKey(token) {
  return { kind: 'shares', tenant: '', id: token };
}

// The reverse lookup, scoped to the receipt's own identity. Null for an id that
// does not parse, so a malformed id is a clean miss rather than a throw.
function indexKey(receiptId) {
  try {
    const r = identity.resolveId(receiptId);
    return { kind: 'shareIndex', tenant: r.tenantId, user: r.userId, id: r.cacheId };
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

/** When a link minted now would lapse, or null when expiry is switched off. */
function expiryFrom(iso) {
  const days = config.share.ttlDays;
  if (!days || days <= 0) return null;
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Whether a row has lapsed. A row with no expiry never has. */
function isExpired(row) {
  return Boolean(row && row.expiresAt && row.expiresAt <= nowIso());
}

/** The public URL a token is handed out as. */
function urlFor(token) {
  return `${config.publicBaseUrl}/r/${token}`;
}

/** The wire shape of a share, for the mint/read responses. */
function publicShare(row) {
  return {
    token: row.token,
    receiptId: row.receiptId,
    url: urlFor(row.token),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt || null,
  };
}

/**
 * Mint a link for a receipt, or return the one it already has.
 *
 * IDEMPOTENT, and that is a correctness requirement rather than a nicety: a
 * member who opens the share dialog twice and gets two tokens is handing out
 * two links and revoking one of them. The second visit has to answer with the
 * first visit's link.
 *
 * A row that has lapsed is replaced rather than returned, so re-sharing an old
 * receipt does what the member plainly means by it.
 */
async function mint(receiptId) {
  const idx = indexKey(receiptId);
  if (!idx) throw new identity.IdentityError(400, `cannot share a receipt with invalid id "${receiptId}"`);

  const existingToken = await persistence.get(idx);
  if (existingToken && existingToken.token) {
    const row = await persistence.get(shareKey(existingToken.token));
    if (row && !isExpired(row)) return publicShare(row);
    // Lapsed or vanished: fall through and mint a fresh one over the index.
  }

  const createdAt = nowIso();
  const row = {
    token: newToken(),
    receiptId,
    createdAt,
    expiresAt: expiryFrom(createdAt),
  };
  // The row before the index. If the second write fails, the link still
  // resolves and the member merely mints a second one next time — the other
  // order would hand out an index entry pointing at nothing.
  await persistence.put(shareKey(row.token), row);
  await persistence.put(idx, { token: row.token, receiptId, createdAt });
  logger.info({ receiptId, expiresAt: row.expiresAt }, 'share link minted');
  return publicShare(row);
}

/**
 * The receipt id a token names, or null.
 *
 * ONE LOOKUP, KEYED BY THE TOKEN. Revoked, expired, mistyped and never-existed
 * all come back as the same null: the caller has a page for that, and telling
 * them apart would confirm receipts to somebody guessing tokens.
 */
async function resolve(token) {
  if (!isValidToken(token)) return null; // absence must not match absence
  const row = await persistence.get(shareKey(token));
  if (!row || !row.receiptId) return null;
  if (isExpired(row)) return null;
  return row;
}

/**
 * Revoke a link. The reason this is a table and not a signature.
 *
 * Best-effort on the index: the share row is what `resolve()` reads, so once it
 * is gone the link is dead whatever the index still says. A stale index entry
 * only costs the next mint a fresh token, which is the safe direction.
 */
async function revoke(token) {
  if (!isValidToken(token)) return false;
  const row = await persistence.get(shareKey(token));
  if (!row) return false;
  const gone = await persistence.delete(shareKey(token));
  const idx = indexKey(row.receiptId);
  if (idx) {
    const entry = await persistence.get(idx);
    if (entry && entry.token === token) await persistence.delete(idx);
  }
  logger.info({ receiptId: row.receiptId }, 'share link revoked');
  return gone;
}

/** The live link a receipt already has, or null. Never mints one. */
async function forReceipt(receiptId) {
  const idx = indexKey(receiptId);
  if (!idx) return null;
  const entry = await persistence.get(idx);
  if (!entry || !entry.token) return null;
  const row = await persistence.get(shareKey(entry.token));
  if (!row || isExpired(row)) return null;
  return publicShare(row);
}

module.exports = {
  mint,
  resolve,
  revoke,
  forReceipt,
  urlFor,
  publicShare,
  isValidToken,
  newToken,
};
