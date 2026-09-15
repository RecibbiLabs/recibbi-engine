'use strict';

// Per-member, per-retailer settings: the two switches on Settings -> Retailers.
//
//   kind='settings', { tenant, user, id: 'retailers' }
//   { <retailerKey>: { productIcons, enrichFromRetailer, updatedAt } }
//
// ONE DOCUMENT, NOT ONE PER RETAILER. The whole set is read together on every
// page that draws a receipt list, and there are a dozen retailers at most. A
// document each would turn one read into a listing, and the listing would be
// the hot path.
//
// PER RETAILER, NOT PER CONNECTION. A member can hold two Sam's Club
// connections — a household card and a personal one — and neither of these
// settings is a question about a membership. One decides how a LINE IS DRAWN,
// the other how the NEXT IMPORT IS READ. Per-connection would ask the same
// question twice and leave one set of books obeying both answers.

const config = require('../config');
const identity = require('../identity');
const persistence = require('../persistence');
const registry = require('../retailers/registry');
const logger = require('../logger');
const { withLock } = require('./lock');
const { SettingsError } = require('./validate');

const DOC_ID = 'retailers';

// The two switches, and the fallback each takes when nobody has answered.
//
// ABSENT IS NOT OFF, and the default DIFFERS PER SWITCH. `productIcons` is on
// because drawing the retailer's own product photograph is the shipped
// behaviour and has been since long before this screen existed; a member who
// has never opened Settings is looking at those pictures right now, and a
// screen that rendered every unanswered preference as off would show them a
// switch that disagrees with the page they just came from.
//
// `enrichFromRetailer` follows the deployment's own RETAILER_ENRICH_DEFAULT
// rather than a constant, because that env var is the existing answer to
// exactly this question and a second hardcoded one would let an operator turn
// enrichment on and have every switch still read "off".
const PREFS = {
  productIcons: { fallback: () => true },
  enrichFromRetailer: { fallback: () => config.retailers.enrichByDefault },
};

const KEYS = Object.keys(PREFS);

/** The fallback for every switch, as the client needs it to render an unset one. */
function defaults() {
  const out = {};
  for (const key of KEYS) out[key] = !!PREFS[key].fallback();
  return out;
}

function keyFor(scope) {
  const { tenantId, userId } = scope || {};
  if (!identity.isValidSegment(tenantId) || !identity.isValidSegment(userId)) {
    throw new identity.IdentityError(400, 'tenant/user identity required to read retailer settings');
  }
  return { kind: 'settings', tenant: tenantId, user: userId, id: DOC_ID };
}

/**
 * Any spelling of a retailer -> the one key its settings live under.
 *
 * Two normalizations, and they are doing different jobs. The registry collapses
 * the ALIASES an adapter answers to (`sams-club`, `Sam's Club`, `samsclub.com`
 * all reach one adapter), so a member who arrives by a different spelling does
 * not silently get a second, empty set of switches. Then the TLD comes off,
 * because the adapter's id is a domain (`samsclub.com`) and a receipt record's
 * `retailer` field carries that domain, while the design atlas keys the same
 * settings by the bare slug (`samsclub`) on both sides of its own seam. One
 * canonical key, derived here, rather than three conventions meeting in a view.
 *
 * A retailer WITH NO ADAPTER still gets a key. Settings draws a card for every
 * retailer in the catalogue, not only the two that are integrated, and a member
 * who sets a preference for Costco before Costco is live should find it set
 * when it is. Refusing to store it would make the screen lie about what it did.
 */
function prefKey(retailerId) {
  const known = registry.get(retailerId);
  const base = known ? known.id : retailerId;
  const slug = registry
    .normalizeKey(base)
    .replace(/\..*$/, ''); // samsclub.com -> samsclub
  if (!identity.isValidSegment(slug)) {
    throw new SettingsError(400, `invalid retailer id "${retailerId}"`);
  }
  return slug;
}

/**
 * Every stored preference, keyed by retailer.
 *
 * Returned RAW — only what has actually been answered, with no defaults filled
 * in. A caller that wants an effective value asks `valueOf()`, which is the one
 * place the fallback lives. Filling them in here would make "unset" and
 * "explicitly set to the default" indistinguishable to the route, and the two
 * differ the day a default changes.
 */
async function all(scope) {
  const stored = await persistence.get(keyFor(scope));
  return stored && typeof stored === 'object' ? stored : {};
}

/** One retailer's stored row, or an empty object. */
async function forRetailer(scope, retailerId) {
  const prefs = await all(scope);
  return prefs[prefKey(retailerId)] || {};
}

/**
 * The effective value of one switch: what the member answered, or the default.
 *
 * Every shape of absence — no document, no row for this retailer, no such key,
 * a null left by an older write — is "nobody has answered", and they all take
 * the same branch. This is the engine's half of the seam; the design atlas's
 * `Recibbi.retailerIconsOn()` and `pages/settings.js` `prefValue()` hold the
 * same rule on the other half, and a law over there asserts the two agree.
 */
function valueOf(prefs, retailerId, key) {
  if (!PREFS[key]) throw new SettingsError(400, `unknown retailer setting "${key}"`);
  const row = (prefs && prefs[prefKey(retailerId)]) || {};
  const value = row[key];
  if (value === undefined || value === null) return !!PREFS[key].fallback();
  return !!value;
}

/**
 * Set one or more switches for one retailer.
 *
 * Read-modify-write under the per-scope lock: the two switches sit one above
 * the other in the same card, so flipping both quickly is ordinary use rather
 * than an edge case, and without the lock the first one silently flips back.
 * See src/settings/lock.js for the interleaving.
 *
 * A key that is not a switch is REFUSED rather than ignored. The member pressed
 * something; storing nothing and answering 200 would show them a control that
 * agrees on screen and has changed nothing, which is the failure this whole
 * screen's rollback behaviour exists to make visible.
 */
async function set(scope, retailerId, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new SettingsError(400, 'a retailer settings write needs an object of switches');
  }
  const wanted = Object.keys(changes);
  if (!wanted.length) throw new SettingsError(400, 'no settings given');
  for (const key of wanted) {
    if (!PREFS[key]) {
      throw new SettingsError(400, `unknown retailer setting "${key}" (expected: ${KEYS.join(' | ')})`);
    }
    if (typeof changes[key] !== 'boolean') {
      throw new SettingsError(400, `retailer setting "${key}" must be true or false`);
    }
  }

  const rid = prefKey(retailerId);
  const key = keyFor(scope);
  return withLock(`retailerPrefs:${scope.tenantId}:${scope.userId}`, async () => {
    const prefs = (await persistence.get(key)) || {};
    const row = { ...(prefs[rid] || {}) };
    for (const name of wanted) row[name] = changes[name];
    row.updatedAt = new Date().toISOString();
    const next = { ...prefs, [rid]: row };
    await persistence.put(key, next);
    logger.info({ tenantId: scope.tenantId, userId: scope.userId, retailer: rid, ...changes }, 'retailer settings saved');
    return row;
  });
}

module.exports = {
  DOC_ID,
  KEYS,
  defaults,
  all,
  forRetailer,
  valueOf,
  set,
  prefKey,
  keyFor,
};
