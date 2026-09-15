'use strict';

// The blob seam: bytes in, A URL OUT, and nothing on either side knows what
// produced it.
//
// That sentence is the entire design. A member's photograph lives on the host's
// disk today and is meant to live in an object store later, and the only way
// that migration is not a rewrite of every page that draws an avatar is if
// nobody ever RECONSTRUCTS the URL. So `put()` mints one and the caller STORES
// it — `avatarUrl` on the profile is that string, verbatim. No route builds a
// photo URL out of an id, no view interpolates a path, and no client appends
// an extension. Swapping the backend then changes what `put()` returns and
// changes nothing else: an S3 backend hands back an object-store URL and the
// serving route below stops being called at all, without a page moving.
//
// Records written under the previous backend keep working for the same reason:
// their stored URL still says where their bytes are. A migration copies blobs
// and rewrites `avatarUrl`; it does not have to teach anything a second scheme.
//
// WHY THIS IS NOT src/store.js's UPLOADS DIRECTORY. Receipt blobs are written
// by one path and read by one path, both of which already hold the receipt
// record and can derive the filename from it. An avatar has no record to derive
// from at the moment it is served — the whole point is that the URL is the only
// input — so it needs a store that can be addressed by its own key. store.js
// says "a dedicated blob-store abstraction comes later"; this is that seam,
// with the avatar as its first tenant. Receipt images can move onto it without
// this module changing.
//
// SCOPE IS STRUCTURAL. A key is (tenant, user, blobId) and the bytes live under
// that scope's own directory, so a caller asking with the wrong identity looks
// in their own directory, finds nothing, and gets a 404. There is no ownership
// FIELD to compare and therefore no ownership comparison to forget — the same
// property the receipt store gets from its key, and the reason the blob id
// alone is not a capability.

const crypto = require('crypto');
const config = require('../config');
const identity = require('../identity');

const BACKENDS = {
  local: () => require('./backends/local'),
  // TODO(s3): add ./backends/s3 — `put` uploads and returns either a public CDN
  // URL or a presigned one, `read` is then never called because the browser
  // fetches the object directly. Nothing outside this directory changes.
};

let active = null;

function backend() {
  if (active) return active;
  const name = config.blobs.backend;
  const load = BACKENDS[name];
  if (!load) throw new Error(`unknown blob backend "${name}" (expected: local)`);
  active = load();
  return active;
}

class BlobError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'BlobError';
    this.status = status;
  }
}

// What an avatar may be, by MAGIC BYTES rather than by what the client called
// it. A `Content-Type: image/png` header is a claim by the uploader, and the
// uploader is the one party with a reason to lie about it — so the header is
// not consulted at all. The extension the blob is stored under, and the type it
// is later served as, both come from what the bytes actually are.
//
// No SVG. An SVG is a document that can carry script, and serving one from the
// engine's own origin would be a stored cross-site scripting hole with a
// member's face as the lure. Raster formats only.
const SIGNATURES = [
  { ext: '.jpg', contentType: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: '.png',
    contentType: 'image/png',
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: '.webp',
    contentType: 'image/webp',
    test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    ext: '.gif',
    contentType: 'image/gif',
    test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  },
];

const CONTENT_TYPE_BY_EXT = SIGNATURES.reduce((acc, s) => {
  acc[s.ext] = s.contentType;
  return acc;
}, {});

// A blob id as it appears in a URL: random stem + the extension its bytes
// earned. Validated before it is ever used to build a path — the same
// defense-in-depth the identity segments get, and necessary here because this
// one legitimately contains a dot, so it cannot go through isValidSegment().
const BLOB_ID_RE = /^[A-Za-z0-9_-]{8,64}\.(jpg|png|webp|gif)$/;

function isValidBlobId(blobId) {
  return typeof blobId === 'string' && BLOB_ID_RE.test(blobId);
}

/**
 * What these bytes actually are, or a refusal.
 *
 * Sniffed, never trusted. An upload whose first bytes are not one of the four
 * raster signatures is refused whatever it claimed to be — including the
 * plausible near-misses, a PDF and an SVG, which browsers will happily render.
 */
function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new BlobError(400, 'no image uploaded');
  }
  const match = SIGNATURES.find((s) => s.test(buffer));
  if (!match) {
    throw new BlobError(415, 'that file is not a JPEG, PNG, WebP or GIF image');
  }
  return match;
}

/** Fresh, unguessable, and NEW ON EVERY UPLOAD — see put(). */
function newBlobId(ext) {
  return crypto.randomBytes(16).toString('hex') + ext;
}

function requireScope(scope) {
  const { tenantId, userId } = scope || {};
  if (!identity.isValidSegment(tenantId) || !identity.isValidSegment(userId)) {
    throw new identity.IdentityError(400, 'tenant/user identity required to store a blob');
  }
  return { tenantId, userId };
}

/**
 * Store bytes, get back the URL they are now reachable at.
 *
 * The id is random on every upload rather than derived from the scope or from
 * the content, and that is two things at once. It means a REPLACED photograph
 * gets a new URL, so no cache anywhere — browser, proxy, or the member's own
 * open tab — can serve the old face after they changed it; the alternative is a
 * member who uploads a new photo, sees the old one, and uploads it again. And
 * it means the previous blob's URL dies with the blob rather than pointing at
 * somebody's replaced picture.
 *
 * @param {{scope: object, maxBytes?: number, buffer: Buffer}} args
 * @returns {Promise<{blobId, url, contentType, size}>}
 */
async function put({ scope, buffer, maxBytes }) {
  const s = requireScope(scope);
  const limit = maxBytes || config.blobs.maxBytes;
  if (Buffer.isBuffer(buffer) && buffer.length > limit) {
    // 413 rather than 400: the request was well-formed and simply too big, and
    // the member is told the limit rather than being left to bisect it.
    throw new BlobError(413, `that image is larger than the ${Math.round(limit / 1024 / 1024)}MB limit`);
  }
  const kind = sniff(buffer);
  const blobId = newBlobId(kind.ext);
  const url = await backend().put({ scope: s, blobId, buffer, contentType: kind.contentType });
  return { blobId, url, contentType: kind.contentType, size: buffer.length };
}

/**
 * The bytes behind a blob id, within one scope, or null.
 *
 * Null covers every kind of miss — never existed, removed, malformed id, wrong
 * scope — because they are one answer to the caller and telling them apart
 * would confirm to somebody guessing ids which of their guesses named a real
 * photograph belonging to somebody else.
 */
async function read(scope, blobId) {
  if (!isValidBlobId(blobId)) return null;
  const s = requireScope(scope);
  const buffer = await backend().read({ scope: s, blobId });
  if (!buffer) return null;
  return { buffer, contentType: CONTENT_TYPE_BY_EXT[extOf(blobId)] || 'application/octet-stream' };
}

/** Delete a blob. Best effort: a blob that was not there is already gone. */
async function remove(scope, blobId) {
  if (!isValidBlobId(blobId)) return false;
  return backend().remove({ scope: requireScope(scope), blobId });
}

/**
 * The blob id inside a URL this module minted, or null.
 *
 * The ONE permitted direction of inference, and it is deliberately narrow: it
 * is how "remove my photo" finds the bytes behind the URL the profile holds,
 * and how the local backend's serving route recognises its own. It reads the
 * LAST path segment and validates it; it does not parse a scheme, a host or a
 * directory, so a URL minted by a future object-store backend simply yields
 * null and its blobs are removed through that backend's own bookkeeping rather
 * than through a path this function guessed at.
 */
function blobIdFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const withoutQuery = url.split(/[?#]/)[0];
  const last = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  return isValidBlobId(last) ? last : null;
}

function extOf(blobId) {
  return blobId.slice(blobId.lastIndexOf('.'));
}

/** Test-only: drop the cached backend. */
function _reset() {
  active = null;
}

module.exports = {
  BlobError,
  put,
  read,
  remove,
  sniff,
  isValidBlobId,
  blobIdFromUrl,
  backendName: () => config.blobs.backend,
  _reset,
};
