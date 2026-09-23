'use strict';

// The Settings HTTP surface, over the real Express app on a loopback socket.
//
// The assertions worth the file are the last three: that a profile photograph
// never reaches the one route that answers without knowing who is asking, that
// the engine states its own defaults rather than letting a client hardcode
// them, and that flipping "enrich with retailer product page" does not reach
// backwards into receipts that are already in the books.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('settings-routes-test');
installFakeRedis();

// Never open a BullMQ connection.
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async () => ({ id: 'job' }),
    enqueueProcessAndApply: async () => ({ id: 'job' }),
    enqueueProcessApplyAndResolve: async () => ({ id: 'job' }),
    receiptsQueue: {},
    connection: {},
  },
};

const config = require('../src/config');
const store = require('../src/store');
const shares = require('../src/shares');
const tenants = require('../src/tenants');
const { createApp } = require('../src/app');

let server;
let base;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 8)]);

/** A request as recibbi-ux-main makes it: the scope in the headers. */
function as(scope, init = {}) {
  return {
    ...init,
    headers: {
      'X-Tenant-Id': scope.tenantId,
      'X-User-Id': scope.userId,
      ...(init.headers || {}),
    },
  };
}

function json(scope, method, body) {
  return as(scope, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A multipart body with one file part, built by hand (no extra dependency). */
function multipart(field, filename, contentType, bytes) {
  const boundary = '----recibbitest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(scope, filename, contentType, bytes) {
  const part = multipart('photo', filename, contentType, bytes);
  return fetch(`${base}/api/settings/profile/photo`,
    as(scope, { method: 'POST', headers: { 'content-type': part.contentType }, body: part.body }));
}

const alice = { tenantId: 'acme', userId: 'alice' };
const bob = { tenantId: 'acme', userId: 'bob' };

before(async () => {
  config.publicBaseUrl = 'http://localhost:8080';
  // Tenants are provisioned accounts; the accept path rejects an unknown one.
  await tenants.register('acme');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

// --- the screen in one read -------------------------------------------------

test('GET /api/settings draws the whole screen, defaults included', async () => {
  const res = await fetch(`${base}/api/settings`, as(alice));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.profile.firstName, null);
  assert.deepEqual(body.retailers, {});
  // THE ENGINE STATES ITS OWN DEFAULTS. A client that hardcoded these would
  // disagree the day an operator changed RETAILER_ENRICH_DEFAULT, and disagree
  // silently — a switch reading "off" over books that are being enriched.
  assert.deepEqual(body.defaults.retailers, { productIcons: true, enrichFromRetailer: false });
});

// --- profile ----------------------------------------------------------------

test('a profile round-trips, and a ZIP code alone is accepted', async () => {
  const res = await fetch(`${base}/api/settings/profile`,
    json(alice, 'PUT', { firstName: 'Ada', lastName: 'Member', postalCode: '78704' }));
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.address.postalCode, '78704');
  assert.equal(saved.address.line1, null);
  assert.ok(saved.updatedAt);

  const again = await (await fetch(`${base}/api/settings/profile`, as(alice))).json();
  assert.equal(again.firstName, 'Ada');
});

test('an over-long field is a 400 that names the limit', async () => {
  const res = await fetch(`${base}/api/settings/profile`,
    json(alice, 'PUT', { firstName: 'x'.repeat(200) }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /firstName is longer than 60/);
});

test('one member\'s profile is not another\'s', async () => {
  await fetch(`${base}/api/settings/profile`, json(bob, 'PUT', { firstName: 'Bo' }));
  const a = await (await fetch(`${base}/api/settings/profile`, as(alice))).json();
  const b = await (await fetch(`${base}/api/settings/profile`, as(bob))).json();
  assert.equal(a.firstName, 'Ada');
  assert.equal(b.firstName, 'Bo');
});

// --- the photograph ---------------------------------------------------------

test('a photo is stored, served back, and replaced at a new URL', async () => {
  const res = await upload(alice, 'me.png', 'image/png', PNG);
  assert.equal(res.status, 201);
  const profile = await res.json();
  assert.ok(profile.avatarUrl, 'the profile now points at a photograph');
  // The name survived the upload — a photo write must not clobber the form.
  assert.equal(profile.firstName, 'Ada');

  const served = await fetch(`${base}${profile.avatarUrl}`, as(alice));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('cache-control'), /private/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  const replaced = await (await upload(alice, 'me.jpg', 'image/jpeg', JPEG)).json();
  assert.notEqual(replaced.avatarUrl, profile.avatarUrl);
  // The replaced bytes are gone, so no cache anywhere can serve the old face.
  assert.equal((await fetch(`${base}${profile.avatarUrl}`, as(alice))).status, 404);
});

test('an upload is judged by its bytes, not by what it claims to be', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const res = await upload(bob, 'avatar.png', 'image/png', html);
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /not a JPEG, PNG, WebP or GIF/);
});

test('a member cannot fetch another member\'s photograph with its URL', async () => {
  const mine = await (await upload(alice, 'me.png', 'image/png', PNG)).json();
  // Bob has the URL — it is a plain path with no secret in it — and asks with
  // his own identity. He looks in his own directory and finds nothing.
  assert.equal((await fetch(`${base}${mine.avatarUrl}`, as(bob))).status, 404);
  assert.equal((await fetch(`${base}${mine.avatarUrl}`, as(alice))).status, 200);
});

test('removing the photo clears the profile and the bytes', async () => {
  const before = await (await upload(bob, 'b.png', 'image/png', PNG)).json();
  const after = await (await fetch(`${base}/api/settings/profile/photo`, as(bob, { method: 'DELETE' }))).json();
  assert.equal(after.avatarUrl, null);
  assert.equal(after.firstName, 'Bo'); // and nothing else was touched
  assert.equal((await fetch(`${base}${before.avatarUrl}`, as(bob))).status, 404);
});

test('A MEMBER\'S FACE NEVER REACHES THE SHARED RECEIPT VIEW', async () => {
  // /r/:token is the one route that answers without knowing who is asking. It
  // is scoped by the token and by nothing else, so there is no member whose
  // photograph could be on it — and the whitelist in routes/shares.js is what
  // keeps that true as fields are added. This asserts it rather than trusting it.
  await upload(alice, 'me.png', 'image/png', PNG);
  const receipt = await store.createReceipt({
    buffer: PNG, mimeType: 'image/png', originalName: 'r.png', source: 'api',
    tenantId: alice.tenantId, userId: alice.userId,
  });
  await store.update(receipt.id, {
    status: 'done',
    store: { name: "Sam's Club", date: '2026-09-01' },
    items: [{ description: 'Oat milk', qty: 1, price: 4.29 }],
  });
  const { token } = await shares.mint(receipt.id);

  const asJson = await (await fetch(`${base}/api/shares/${token}`)).json();
  const text = JSON.stringify(asJson);
  assert.ok(!/avatar/i.test(text), 'the shared record mentions an avatar');
  assert.ok(!/firstName|Ada/.test(text), 'the shared record carries the member\'s name');

  const page = await (await fetch(`${base}/r/${token}`)).text();
  assert.ok(!/avatar/i.test(page), 'the shared page draws an avatar');
});

// --- retailer switches ------------------------------------------------------

test('a switch flips, and the response says what was actually stored', async () => {
  const res = await fetch(`${base}/api/settings/retailers/samsclub.com`,
    json(alice, 'PUT', { productIcons: false }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.retailerId, 'samsclub');
  assert.equal(body.settings.productIcons, false);
  assert.ok(body.settings.updatedAt);

  const all = await (await fetch(`${base}/api/settings/retailers`, as(alice))).json();
  assert.equal(all.retailers.samsclub.productIcons, false);
  // Untouched switches stay UNSET rather than being written at their default —
  // "unset" and "explicitly the default" differ the day a default changes.
  assert.equal(all.retailers.samsclub.enrichFromRetailer, undefined);
});

test('a switch nested under `settings` is accepted too', async () => {
  const res = await fetch(`${base}/api/settings/retailers/samsclub`,
    json(bob, 'PUT', { settings: { enrichFromRetailer: true } }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).settings.enrichFromRetailer, true);
});

test('an unknown switch is a 400 that names the ones there are', async () => {
  const res = await fetch(`${base}/api/settings/retailers/samsclub`, json(alice, 'PUT', { darkMode: true }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown retailer setting "darkMode".*productIcons \| enrichFromRetailer/);
});

// --- the reach of the second switch -----------------------------------------

test('"enrich with retailer product page" reaches FORWARD only', async () => {
  // The screen promises: "Applies to receipts imported from here on. N Sam's
  // Club receipts already in your books were read under the previous answer and
  // are not read again." This is that promise, asserted.
  const scope = { tenantId: 'acme', userId: 'reacher' };

  const accept = require('../src/ingest/acceptService');
  const reqFor = (s) => ({ get: (h) => ({ 'X-Tenant-Id': s.tenantId, 'X-User-Id': s.userId }[h]), body: {}, query: {} });

  // Imported BEFORE the switch: the deployment default, enriched from the web.
  const before = await accept.resolveContext(reqFor(scope), {
    enrichByDefault: config.retailers.enrichByDefault, retailerId: 'samsclub.com',
  });
  assert.equal(before.enrich, false);
  assert.equal(before.enrichSource, 'web');

  await fetch(`${base}/api/settings/retailers/samsclub`, json(scope, 'PUT', { enrichFromRetailer: true }));

  // Imported AFTER: the member's standing answer applies.
  const after = await accept.resolveContext(reqFor(scope), {
    enrichByDefault: config.retailers.enrichByDefault, retailerId: 'samsclub.com',
  });
  assert.equal(after.enrich, true);
  assert.equal(after.enrichSource, 'retailer');

  // And the answer is FROZEN onto the record, so a retry or a re-normalization
  // reads an old receipt exactly as it was read the first time.
  const { enrichmentSource } = require('../src/pipeline');
  assert.equal(enrichmentSource({ options: { enrich: false, enrichSource: 'web' } }), 'web');
  assert.equal(enrichmentSource({ options: { enrich: true, enrichSource: 'retailer' } }), 'retailer');
  // A receipt written before any of this existed was enriched by the web search.
  assert.equal(enrichmentSource({}), 'web');
});

test('an explicit enrich= on one upload still beats the standing setting', async () => {
  const scope = { tenantId: 'acme', userId: 'override' };
  await fetch(`${base}/api/settings/retailers/samsclub`, json(scope, 'PUT', { enrichFromRetailer: true }));
  const accept = require('../src/ingest/acceptService');
  const req = {
    get: (h) => ({ 'X-Tenant-Id': scope.tenantId, 'X-User-Id': scope.userId }[h]),
    body: {}, query: { enrich: '0' },
  };
  const ctx = await accept.resolveContext(req, { enrichByDefault: false, retailerId: 'samsclub.com' });
  assert.equal(ctx.enrich, false);
  // Nothing happened, so the record must not claim a source for it.
  assert.equal(ctx.enrichSource, 'web');
});
