'use strict';

// Unlisted share links: mint one, revoke one, and the page a token opens.
//
// `GET /r/:token` is THE ONLY ROUTE HERE THAT ANSWERS WITHOUT KNOWING WHO IS
// ASKING, and the engine has no sessions to begin with, so what that means
// concretely is this: it does not read an identity header, it does not fall
// back to the default identity, and it never asks the store for a scoped list.
// The token is the scope. Everything the ownership rule normally does — over in
// recibbi-ux-main's src/engine.js, which is the only thing that talks to this
// service — is done by the share table instead.
//
// The lookup is `token -> receiptId -> store.get(receiptId)`. Nothing in that
// chain names a tenant, a user, or a page of anybody's books, and that is not
// an accident of how it was written. See the header of src/shares.js for the
// bug the design atlas hit doing it the other way (fad83dd), and rule 4 in its
// docs/porting.md: the lookup is keyed by the token, and by nothing else.

const express = require('express');
const store = require('../store');
const shares = require('../shares');
const view = require('../web/view');
const logger = require('../logger');

const router = express.Router();

// --- REST API (member-side: the two calls that manage a grant) ---

/**
 * POST /api/receipts/:id/share — mint the link, or return the one that exists.
 *
 * IDEMPOTENT. Asking twice returns the same token, because a member who opened
 * the page twice would otherwise be handing out two links and revoking one.
 *
 * The receipt has to exist before it can be shared: minting a token for an id
 * nobody has ever stored would produce a link that renders the shut door, which
 * is precisely the failure this whole feature was fixed to avoid.
 */
router.post('/api/receipts/:id/share', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const share = await shares.mint(record.id);
    res.status(201).json(share);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/receipts/:id/share — the live link this receipt has, if any.
 *
 * Never mints. A page that draws a share button has to be able to ask whether
 * there is already a link without creating one as a side effect of asking.
 */
router.get('/api/receipts/:id/share', async (req, res, next) => {
  try {
    const share = await shares.forReceipt(req.params.id);
    if (!share) return res.status(404).json({ error: 'not shared' });
    res.json(share);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/shares/:token — revocation, which is the whole reason this is a
 * table and not a signature.
 *
 * Answers 200 either way with what happened. A token that was not there is not
 * an error: the caller wanted it gone, and it is gone.
 */
router.delete('/api/shares/:token', async (req, res, next) => {
  try {
    res.json({ revoked: await shares.revoke(req.params.token) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/shares/:token — resolve a token to its receipt, as JSON.
 *
 * This is what a front end that renders its own shared page calls
 * (recibbi-ux-main serves the member-facing `/r/:token` and needs the record,
 * not our HTML). Same rules as the page: no identity is read, and every dead
 * token — revoked, expired, mistyped, never-existed — is one 404 with one body.
 */
router.get('/api/shares/:token', async (req, res, next) => {
  try {
    const record = await resolveShared(req.params.token);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.set(SHARE_HEADERS).json(sharedRecord(record));
  } catch (err) {
    next(err);
  }
});

// --- The page ---

// Sent on every shared response, dead ones included.
//
// `no-referrer` is the one that is doing real work: the URL IS THE CREDENTIAL,
// so a reader who follows any link out of this page must not hand the token to
// the next server in the chain. `noindex` keeps it out of search results, and
// `no-store` keeps a shared proxy from holding a copy of somebody's receipt.
const SHARE_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

/**
 * Token -> receipt, or null.
 *
 * The two steps are the point. `shares.resolve()` reads the row by the token;
 * `store.get()` loads the receipt BY ID from wherever it lives. No list is
 * consulted, no scope is inferred, and the receipt may belong to any tenant and
 * any user in the deployment — which is the ordinary case, not the exotic one.
 */
async function resolveShared(token) {
  const row = await shares.resolve(token);
  if (!row) return null;
  const record = await store.get(row.receiptId);
  if (!record) {
    // The receipt is gone but its grant is not. Nothing the reader can act on,
    // but an operator should see it, since it means a delete path skipped the
    // share table.
    logger.warn({ receiptId: row.receiptId }, 'share row resolves to a missing receipt');
    return null;
  }
  return record;
}

/**
 * The record as a stranger may see it.
 *
 * A WHITELIST, NOT A BLACKLIST, because the wrong direction here fails quietly:
 * a field added to the record next year would be published by a redaction list
 * and withheld by this one. Gone in particular are the composite `id` (which
 * spells out the member's tenant and user), the blob descriptors (internal
 * filenames), `extraction.rawText` (the entire OCR dump) and `timings`.
 */
function sharedRecord(record) {
  return {
    status: record.status,
    store: record.store || null,
    items: record.items || [],
    totals: record.totals || null,
    summary: record.summary || null,
    reconciled: record.reconciled === undefined ? null : record.reconciled,
    // `source` says a photograph from a retailer feed and nothing finer; see
    // sharedProvenance() in src/web/view.js for why the reader gets a sentence
    // rather than the internal word.
    source: record.source === 'sync' || record.kind === 'json' ? 'sync' : 'photo',
    createdAt: record.createdAt,
  };
}

/**
 * GET /r/:token — the page, and the only view in this service with no operator
 * on it.
 *
 * A dead token is NOT an error. Revoked, expired and mistyped all render the
 * same page and say the same sentence, because distinguishing them would
 * confirm receipts to somebody guessing tokens. The 404 is for the machines;
 * the reader gets a plain sentence and nothing to retry.
 */
router.get('/r/:token', async (req, res, next) => {
  try {
    const record = await resolveShared(req.params.token);
    res.set(SHARE_HEADERS).type('html');
    if (!record) return res.status(404).send(view.renderSharedGone());
    res.send(view.renderSharedReceipt(record));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
