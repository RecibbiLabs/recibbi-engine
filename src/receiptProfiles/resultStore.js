'use strict';

const identity = require('../identity');
const persistence = require('../persistence');

// Profile results live OUTSIDE the receipt record, one document per applied
// profile, scoped to the receipt's tenant/user (private, like the receipt) and
// persisted through the pluggable persistence layer:
//   kind='profileResults', { tenant, user, id: receiptCacheId, sub: profileId }
// The result's `receiptId` is the COMPOSITE receipt id, which the store parses
// (src/identity.js) to derive the key. Keyed on the profile id (stable across
// renames). listAll/listByProfile take an explicit scope (default identity)
// since they have no receipt id to derive it from.

// Per-receipt key parts from a composite (or bare) receipt id; null if malformed.
function scopeOf(receiptId) {
  try {
    const { tenantId, userId, cacheId } = identity.resolveId(receiptId);
    return { tenant: tenantId, user: userId, id: cacheId };
  } catch {
    return null;
  }
}

function defaultScope(scope = {}) {
  const def = identity.defaultScope();
  return { tenant: scope.tenantId || def.tenantId, user: scope.userId || def.userId };
}

async function save(result) {
  const { receiptId, profileId } = result;
  const s = scopeOf(receiptId);
  if (!s) throw new identity.IdentityError(400, `cannot save result for invalid receipt id "${receiptId}"`);
  await persistence.put({ kind: 'profileResults', tenant: s.tenant, user: s.user, id: s.id, sub: profileId }, result);
  return result;
}

async function get(receiptId, profileId) {
  const s = scopeOf(receiptId);
  if (!s) return null;
  return persistence.get({ kind: 'profileResults', tenant: s.tenant, user: s.user, id: s.id, sub: profileId });
}

async function list(receiptId) {
  const s = scopeOf(receiptId);
  if (!s) return [];
  const out = await persistence.list({ kind: 'profileResults', tenant: s.tenant, user: s.user, id: s.id });
  out.sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1));
  return out;
}

// Every result for one identity, newest first.
async function listAll(scope) {
  const s = defaultScope(scope);
  let out;
  try {
    out = await persistence.list({ kind: 'profileResults', tenant: s.tenant, user: s.user });
  } catch {
    return [];
  }
  out.sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1));
  return out;
}

// Every result for one profile (within one identity), newest first. Results are
// keyed by profile id, so callers pass an id (resolve a name upstream).
async function listByProfile(profileId, scope) {
  const all = await listAll(scope);
  return all.filter((r) => r.profileId === profileId);
}

// Every result filed for one receipt, removed -- for the trash's purge, which
// is the end of the receipt and so the end of everything keyed by it.
async function removeAll(receiptId) {
  const s = scopeOf(receiptId);
  if (!s) return 0;
  let removed = 0;
  for (const r of await persistence.list({ kind: 'profileResults', tenant: s.tenant, user: s.user, id: s.id })) {
    if (await persistence.delete({ kind: 'profileResults', tenant: s.tenant, user: s.user, id: s.id, sub: r.profileId })) removed += 1;
  }
  return removed;
}

module.exports = { save, get, list, listAll, listByProfile, removeAll };
