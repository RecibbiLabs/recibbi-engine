'use strict';

// The member's own profile: what Recibbi calls them, and where they are.
//
// NOT `src/receiptProfiles/profileStore.js`. That file is about OCR receipt
// profiles — user-defined transformation rules applied to a parsed receipt —
// and the two have nothing to do with each other beyond the word. The name
// collision is the whole reason this module is called `memberProfile`: a
// `require('../settings/profileStore')` that resolves to the wrong file would
// typecheck, run, and quietly store somebody's address in the transformation
// rules. See docs/SETTINGS.md § "Two things called a profile".
//
// SCOPE. One document per (tenantId, userId), exactly like a receipt:
//   kind='settings', { tenant, user, id: 'profile' }
// Ownership is structural. There is no `ownerId` field to check, because the
// key IS the owner — a caller holding the wrong scope reads a different
// document rather than reading this one and being refused.
//
// WHY NOT REDIS. A profile is not losable. Redis in this deployment is a cache
// and a queue: it is evicted, recycled, and its loss is a performance event
// rather than a data event (see src/tenants.js, which keeps the durable list in
// persistence for the same reason and uses Redis only as a working copy). A
// member who typed their address and found it gone after an ops restart has
// been told, correctly, that Settings does not hold.
//
// THE RECORD IS RECIBBI'S, AND IT DOES NOT WRITE BACK. Editing a name here
// changes what Recibbi calls the member. The identity provider still holds what
// it was given at sign-up, and nothing in this module reaches for it. That is a
// decision rather than an omission — recibbi-ux-design-atlas docs/settings.md
// § 2 has the argument, and the short form is that a name edited in the
// provider's own portal changes what the member is called in every other
// application reading the same directory, which is not what "set your name"
// offered, and that the operator has no provider at all.

const identity = require('../identity');
const persistence = require('../persistence');
const logger = require('../logger');
const { withLock } = require('./lock');
const { ADDRESS_FIELDS, NAME_FIELDS, SettingsError, field } = require('./validate');

const DOC_ID = 'profile';

function keyFor(scope) {
  const { tenantId, userId } = scope || {};
  if (!identity.isValidSegment(tenantId) || !identity.isValidSegment(userId)) {
    throw new identity.IdentityError(400, 'tenant/user identity required to read a profile');
  }
  return { kind: 'settings', tenant: tenantId, user: userId, id: DOC_ID };
}

function lockKey(scope) {
  return `profile:${scope.tenantId}:${scope.userId}`;
}

/**
 * An address with every field null.
 *
 * The shape is always present even when nothing in it is, so a caller never has
 * to distinguish "no address object" from "an address with nothing in it" —
 * there is one representation of empty and every field is independently
 * optional. A postal code on its own is a COMPLETE address here.
 */
function emptyAddress() {
  const address = {};
  for (const name of ADDRESS_FIELDS) address[name] = null;
  return address;
}

/** The profile a member has before they have one. Never stored, only answered. */
function emptyProfile() {
  return {
    firstName: null,
    lastName: null,
    avatarUrl: null,
    address: emptyAddress(),
    updatedAt: null,
  };
}

/**
 * Fill in anything a stored document is missing.
 *
 * A record written before a field existed must read as that field being unset,
 * not as the field being absent from the object — otherwise every reader grows
 * its own `|| null`, and the one that forgets renders `undefined` at a member.
 */
function hydrate(stored) {
  const empty = emptyProfile();
  if (!stored) return empty;
  const address = { ...empty.address };
  for (const name of ADDRESS_FIELDS) {
    const value = stored.address ? stored.address[name] : null;
    address[name] = value === undefined ? null : value;
  }
  return {
    firstName: stored.firstName === undefined ? null : stored.firstName,
    lastName: stored.lastName === undefined ? null : stored.lastName,
    avatarUrl: stored.avatarUrl === undefined ? null : stored.avatarUrl,
    address,
    updatedAt: stored.updatedAt || null,
  };
}

/** Whether any part of an address has been given. */
function hasAddress(profile) {
  const address = (profile && profile.address) || {};
  return ADDRESS_FIELDS.some((name) => address[name]);
}

/** The profile for a scope. Never null — an unset profile is an empty one. */
async function get(scope) {
  return hydrate(await persistence.get(keyFor(scope)));
}

/**
 * Replace the member-editable half of the profile.
 *
 * A SAVE SENDS THE WHOLE RECORD, NOT A PATCH, and that is a requirement rather
 * than a convenience. Every field is optional, so "absent from the request" has
 * to mean *the member cleared it* — under merge semantics there would be no way
 * to empty an address at all, which is a member who moved and cannot say so.
 *
 * `avatarUrl` is the exception and is NOT read from `values`. It is written by
 * the photo upload and nowhere else. A form that could set it would be a form
 * that can point a member's own avatar at any URL on the internet, which is a
 * stored-content injection with the member's face as the bait — so the field is
 * carried over from the stored document under the lock, never accepted here.
 */
async function save(scope, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new SettingsError(400, 'a profile save needs an object of fields');
  }

  // AN EMPTY OBJECT IS NOT "THE MEMBER CLEARED EVERYTHING" — it is nobody
  // sending a form, and the two are distinguishable so they are distinguished.
  //
  // A save is a replacement, so `{}` would otherwise wipe a name and an address
  // and answer 200, with no signal anywhere. The request that produces it is a
  // client that forgot its `Content-Type` (express hands the route `{}`), not a
  // member — a member who empties every box still posts all eight fields as
  // empty strings, which is a different body and still clears the record.
  // Refusing this costs no legitimate caller anything and closes a silent
  // data-loss path.
  if (Object.keys(values).length === 0) {
    throw new SettingsError(400, 'a profile save sends the whole record; an empty body clears nothing');
  }

  // Validate BEFORE taking the lock and before reading: a request that is going
  // to be refused should not serialize behind anybody or touch storage at all.
  const next = { address: {} };
  for (const name of NAME_FIELDS) next[name] = field(values, name);
  const address = values.address && typeof values.address === 'object' ? values.address : values;
  for (const name of ADDRESS_FIELDS) next.address[name] = field(address, name);

  const key = keyFor(scope);
  return withLock(lockKey(scope), async () => {
    const current = hydrate(await persistence.get(key));
    const record = {
      firstName: next.firstName,
      lastName: next.lastName,
      // Preserved, not accepted. See above.
      avatarUrl: current.avatarUrl,
      address: next.address,
      updatedAt: new Date().toISOString(),
    };
    await persistence.put(key, record);
    logger.info(
      { tenantId: scope.tenantId, userId: scope.userId, address: hasAddress(record) },
      'member profile saved'
    );
    return record;
  });
}

/**
 * Point the profile at a stored photograph, or at nothing.
 *
 * Separate from `save()` because it is a different write by a different route
 * with a different trust level: `save()` carries what a member typed, this
 * carries a URL the blob store MINTED. The two share the lock, so an upload
 * that lands mid-save does not lose the names and a save mid-upload does not
 * lose the photograph.
 *
 * @param {object} scope
 * @param {string|null} avatarUrl  the minted URL, or null to clear it
 * @returns {Promise<object>} the profile as it now stands
 */
async function setAvatarUrl(scope, avatarUrl) {
  const key = keyFor(scope);
  return withLock(lockKey(scope), async () => {
    const current = hydrate(await persistence.get(key));
    const record = { ...current, avatarUrl: avatarUrl || null, updatedAt: new Date().toISOString() };
    await persistence.put(key, record);
    return record;
  });
}

/**
 * What the SESSION carries, as opposed to what the profile holds.
 *
 * Every page draws the header, the header draws the circle and the name, and
 * neither can afford a profile read per request. So these two travel with the
 * session and the record itself is loaded only by the screen that edits it.
 *
 * `displayName` is null when the member has typed no name, and null is the
 * honest answer rather than a fallback invented here: the caller knows what the
 * provider said and this module does not. The precedence — typed, then the
 * provider's, then the email — lives in ONE place, `Recibbi.displayName()` in
 * the shared builders, and duplicating it here would be a second place for it
 * to drift.
 */
function sessionProjection(profile) {
  const p = hydrate(profile);
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  return { displayName: name || null, avatarUrl: p.avatarUrl || null };
}

module.exports = {
  DOC_ID,
  get,
  save,
  setAvatarUrl,
  sessionProjection,
  emptyProfile,
  emptyAddress,
  hasAddress,
  hydrate,
  keyFor,
};
