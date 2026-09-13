'use strict';

// Filesystem persistence backend — the original approach, kept under the name
// `filesystem`. A faithful reproduction of the on-disk layout the record stores
// used before the persistence abstraction existed, so pre-existing data and the
// whole test suite keep working unchanged:
//
//   receipts         <data>/<tenant>/<user>/receipts/<id>.json
//   receiptProfiles  <data>/<tenant>/receiptProfiles/<id>.json        (tenant-scoped)
//   profileResults   <data>/<tenant>/<user>/profileResults/<id>/<sub>.json
//   products         <data>/<tenant>/<user>/products/<id>/<sub>.json
//   tenants          <data>/.registry/tenants/<id>.json               (global)
//   shares           <data>/.registry/shares/<token>.json             (global)
//   shareIndex       <data>/<tenant>/<user>/shareIndex/<id>.json
//
// `.registry` is not a valid id segment (src/identity.js SEGMENT_RE excludes
// `.`), so the global registry dir can never collide with a real tenant dir.
//
// `shares` is GLOBAL for the same reason the tenant registry is, but the reason
// is load-bearing here rather than incidental: a share row is addressed by its
// token and by NOTHING else. Filing it under the minting member's tenant would
// mean a reader has to know whose receipt it is before they can find out whose
// receipt it is. `shareIndex` is the reverse lookup (receipt -> its token) and
// IS scoped, because minting already has the receipt, and its scope, in hand.

const fsp = require('fs/promises');
const path = require('path');
const config = require('../../config');
const identity = require('../../identity');

const REGISTRY_DIR = '.registry';

// The directory that holds a key's document file(s). Reuses the identity path
// helpers (which validate segments — defense-in-depth against traversal).
function baseDirFor(key) {
  const { kind, tenant, user } = key;
  if (kind === 'tenants') return path.join(config.dataDir, REGISTRY_DIR, 'tenants');
  if (kind === 'shares') return path.join(config.dataDir, REGISTRY_DIR, 'shares');
  if (user) return identity.userDataDir({ tenantId: tenant, userId: user }, kind);
  return identity.tenantDataDir(tenant, kind);
}

// The full path to one document. Sub-keyed kinds nest one level: <id>/<sub>.json.
function fileFor(key) {
  const base = baseDirFor(key);
  return key.sub ? path.join(base, key.id, `${key.sub}.json`) : path.join(base, `${key.id}.json`);
}

async function get(key) {
  try {
    return JSON.parse(await fsp.readFile(fileFor(key), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function put(key, value) {
  const target = fileFor(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, target); // atomic-ish write (same as the old stores)
  return value;
}

async function del(key) {
  try {
    await fsp.unlink(fileFor(key));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// Read every *.json file directly in `dir` (one level). Tolerant: missing dir
// -> [], unreadable/partial file -> skipped. Ignores the `.tmp` write staging.
async function readJsonDir(dir) {
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

async function list(prefix) {
  const { kind, id } = prefix;
  const subKeyed = kind === 'profileResults' || kind === 'products';
  if (subKeyed) {
    // One receipt's results (id given) — read its subdir directly.
    if (id) return readJsonDir(path.join(baseDirFor(prefix), id));
    // All results for the scope — walk each receipt subdir and flatten.
    const root = baseDirFor(prefix);
    let dirents;
    try {
      dirents = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      out.push(...(await readJsonDir(path.join(root, d.name))));
    }
    return out;
  }
  // Flat kinds (receipts / receiptProfiles / tenants): read the base dir.
  return readJsonDir(baseDirFor(prefix));
}

module.exports = { get, put, delete: del, list };
