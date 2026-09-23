'use strict';

// The blob seam. What matters here is not that bytes round-trip — it is that
// the CLIENT'S CLAIM ABOUT THE BYTES IS NEVER BELIEVED, that a blob id alone is
// not a capability, and that nothing outside src/blobs has to know how a URL is
// shaped in order to use one.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useTempDataDir } = require('./helpers/harness');

const tmp = useTempDataDir('blobs-test');

const config = require('../src/config');
const blobs = require('../src/blobs');

const alice = { tenantId: 'acme', userId: 'alice' };
const bob = { tenantId: 'acme', userId: 'bob' };

// Real magic bytes, minimal payloads.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 4)]);

after(() => tmp.cleanup());

test('the four accepted formats are recognised by their bytes', () => {
  assert.equal(blobs.sniff(JPEG).contentType, 'image/jpeg');
  assert.equal(blobs.sniff(PNG).contentType, 'image/png');
  assert.equal(blobs.sniff(WEBP).contentType, 'image/webp');
  assert.equal(blobs.sniff(GIF).contentType, 'image/gif');
});

test('what the uploader CALLS the file is never consulted', async () => {
  // An HTML document named .png with a Content-Type of image/png. The header is
  // the claim being checked, not evidence for it.
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
  assert.throws(() => blobs.sniff(html), (err) => err.status === 415);

  // The plausible near-misses a browser will happily execute or render.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
  assert.throws(() => blobs.sniff(svg), (err) => err.status === 415);
  assert.throws(() => blobs.sniff(Buffer.from('%PDF-1.7\n')), (err) => err.status === 415);
  assert.throws(() => blobs.sniff(Buffer.alloc(0)), (err) => err.status === 400);
});

test('a stored blob answers with a URL the caller does not have to construct', async () => {
  const stored = await blobs.put({ scope: alice, buffer: PNG });
  assert.equal(stored.contentType, 'image/png');
  assert.equal(stored.size, PNG.length);
  assert.ok(stored.url.endsWith(stored.blobId), 'the URL names the blob');
  // The URL is relative: recibbi-ux-main proxies it under its own session, and
  // an absolute one built from PUBLIC_BASE_URL would hardcode an origin that is
  // typically not reachable from a browser at all.
  assert.ok(stored.url.startsWith('/'), `expected a relative URL, got ${stored.url}`);

  const read = await blobs.read(alice, stored.blobId);
  assert.deepEqual(read.buffer, PNG);
  assert.equal(read.contentType, 'image/png');
});

test('a blob id is not a capability — the scope is', async () => {
  const stored = await blobs.put({ scope: alice, buffer: JPEG });
  // Bob holds Alice's id and looks under Bob's own directory. There is no
  // ownership field to compare, so there is no comparison to forget.
  assert.equal(await blobs.read(bob, stored.blobId), null);
  assert.equal(await blobs.read({ tenantId: 'other', userId: 'alice' }, stored.blobId), null);
  assert.ok(await blobs.read(alice, stored.blobId));
});

test('every kind of miss is the same null', async () => {
  assert.equal(await blobs.read(alice, 'ffffffffffffffffffffffffffffffff.png'), null); // never existed
  assert.equal(await blobs.read(alice, 'nope'), null); // malformed
  assert.equal(await blobs.read(alice, '../../../../etc/passwd'), null); // traversal
  assert.equal(await blobs.read(alice, 'aaaaaaaaaaaaaaaa.svg'), null); // a type we do not serve
});

test('a replacement gets a NEW url, so no cache can serve the old face', async () => {
  const first = await blobs.put({ scope: bob, buffer: PNG });
  const second = await blobs.put({ scope: bob, buffer: JPEG });
  assert.notEqual(second.blobId, first.blobId);
  assert.notEqual(second.url, first.url);
});

test('oversize is refused with the limit in the message', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(config.blobs.maxBytes)]);
  await assert.rejects(
    () => blobs.put({ scope: alice, buffer: big }),
    (err) => err.status === 413 && /MB limit/.test(err.message)
  );
});

test('blobIdFromUrl reads only the last segment, and validates it', () => {
  assert.equal(blobIdOf('/api/settings/profile/photo/abcd1234abcd1234abcd1234abcd1234.png'),
    'abcd1234abcd1234abcd1234abcd1234.png');
  // Survives a cache-busting query, because a stored URL may acquire one.
  assert.equal(blobIdOf('/api/settings/profile/photo/abcd1234abcd1234.jpg?v=2'), 'abcd1234abcd1234.jpg');
  // A URL some OTHER backend minted yields null rather than a guess, so its
  // blobs are removed through that backend's bookkeeping and not through a path
  // this function invented.
  assert.equal(blobIdOf('https://cdn.example.com/avatars/whatever'), null);
  assert.equal(blobIdOf('/api/settings/profile/photo/../../secrets'), null);
  assert.equal(blobIdOf(null), null);
  assert.equal(blobIdOf(''), null);
  function blobIdOf(u) { return blobs.blobIdFromUrl(u); }
});

test('bytes land under the owning scope, and nowhere else', async () => {
  const stored = await blobs.put({ scope: alice, buffer: GIF });
  const expected = path.join(tmp.dir, 'acme', 'alice', 'blobs', stored.blobId);
  assert.ok(fs.existsSync(expected), `expected ${expected}`);
  // Beside uploads/, not inside it: the two have different lifetimes.
  assert.ok(!fs.existsSync(path.join(tmp.dir, 'acme', 'alice', 'uploads', stored.blobId)));
  // And no .tmp staging left behind.
  const left = fs.readdirSync(path.join(tmp.dir, 'acme', 'alice', 'blobs')).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(left, []);
});

test('removing is idempotent', async () => {
  const stored = await blobs.put({ scope: alice, buffer: JPEG });
  assert.equal(await blobs.remove(alice, stored.blobId), true);
  assert.equal(await blobs.remove(alice, stored.blobId), false);
  assert.equal(await blobs.read(alice, stored.blobId), null);
});
