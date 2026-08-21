'use strict';

// Retailer adapter registry. Adapters are on-disk code modules shipped with the
// app under src/retailers/adapters/, each exporting `id`, `detect` and
// `normalize` (+ optional `aliases`, `meta`) — see adapters/types.js.
//
// A request selects one by the retailer id in its URL
// (`/api/retailer:samsclub.com/receipts`), resolved through the Map built here.
// The id NEVER becomes a module path and nothing evals request input, so this
// is a lookup, not a loader — same posture as src/receiptProfiles/registry.js
// and src/products/registry.js, which this mirrors.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

const dir = config.retailers.adaptersDir;

let cache = null;

// Ids and aliases are matched case- and punctuation-insensitively so
// `SamsClub.com`, `samsclub`, and `sams-club` all reach the same adapter.
function normalizeKey(id) {
  return String(id == null ? '' : id).trim().toLowerCase().replace(/[\s_']/g, '-');
}

function load() {
  const map = new Map(); // lookup key -> adapter (aliases share the object)
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    logger.warn({ err: err.message, dir }, 'retailer adapters dir unreadable');
    return map;
  }
  for (const file of files) {
    if (!/\.js$/.test(file)) continue;
    if (file === 'types.js') continue; // contract-only module
    const fallbackId = file.replace(/\.js$/, '');
    try {
      const mod = require(path.join(dir, file));
      if (typeof mod.normalize !== 'function') {
        logger.warn({ id: fallbackId }, 'retailer adapter has no normalize() export; skipping');
        continue;
      }
      const adapter = {
        id: mod.id || fallbackId,
        aliases: Array.isArray(mod.aliases) ? mod.aliases : [],
        meta: mod.meta || { name: mod.id || fallbackId },
        // An adapter without detect() accepts anything object-shaped.
        detect: typeof mod.detect === 'function' ? mod.detect : () => true,
        normalize: mod.normalize,
      };
      for (const key of [adapter.id, ...adapter.aliases]) {
        const k = normalizeKey(key);
        if (!k) continue;
        const clash = map.get(k);
        if (clash && clash.id !== adapter.id) {
          logger.warn({ key: k, kept: clash.id, skipped: adapter.id }, 'retailer alias collision; keeping the first');
          continue;
        }
        map.set(k, adapter);
      }
    } catch (err) {
      logger.warn({ id: fallbackId, err: err.message }, 'failed to load retailer adapter; skipping');
    }
  }
  return map;
}

function registry() {
  if (!cache) cache = load();
  return cache;
}

function has(id) {
  return registry().has(normalizeKey(id));
}

function get(id) {
  return registry().get(normalizeKey(id)) || null;
}

/** Public-safe listing (id + aliases + meta), one entry per adapter. */
function list() {
  const seen = new Map();
  for (const adapter of registry().values()) {
    if (!seen.has(adapter.id)) {
      seen.set(adapter.id, { id: adapter.id, aliases: adapter.aliases, ...adapter.meta });
    }
  }
  return [...seen.values()];
}

/** Re-scan the directory (used by tests). */
function reload() {
  cache = null;
  return registry();
}

module.exports = { has, get, list, reload, normalizeKey };
