'use strict';

// Pluggable persistence layer. The app's durable record stores (receipts,
// profile definitions, profile results, product results, and the tenant
// registry) are expressed as generic DOCUMENTS addressed by a key tuple, and a
// backend implements a handful of primitive ops. The active backend is chosen
// by config.persistence.backend (env PERSISTENCE) — exactly like OCR_PROVIDER
// picks the OCR engine — NOT per-record.
//
// A document key is `{ kind, tenant, user, id, sub }`:
//   kind   - logical collection: receipts | receiptProfiles | profileResults |
//            products | tenants | shares | shareIndex
//   tenant - tenant segment (for kind=tenants it just buckets the registry; for
//            kind=shares it is '' — a share row is keyed by its token alone)
//   user   - user segment, or '' for tenant-scoped kinds (receiptProfiles, tenants)
//   id     - primary doc id (cacheId, rp_id, receiptCacheId, tenantId, token)
//   sub    - secondary key, or '' (profileId for profileResults/products)
//
// Backend interface (all async):
//   get(key)        -> value object | null
//   put(key, value) -> value            (atomic upsert; preserves a created-at)
//   delete(key)     -> boolean
//   list(prefix)    -> value object[]    (prefix is a PARTIAL key: kind is
//                      required, then tenant/user/id narrow it. Returns raw docs
//                      UNSORTED — the record stores keep their own sort/filter so
//                      behavior is identical across backends.)
//
// Stores call these primitives instead of touching fs/SQLite directly, so the
// four stores are backend-agnostic and a new backend is a single drop-in module.

const config = require('../config');

const BACKENDS = {
  filesystem: () => require('./backends/filesystem'),
  sqlite: () => require('./backends/sqlite'),
  // TODO(postgresql): add ./backends/postgresql — a jsonb document table mirroring
  // the SQLite schema. Deferred; this branch ships filesystem + sqlite only.
};

let active = null;

function backend() {
  if (active) return active;
  const name = config.persistence.backend;
  if (name === 'postgresql') {
    throw new Error(
      'persistence backend "postgresql" is not implemented yet (TODO) — use "filesystem" or "sqlite"'
    );
  }
  const load = BACKENDS[name];
  if (!load) {
    throw new Error(`unknown persistence backend "${name}" (expected: filesystem | sqlite)`);
  }
  active = load();
  return active;
}

module.exports = {
  get: (key) => backend().get(key),
  put: (key, value) => backend().put(key, value),
  delete: (key) => backend().delete(key),
  list: (prefix) => backend().list(prefix),
  backendName: () => config.persistence.backend,
  // Test-only: drop the cached backend (and close any handle) so a test can
  // exercise a backend module directly without the singleton getting in the way.
  _reset() {
    if (active && typeof active.close === 'function') active.close();
    active = null;
  },
};
