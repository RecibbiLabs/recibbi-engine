'use strict';

// The share table and the unlisted link it opens.
//
// The assertion this file exists for is `resolves a receipt that is not the
// default identity's` below. That is the design atlas's fad83dd regression
// ported: a share token resolved inside a set of receipts arrived at some other
// way — the reader's books, the default scope, a page — mints links that look
// perfectly normal to the member and open the shut door for the recipient. It
// fails against any implementation that scans a scoped list instead of reading
// the row by its token.
//
// Hermetic like the rest of the suite: temp DATA_DIR, fake Redis, stubbed
// queue, the real Express app over a loopback socket.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('shares-test');
installFakeRedis();

// Never open a BullMQ connection: requiring the routes pulls in the queue.
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: { enqueueReceipt: async () => ({ id: 'job' }), receiptsQueue: {}, connection: {} },
};

const config = require('../src/config');
config.publicBaseUrl = 'http://localhost:8080';

const store = require('../src/store');
const shares = require('../src/shares');
const { createApp } = require('../src/app');

let server;
let base;

const bytes = Buffer.alloc(64, 3);

/** A processed receipt under an explicit identity, so scope is never implicit. */
async function receiptFor(tenantId, userId, storeName) {
  const record = await store.createReceipt({
    buffer: bytes,
    mimeType: 'image/png',
    originalName: 'r.png',
    source: 'api',
    tenantId,
    userId,
  });
  return store.update(record.id, {
    status: 'done',
    store: { name: storeName, date: '2026-09-01' },
    items: [{ description: 'Oat milk', qty: 1, price: 4.29 }],
    totals: { subtotal: 4.29, tax: 0.3, total: 4.59, sumOfItems: 4.29, itemCount: 1 },
  });
}

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

// --- the table ------------------------------------------------------------

test('minting twice returns the same token', async () => {
  const r = await receiptFor('main', 'main', 'Aldi');
  const first = await shares.mint(r.id);
  const second = await shares.mint(r.id);
  assert.equal(second.token, first.token);
  assert.equal(second.receiptId, r.id);
});

test('the token says nothing about the receipt it names', async () => {
  const r = await receiptFor('acme', 'alice', 'Costco');
  const { token } = await shares.mint(r.id);
  // The id is `<tenant>:<user>:<cacheId>`. A token derived from one would carry
  // the member's own scope to everybody they send the link to.
  for (const segment of r.id.split(':')) {
    assert.ok(!token.includes(segment), `token leaks "${segment}"`);
  }
  assert.match(token, /^[A-Za-z0-9_-]{16,64}$/);
});

test('revoking kills the link, and revoking twice is not an error', async () => {
  const r = await receiptFor('main', 'main', 'Lidl');
  const { token } = await shares.mint(r.id);
  assert.ok(await shares.resolve(token));
  assert.equal(await shares.revoke(token), true);
  assert.equal(await shares.resolve(token), null);
  assert.equal(await shares.revoke(token), false);
});

test('a revoked receipt can be shared again, with a new token', async () => {
  const r = await receiptFor('main', 'main', 'Tesco');
  const first = await shares.mint(r.id);
  await shares.revoke(first.token);
  const second = await shares.mint(r.id);
  assert.notEqual(second.token, first.token);
  assert.equal(await shares.resolve(first.token), null);
  assert.ok(await shares.resolve(second.token));
});

test('an expired row resolves to nothing, and re-minting replaces it', async () => {
  const r = await receiptFor('main', 'main', 'Rewe');
  const original = config.share.ttlDays;
  try {
    config.share.ttlDays = 1 / 86400000; // one millisecond, as a fraction of a day
    const dead = await shares.mint(r.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await shares.resolve(dead.token), null);
    assert.equal(await shares.forReceipt(r.id), null);

    config.share.ttlDays = 30;
    const live = await shares.mint(r.id);
    assert.notEqual(live.token, dead.token);
    assert.ok(await shares.resolve(live.token));
  } finally {
    config.share.ttlDays = original;
  }
});

test('absence never matches absence', async () => {
  for (const bad of [null, undefined, '', ' ', 'x', '../../etc/passwd', 'has:colons']) {
    assert.equal(await shares.resolve(bad), null, `resolved ${JSON.stringify(bad)}`);
  }
});

// --- the route ------------------------------------------------------------

test('GET /r/:token resolves a receipt that is not the default identity\'s', async () => {
  // THE REGRESSION. This receipt belongs to acme:bob; the engine's default
  // identity is main:main, and neither the request nor the route names acme.
  // An implementation that resolves the token by scanning any scoped set of
  // receipts — the default scope's, the reader's, a page of anybody's books —
  // answers with the shut door here, which is exactly the link the member
  // cannot see is broken.
  const mine = await receiptFor('main', 'main', 'The default scope');
  const theirs = await receiptFor('acme', 'bob', 'Sam\'s Club');
  await shares.mint(mine.id); // the default scope has books of its own

  const res = await fetch(`${base}/api/receipts/${theirs.id}/share`, { method: 'POST' });
  assert.equal(res.status, 201);
  const share = await res.json();
  assert.equal(share.url, `http://localhost:8080/r/${share.token}`);

  const page = await fetch(share.url.replace('http://localhost:8080', base));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Sam&#39;s Club|Sam's Club/);
  assert.match(html, /Oat milk/);
});

test('the page names nobody', async () => {
  const r = await receiptFor('acme', 'carol', 'Migros');
  const { token } = await shares.mint(r.id);
  const html = await (await fetch(`${base}/r/${token}`)).text();

  // The response must not vary by viewer, and must not name the one it is
  // about: no composite id, no tenant, no user, no id-bearing links.
  assert.ok(!html.includes(r.id), 'the page prints the receipt id');
  assert.ok(!html.includes('acme'), 'the page names the tenant');
  assert.ok(!html.includes('carol'), 'the page names the user');
  assert.ok(!html.includes('/api/receipts/'), 'the page links an id-bearing route');
  assert.ok(!html.includes('/receipts/'), 'the page links an id-bearing route');
});

test('a shared page reads the token and never the caller', async () => {
  const r = await receiptFor('acme', 'dora', 'Denner');
  const { token } = await shares.mint(r.id);

  // Identity headers are the engine's whole notion of "who is asking". The
  // answer must be byte-identical whoever sends them, including somebody
  // claiming to be a different tenant entirely.
  const plain = await (await fetch(`${base}/r/${token}`)).text();
  const posing = await (
    await fetch(`${base}/r/${token}`, {
      headers: { 'X-Tenant-Id': 'main', 'X-User-Id': 'main' },
    })
  ).text();
  assert.equal(posing, plain);
});

test('every dead token renders the one page, and says nothing else', async () => {
  const r = await receiptFor('main', 'main', 'Spar');
  const { token } = await shares.mint(r.id);
  await shares.revoke(token);

  const revoked = await fetch(`${base}/r/${token}`);
  const mistyped = await fetch(`${base}/r/${shares.newToken()}`);

  assert.equal(revoked.status, 404);
  assert.equal(mistyped.status, 404);
  const [a, b] = [await revoked.text(), await mistyped.text()];
  assert.equal(a, b, 'revoked and mistyped are distinguishable');
  assert.match(a, /no longer available/);
  // Not an error page: nothing red, nothing to retry, no apology.
  assert.ok(!/error|sorry|try again/i.test(a.replace(/<style[\s\S]*?<\/style>/, '')));
});

test('the shared page is unlisted, and says so in its headers', async () => {
  const r = await receiptFor('main', 'main', 'Coop');
  const { token } = await shares.mint(r.id);
  const res = await fetch(`${base}/r/${token}`);

  // The URL is the credential: a click out of this page must not carry it.
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /<meta name="robots" content="noindex, nofollow">/);

  // A dead token is served the same way — the headers cannot be the tell.
  await shares.revoke(token);
  const dead = await fetch(`${base}/r/${token}`);
  assert.equal(dead.headers.get('referrer-policy'), 'no-referrer');
});

test('GET /api/shares/:token answers with the receipt and no member in it', async () => {
  const r = await receiptFor('acme', 'erin', 'Billa');
  const { token } = await shares.mint(r.id);
  const res = await fetch(`${base}/api/shares/${token}`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.store.name, 'Billa');
  assert.equal(body.items.length, 1);
  assert.equal(body.totals.total, 4.59);
  // Whitelisted: the id, the blob descriptor, the OCR dump and the timings are
  // not "not rendered", they are not in the payload at all.
  for (const leak of ['id', 'tenantId', 'userId', 'image', 'extraction', 'timings']) {
    assert.ok(!(leak in body), `the payload carries "${leak}"`);
  }
  assert.ok(!JSON.stringify(body).includes('erin'));
});

test('a receipt nobody stored cannot be shared', async () => {
  const res = await fetch(`${base}/api/receipts/main:main:deadbeefdeadbeef/share`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('GET /api/receipts/:id/share reports the link without minting one', async () => {
  const r = await receiptFor('main', 'main', 'Edeka');
  const before = await fetch(`${base}/api/receipts/${r.id}/share`);
  assert.equal(before.status, 404);
  assert.equal(await shares.forReceipt(r.id), null, 'asking minted a link');

  const minted = await (await fetch(`${base}/api/receipts/${r.id}/share`, { method: 'POST' })).json();
  const after = await (await fetch(`${base}/api/receipts/${r.id}/share`)).json();
  assert.equal(after.token, minted.token);
});

test('DELETE /api/shares/:token is idempotent', async () => {
  const r = await receiptFor('main', 'main', 'Netto');
  const { token } = await shares.mint(r.id);
  assert.deepEqual(await (await fetch(`${base}/api/shares/${token}`, { method: 'DELETE' })).json(), {
    revoked: true,
  });
  assert.deepEqual(await (await fetch(`${base}/api/shares/${token}`, { method: 'DELETE' })).json(), {
    revoked: false,
  });
  assert.equal((await fetch(`${base}/r/${token}`)).status, 404);
});

test('a synced receipt is described to a stranger without naming the add-on', async () => {
  // `sourceLabel()` reads "Recibbi Link" on the member's own screens, beside a
  // column of other sources (recibbi-ux-design-atlas 2c37670). This page is the
  // one place that deliberately does not use it: the reader has not installed
  // it and has no column to read it against.
  const r = await receiptFor('main', 'main', 'Costco');
  await store.update(r.id, { source: 'sync' });
  const { token } = await shares.mint(r.id);
  const html = await (await fetch(`${base}/r/${token}`)).text();

  assert.match(html, /synced from the retailer/);
  assert.ok(!/Recibbi Link/i.test(html), 'the shared page names the add-on');
  assert.ok(!/via sync/i.test(html), 'the shared page prints the internal word');
});
