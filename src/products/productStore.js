'use strict';

const identity = require('../identity');
const persistence = require('../persistence');

// Product results live OUTSIDE the receipt record, one document per source
// receipt profile, scoped to the receipt's tenant/user (private, like the
// receipt) and persisted through the pluggable persistence layer:
//   kind='products', { tenant, user, id: receiptCacheId, sub: receiptProfileId }
// Keyed on the source profile id (resolution always follows an applied profile).
// The result's `receiptId` is the COMPOSITE receipt id, parsed (src/identity.js)
// to derive the key. Mirrors receiptProfiles/resultStore.js.

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
  const { receiptId, receiptProfileId } = result;
  const s = scopeOf(receiptId);
  if (!s) throw new identity.IdentityError(400, `cannot save products for invalid receipt id "${receiptId}"`);
  await persistence.put(
    { kind: 'products', tenant: s.tenant, user: s.user, id: s.id, sub: receiptProfileId },
    result
  );
  return result;
}

async function get(receiptId, profileId) {
  const s = scopeOf(receiptId);
  if (!s) return null;
  return persistence.get({ kind: 'products', tenant: s.tenant, user: s.user, id: s.id, sub: profileId });
}

async function list(receiptId) {
  const s = scopeOf(receiptId);
  if (!s) return [];
  const out = await persistence.list({ kind: 'products', tenant: s.tenant, user: s.user, id: s.id });
  out.sort((a, b) => (a.resolvedAt < b.resolvedAt ? 1 : -1));
  return out;
}

// Every product result for one identity (default scope), newest first.
async function listAll(scope) {
  const s = defaultScope(scope);
  let out;
  try {
    out = await persistence.list({ kind: 'products', tenant: s.tenant, user: s.user });
  } catch {
    return [];
  }
  out.sort((a, b) => (a.resolvedAt < b.resolvedAt ? 1 : -1));
  return out;
}

// Every result filed for one receipt, removed -- for the trash's purge, which
// is the end of the receipt and so the end of everything keyed by it.
async function removeAll(receiptId) {
  const s = scopeOf(receiptId);
  if (!s) return 0;
  let removed = 0;
  for (const r of await persistence.list({ kind: 'products', tenant: s.tenant, user: s.user, id: s.id })) {
    if (await persistence.delete({ kind: 'products', tenant: s.tenant, user: s.user, id: s.id, sub: r.receiptProfileId })) removed += 1;
  }
  return removed;
}

module.exports = { save, get, list, listAll, removeAll };
