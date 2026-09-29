'use strict';

// Resolver registry. Resolvers are on-disk code modules shipped with the app
// under src/products/resolvers/, each exporting `resolve` (+ `id`, `meta`,
// `ready`). The active resolver is selected by config.products.resolver
// (PRODUCT_RESOLVER), NOT by request input — there is no user-uploaded code and
// nothing here evals request data, so no RCE surface. Mirrors
// src/receiptProfiles/registry.js.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

const dir = config.products.resolversDir;

let cache = null;

function load() {
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    logger.warn({ err: err.message, dir }, 'product resolvers dir unreadable');
    return map;
  }
  for (const file of files) {
    if (!/\.js$/.test(file)) continue;
    if (file === 'types.js') continue; // type-only module
    const id = file.replace(/\.js$/, '');
    try {
      const mod = require(path.join(dir, file));
      if (typeof mod.resolve !== 'function') {
        logger.warn({ id }, 'resolver has no resolve() export; skipping');
        continue;
      }
      map.set(id, mod);
    } catch (err) {
      logger.warn({ id, err: err.message }, 'failed to load resolver; skipping');
    }
  }
  return map;
}

function registry() {
  if (!cache) cache = load();
  return cache;
}

function has(id) {
  return registry().has(id);
}

function get(id) {
  return registry().get(id) || null;
}

/**
 * The resolver that would name a product NOW: config.products.resolver, which
 * is the first in the PRODUCT_RESOLVER order with a working key -- or the first
 * in the order when none has one (src/settings/providerOrder.js). Null when it
 * names no resolver this engine ships.
 */
function active() {
  return get(config.products.resolver);
}

/** Public-safe listing (id + meta), no function references. */
function list() {
  return [...registry().values()].map((r) => ({ id: r.id, ...(r.meta || { name: r.id }) }));
}

/** Re-scan the directory (used by tests). */
function reload() {
  cache = null;
  return registry();
}

module.exports = { has, get, active, list, reload };
