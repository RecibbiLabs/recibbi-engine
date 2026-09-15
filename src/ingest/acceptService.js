'use strict';

// The shared tail of "accept a receipt": everything a receipt upload does that
// has nothing to do with WHAT was uploaded. Both ingest routes — a photo posted
// to /api/receipts and a retailer payload posted to /api/retailer:<id>/receipts
// — resolve identity, check the tenant, resolve an optional profile, pick a
// flow depth, and answer 202 with the same body. That logic lives here once, so
// the two routes differ only in how they turn a request into a record.

const config = require('../config');
const identity = require('../identity');
const tenants = require('../tenants');
const profileStore = require('../receiptProfiles/profileStore');
const retailerPrefs = require('../settings/retailerPrefs');
const { enqueueReceipt, enqueueProcessAndApply, enqueueProcessApplyAndResolve } = require('../queue');

// Error carrying an HTTP status, mapped by the app's global error handler.
class AcceptError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AcceptError';
    this.status = status;
  }
}

/**
 * Interpret an optional request flag: absent -> the fallback; otherwise
 * anything but an explicit falsey value is true.
 */
function flag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

// A flag may arrive as a form field, a JSON body field, or a query param — the
// JSON ingest path is often driven by a plain `curl -d @payload.json`, where a
// query string is the only place left to put options.
function requestFlag(req, name, fallback) {
  const body = req.body && !Buffer.isBuffer(req.body) ? req.body[name] : undefined;
  const query = req.query ? req.query[name] : undefined;
  return flag(body !== undefined ? body : query, fallback);
}

function requestField(req, name) {
  const body = req.body && !Buffer.isBuffer(req.body) ? req.body[name] : undefined;
  const query = req.query ? req.query[name] : undefined;
  return body !== undefined && body !== '' ? body : query;
}

/**
 * Everything an upload needs to know before it creates a record. Resolves the
 * identity, rejects an unprovisioned tenant, and resolves the optional profile
 * within that tenant.
 *
 * @param {object} req                Express request
 * @param {object} [opts]
 * @param {boolean} [opts.enrichByDefault=true]  enrichment default for this kind
 * @param {string}  [opts.retailerId]  the retailer this payload came from, when
 *                                     there is one. Its presence is what makes
 *                                     the member's own retailer setting apply.
 * @returns {Promise<{tenantId, userId, profile, wantsProducts, enrich, enrichSource, source}>}
 * @throws {AcceptError} 400 unknown tenant | 400 unknown profile
 */
async function resolveContext(req, { enrichByDefault = true, retailerId = null } = {}) {
  // Identity for this upload: X-Tenant-Id / X-User-Id headers, tenantId/userId
  // fields, or the configured default. Tenants are provisioned accounts, so an
  // upload for an unknown tenant is rejected rather than auto-creating one.
  const { tenantId, userId } = identity.resolveIdentity(req);
  if (!(await tenants.isAllowed(tenantId))) {
    throw new AcceptError(400, `unknown tenant "${tenantId}"`);
  }

  // Optional: apply a profile after extraction. An explicit request field wins;
  // otherwise fall back to the server-wide default (DEFAULT_PROFILE_ID).
  // Profiles are tenant-scoped, so resolve within this upload's tenant.
  const requestedProfileId = requestField(req, 'profileId') || config.receiptProfiles.defaultProfileId || null;
  let profile = null;
  if (requestedProfileId) {
    profile = await profileStore.get(requestedProfileId, { tenantId });
    if (!profile) throw new AcceptError(400, `unknown profile "${requestedProfileId}"`);
  }

  // Product resolution needs a profile result, so it only applies when a profile
  // is selected. On by default (config.products.resolveOnUpload); opt out
  // per-upload with resolveProducts=0.
  const wantsProducts =
    !!profile && config.products.enabled && requestFlag(req, 'resolveProducts', config.products.resolveOnUpload);

  // THE MEMBER'S RETAILER SETTING IS READ HERE, AT ACCEPT, AND FROZEN ONTO THE
  // RECORD — which is the whole mechanism behind a promise the Settings screen
  // makes in so many words:
  //
  //   "Applies to receipts imported from here on. 248 Sam's Club receipts
  //    already in your books were read under the previous answer and are not
  //    read again."
  //
  // If the pipeline read the preference instead, that sentence would be false
  // the moment anything re-ran: a retried job, a re-normalization after an
  // adapter improvement, a backfill. Each would quietly re-read an old receipt
  // under a new answer, and the member would find their books had changed
  // underneath them with nothing to point at. Reading it once, here, means the
  // record carries the answer that was true WHEN IT WAS IMPORTED, and every
  // later pass reads it off the record. The reach of the switch is then a
  // property of the data rather than a rule somebody has to keep remembering.
  //
  // Precedence, most specific first:
  //   1. an explicit `enrich=` on THIS request  — one upload, deliberately
  //   2. the member's setting for this retailer — their standing answer
  //   3. the deployment default                 — RETAILER_ENRICH_DEFAULT
  let enrichDefault = enrichByDefault;
  let enrichSource = 'web';
  if (retailerId) {
    const prefs = await retailerPrefs.all({ tenantId, userId });
    if (retailerPrefs.valueOf(prefs, retailerId, 'enrichFromRetailer')) {
      enrichDefault = true;
      enrichSource = 'retailer';
    }
  }

  const enrich = requestFlag(req, 'enrich', enrichDefault);

  return {
    tenantId,
    userId,
    profile,
    wantsProducts,
    enrich,
    // Where enrichment should look FIRST when it runs. Meaningless when
    // `enrich` is false, and left at 'web' so a record never claims a source
    // for something that did not happen.
    enrichSource: enrich ? enrichSource : 'web',
    source: requestField(req, 'source') || 'api',
  };
}

/**
 * Queue the flow that matches the requested depth: OCR/normalize + profile +
 * products (3 levels), + profile (2), or extraction alone (1 job). Identical
 * for both receipt kinds — `process-receipt` is kind-agnostic, the pipeline
 * picks its extraction path from the record.
 */
async function enqueueFor(record, { profile, wantsProducts }) {
  if (wantsProducts) return enqueueProcessApplyAndResolve(record.id, profile.id);
  if (profile) return enqueueProcessAndApply(record.id, profile.id);
  return enqueueReceipt(record.id);
}

function links(id) {
  return {
    statusUrl: `${config.publicBaseUrl}/api/receipts/${id}`,
    viewUrl: `${config.publicBaseUrl}/receipts/${id}/view`,
  };
}

/** The 202 body. Shared so both ingest paths answer with the same shape. */
function acceptedBody(record, { profile, wantsProducts }) {
  return {
    id: record.id,
    status: record.status,
    profileId: profile ? profile.id : null,
    profileResultUrl: profile
      ? `${config.publicBaseUrl}/api/receipts/${record.id}/profileResults/${profile.id}`
      : null,
    productsUrl: wantsProducts
      ? `${config.publicBaseUrl}/api/receipts/${record.id}/products/${profile.id}`
      : null,
    ...links(record.id),
  };
}

module.exports = { resolveContext, enqueueFor, acceptedBody, links, flag, requestFlag, requestField, AcceptError };
