'use strict';

// Local-disk blob backend: bytes under the owning scope's own directory, served
// back by the engine's own route.
//
//   <dataDir>/<tenant>/<user>/blobs/<blobId>
//
// Beside `uploads/` (receipt photographs and retailer payloads) rather than
// inside it, because the two have different lifetimes and different readers: an
// upload belongs to one receipt and dies with it, a blob is addressed by its
// own id and outlives whatever pointed at it last.
//
// The URL this mints is served by GET /api/settings/profile/photo/:blobId,
// which resolves the scope from the REQUESTING IDENTITY rather than from the
// URL. So the URL carries no tenant and no user — a member's avatar link does
// not publish which tenant they are in — and two members' photographs with the
// same id (impossible in practice, 16 random bytes) would still be two files.
//
// It is a RELATIVE url, and that is deliberate. recibbi-ux-main proxies this
// under its own session, exactly as it proxies a receipt image, so the host the
// member's browser should ask is that application's host and not the engine's —
// which is typically not reachable from a browser at all. An absolute URL built
// from PUBLIC_BASE_URL would hardcode the wrong origin into a stored record,
// where it would outlive every deployment change that moved the engine.

const fsp = require('fs/promises');
const path = require('path');
const identity = require('../../identity');

// The path prefix the minted URL carries; the route in src/routes/settings.js
// answers at exactly this. One constant, two readers.
const URL_PREFIX = '/api/settings/profile/photo';

function dirFor(scope) {
  // Goes through the identity path helper, which validates both segments —
  // defense in depth against traversal, even though the scope reaching here has
  // already been checked by src/blobs/index.js.
  return identity.userDataDir(scope, 'blobs');
}

function fileFor({ scope, blobId }) {
  return path.join(dirFor(scope), blobId);
}

/**
 * Write the bytes and answer with the URL they are reachable at.
 *
 * Written to a temporary name and renamed, so a reader never sees a half-
 * written photograph — the same atomic-ish write the filesystem persistence
 * backend does, and for the same reason.
 */
async function put({ scope, blobId, buffer }) {
  const target = fileFor({ scope, blobId });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, target);
  return `${URL_PREFIX}/${blobId}`;
}

/** The bytes, or null when there are none under this scope. */
async function read({ scope, blobId }) {
  try {
    return await fsp.readFile(fileFor({ scope, blobId }));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function remove({ scope, blobId }) {
  try {
    await fsp.unlink(fileFor({ scope, blobId }));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = { put, read, remove, URL_PREFIX };
