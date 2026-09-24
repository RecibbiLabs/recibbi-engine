'use strict';

// Settings: the member's own profile, their photograph, and the two switches
// per retailer. Designed in recibbi-ux-design-atlas (flows/settings.html,
// docs/settings.md) before any of it was built here, which is the working
// agreement; this file implements what that settled.
//
// WHO IS ASKING. The engine has no sessions and no cookies — it never has. Every
// route here resolves a (tenantId, userId) the same way the upload routes do,
// from `X-Tenant-Id` / `X-User-Id` (src/identity.js), and recibbi-ux-main is the
// only thing that talks to it: that application holds the session, maps it to a
// scope, and calls through. Ownership is then STRUCTURAL rather than checked —
// a caller asking with the wrong scope reads a different document, not this one.
//
// WHICH MEANS CSRF IS NOT SOLVED HERE, AND CANNOT BE. A CSRF token defends a
// request that carries an AMBIENT credential — a cookie a browser attaches
// whether or not the page meant it to. This service has no such credential: a
// request with no identity header is not "the logged-in member", it is the
// configured default scope, and a browser cannot be tricked into adding a
// header it was never given. The defence belongs in recibbi-ux-main, on the
// session-bearing forms, and it is item 3 of docs/settings.md § 7 for that repo
// rather than a gap in this one. Said out loud because an empty CSRF check here
// would otherwise look like an oversight to whoever reads this next.

const express = require('express');
const multer = require('multer');
const config = require('../config');
const identity = require('../identity');
const logger = require('../logger');
const blobs = require('../blobs');
const memberProfile = require('../settings/memberProfile');
const retailerPrefs = require('../settings/retailerPrefs');
const providerKeys = require('../settings/providerKeys');
const { SettingsError } = require('../settings/validate');

const router = express.Router();

// Held in memory rather than spooled to disk: an avatar is capped at a few
// megabytes and goes straight into the blob store, so a temp file would be a
// second place for it to be left behind.
//
// The size limit is enforced by multer AND again inside src/blobs, because they
// are answering different questions — multer stops the socket, the blob store
// refuses the bytes — and the blob store is reachable from callers that are not
// this route.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.blobs.maxBytes, files: 1 },
  // NO fileFilter ON MIMETYPE. `file.mimetype` is whatever the uploading client
  // typed in the multipart part header — it is the claim being checked, not
  // evidence — so filtering on it would only stop an honest mistake while
  // letting through the case that matters. src/blobs sniffs the actual bytes.
});

function scopeOf(req) {
  return identity.resolveIdentity(req);
}

// --- The whole screen, in one read ------------------------------------------

/**
 * GET /api/settings — everything Settings draws.
 *
 * One call rather than three, because the page needs all of it before it can
 * render anything and three round trips would give a reviewer three chances to
 * see a half-drawn screen. The atlas fetches profile, preferences, session and
 * connections together for the same reason.
 *
 * `defaults` is here because ABSENT IS NOT OFF and the fallback differs per
 * switch: `productIcons` is on, `enrichFromRetailer` follows the deployment's
 * RETAILER_ENRICH_DEFAULT. A client that hardcoded those would disagree with
 * this service the day an operator changed the env var, and disagree silently —
 * the member would see a switch reading "off" over books being enriched. So the
 * engine states its own defaults and the page renders what it is told.
 */
router.get('/api/settings', async (req, res, next) => {
  try {
    const scope = scopeOf(req);
    const [profile, prefs] = await Promise.all([memberProfile.get(scope), retailerPrefs.all(scope)]);
    res.json({
      profile,
      retailers: prefs,
      defaults: { retailers: retailerPrefs.defaults() },
    });
  } catch (err) {
    next(err);
  }
});

// --- Profile -----------------------------------------------------------------

router.get('/api/settings/profile', async (req, res, next) => {
  try {
    res.json(await memberProfile.get(scopeOf(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/settings/profile — replace the member-editable half.
 *
 * PUT, not PATCH, and the whole record every time. Every field is optional, so
 * "absent" has to mean *cleared* rather than *not mentioned* — under merge
 * semantics an address could never be emptied, which is a member who moved and
 * has no way to say so.
 *
 * `avatarUrl` in the body is IGNORED rather than refused, because a client that
 * round-trips the object it was given by GET would otherwise be unable to save
 * anything. The store simply does not read it (src/settings/memberProfile.js).
 */
router.put('/api/settings/profile', async (req, res, next) => {
  try {
    res.json(await memberProfile.save(scopeOf(req), req.body || {}));
  } catch (err) {
    next(err);
  }
});

// --- The photograph ----------------------------------------------------------

/**
 * POST /api/settings/profile/photo — store an image, answer with the profile.
 *
 * The route does not know what stored the bytes and does not build the URL it
 * hands back: `blobs.put()` mints it and this writes that string onto the
 * profile verbatim. Move to an object store and the mint changes; this does not.
 *
 * The OLD photograph is deleted after the new one is written, and the order
 * matters. Written-then-deleted means a failure between the two leaves a blob
 * nobody points at — wasted bytes an operator can sweep. Deleted-then-written
 * would mean a failure between the two leaves a member with no photograph and
 * no way to get the old one back.
 */
router.post('/api/settings/profile/photo', upload.single('photo'), async (req, res, next) => {
  try {
    const scope = scopeOf(req);
    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({ error: 'No image uploaded. Use field "photo".' });
    }

    const previous = (await memberProfile.get(scope)).avatarUrl;
    const stored = await blobs.put({ scope, buffer: file.buffer });
    const profile = await memberProfile.setAvatarUrl(scope, stored.url);

    const staleId = blobs.blobIdFromUrl(previous);
    if (staleId && staleId !== stored.blobId) {
      // Best effort. The profile already points at the new photograph, so a
      // failure here costs disk and nothing else — it must not fail the upload
      // the member is waiting on.
      blobs.remove(scope, staleId).catch((err) => {
        logger.warn({ err: err.message, blobId: staleId }, 'could not remove the replaced avatar');
      });
    }

    logger.info(
      { tenantId: scope.tenantId, userId: scope.userId, size: stored.size, contentType: stored.contentType },
      'profile photo stored'
    );
    res.status(201).json(profile);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/settings/profile/photo — remove it.
 *
 * The profile is cleared FIRST, then the bytes. A member who asked for their
 * photograph to be gone has been told the truth the moment nothing points at it,
 * and a blob left behind by a failed unlink is invisible rather than served.
 */
router.delete('/api/settings/profile/photo', async (req, res, next) => {
  try {
    const scope = scopeOf(req);
    const previous = (await memberProfile.get(scope)).avatarUrl;
    const profile = await memberProfile.setAvatarUrl(scope, null);
    const blobId = blobs.blobIdFromUrl(previous);
    if (blobId) await blobs.remove(scope, blobId);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/settings/profile/photo/:blobId — the bytes.
 *
 * IT IS A MEMBER'S FACE, so it goes out under the same rule as a receipt: the
 * scope comes from the asking identity and the blob is looked for under THAT
 * scope's directory. A caller holding somebody else's blob id looks in their
 * own directory, does not find it, and gets the same 404 as a typo. There is no
 * ownership comparison to get wrong because there is no ownership field.
 *
 * This route belongs to the LOCAL backend. An object-store backend mints URLs
 * that point at the object store and nothing ever arrives here — which is why
 * the path constant lives with that backend rather than in this file.
 */
router.get('/api/settings/profile/photo/:blobId', async (req, res, next) => {
  try {
    const found = await blobs.read(scopeOf(req), req.params.blobId);
    if (!found) return res.status(404).json({ error: 'not found' });
    res.set({
      'Content-Type': found.contentType,
      // The id is random and a replacement gets a NEW one, so the bytes at this
      // URL can never change — which is what makes a year of caching safe.
      // `private` keeps it out of any shared cache: it is one member's face.
      'Cache-Control': 'private, max-age=31536000, immutable',
      // The type was decided by sniffing the bytes; tell the browser not to go
      // looking for a different answer.
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    res.send(found.buffer);
  } catch (err) {
    next(err);
  }
});

// --- Retailers ---------------------------------------------------------------

router.get('/api/settings/retailers', async (req, res, next) => {
  try {
    res.json({
      retailers: await retailerPrefs.all(scopeOf(req)),
      defaults: retailerPrefs.defaults(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/settings/retailers/:retailerId — flip one or both switches.
 *
 * Answers with the row as it now stands, so the control can render what was
 * ACTUALLY stored rather than what it assumed it stored. The atlas flips the
 * switch optimistically and rolls it back on a refusal; a response that echoed
 * the request would make a partial write indistinguishable from a complete one.
 *
 * An unknown switch name is a 400, not a shrug. A member pressed something: a
 * 200 over a write that stored nothing would leave the control agreeing on
 * screen and disagreeing with the books, which is precisely the state the
 * rollback behaviour exists to prevent.
 */
router.put('/api/settings/retailers/:retailerId', async (req, res, next) => {
  try {
    const body = req.body || {};
    // The two spellings a client might reasonably send: the switches at the top
    // level, or nested under `settings`. Accepted rather than one of them being
    // an error, because both read naturally and neither is ambiguous.
    const changes = body.settings && typeof body.settings === 'object' ? body.settings : body;
    const row = await retailerPrefs.set(scopeOf(req), req.params.retailerId, changes);
    res.json({ retailerId: retailerPrefs.prefKey(req.params.retailerId), settings: row });
  } catch (err) {
    next(err);
  }
});

// --- Provider keys: the deployment's, not a member's --------------------------

// NO SCOPE ON THESE THREE, and that is the design rather than an omission. There
// is one Anthropic key and every member's receipts are read with it, so the
// record is per deployment and no (tenantId, userId) names it.
//
// WHICH MEANS WHO MAY CALL THEM IS NOT DECIDED HERE, AND CANNOT BE. This service
// has no idea who is asking -- it never has; see the header. recibbi-ux-main
// refuses all three for anybody but the operator, in its route, and it is the
// only thing on the compose network that reaches this one. That is the same
// trust boundary every receipt route here already stands on, stated once more
// because these three are the most valuable strings the deployment holds.
//
// AND NOTHING HERE ANSWERS WITH A KEY. A secret goes out as its last four
// characters. The value never leaves this process -- see providerKeys.view().

/** GET /api/settings/providers -- every provider the engine holds a key for. */
router.get('/api/settings/providers', (req, res, next) => {
  try {
    res.json(providerKeys.viewAll());
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/settings/providers/:key -- a PATCH, deliberately, under a PUT verb.
 *
 * The caller never received the secret, so it cannot send the whole record
 * back: a field left out, or blank, means KEEP. The provider is asked first,
 * and a key it refuses is not stored (422, with what it answered); a provider
 * that could not be asked stores nothing either (502).
 */
router.put('/api/settings/providers/:key', async (req, res, next) => {
  try {
    res.json(await providerKeys.save(req.params.key, req.body));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/settings/providers/:key -- what was saved HERE, only. A value in
 * the host's .env cannot be removed by a web request, and the answer shows the
 * .env value taking over, or nothing.
 */
router.delete('/api/settings/providers/:key', async (req, res, next) => {
  try {
    res.json(await providerKeys.remove(req.params.key));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.SettingsError = SettingsError;
