'use strict';

// The retailer JSON ingest HTTP surface, driven against the REAL Express app
// over a loopback socket. Hermetic the same way routes.test.js is: a temp
// DATA_DIR, an in-memory fake Redis, and a stubbed queue so no BullMQ/Redis
// connection is ever opened — here the stub also records WHICH flow was queued.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('retailer-routes-test');
installFakeRedis(); // /health + the dedupe index

// Replace src/queue before anything requires it, and record the flow shape so
// the tests can prove a JSON upload reuses the SAME flows as a photo upload.
const queued = [];
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async (id) => (queued.push({ flow: 'process-receipt', id }), { id }),
    enqueueProcessAndApply: async (id, profileId) => (queued.push({ flow: 'process+apply', id, profileId }), { id }),
    enqueueProcessApplyAndResolve: async (id, profileId) => (queued.push({ flow: 'process+apply+resolve', id, profileId }), { id }),
    connection: {},
  },
};

const config = require('../src/config');
config.publicBaseUrl = 'http://localhost:8080';

const store = require('../src/store');
const { createApp } = require('../src/app');

const FIXTURES = path.join(__dirname, 'fixtures', 'retailers', 'samsclub');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

let server;
let base;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

beforeEach(() => {
  queued.length = 0;
});

const ENDPOINT = (retailer = 'samsclub.com', qs = '') =>
  `${base}/api/retailer:${retailer}/receipts${qs}`;

function postJson(payload, { retailer = 'samsclub.com', qs = '', headers = {} } = {}) {
  return fetch(ENDPOINT(retailer, qs), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

// --- Discovery ---------------------------------------------------------------

test('GET /api/retailers lists what this deployment can read', async () => {
  const res = await fetch(`${base}/api/retailers`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const sams = body.find((r) => r.id === 'samsclub.com');
  assert.ok(sams, 'the Sam\'s Club adapter is advertised');
  assert.equal(sams.name, "Sam's Club");
});

test('/health reports the registered retailers', async () => {
  const res = await fetch(`${base}/health`);
  const body = await res.json();
  assert.ok(body.retailers.includes('samsclub.com'));
});

// --- The happy path ----------------------------------------------------------

test('POST a retailer payload as a JSON body -> 202, record persisted, job queued', async () => {
  const res = await postJson(fixture('scan-and-go.json'));
  assert.equal(res.status, 202);
  const body = await res.json();

  assert.equal(body.retailer, 'samsclub.com');
  assert.equal(body.orderId, '00769925960064747015');
  assert.equal(body.displayId, '0076 9925 9600 6474 7015');
  assert.equal(body.status, 'queued');
  assert.equal(body.enrich, false, 'off by default for retailer payloads');
  // The same links a photo upload answers with.
  assert.equal(body.statusUrl, `http://localhost:8080/api/receipts/${body.id}`);
  assert.equal(body.viewUrl, `http://localhost:8080/receipts/${body.id}/view`);
  assert.equal(body.profileId, null);

  const record = await store.get(body.id);
  assert.equal(record.kind, 'json');
  assert.equal(record.retailer, 'samsclub.com');
  assert.equal(record.status, 'queued');
  assert.equal(record.origin.externalId, 'samsclub.com:00769925960064747015');
  assert.equal(record.options.enrich, false);
  assert.equal(record.document.mimeType, 'application/json');
  assert.ok(record.document.size > 0);
  assert.equal(record.image, undefined, 'a JSON receipt has no image block');

  // The payload was stored verbatim.
  const stored = await store.readDocument(record);
  assert.equal(stored.detail.priceDetails.subTotal.value, 39.66);

  assert.deepEqual(queued, [{ flow: 'process-receipt', id: body.id }], 'the ordinary single-job flow');
});

test('POST the payload as a multipart .json file works the same way', async () => {
  const payload = Buffer.from(JSON.stringify(fixture('fuel.json')));
  const fd = new FormData();
  fd.append('receipt', new Blob([payload], { type: 'application/json' }), 'order.json');
  fd.append('source', 'cli');

  const res = await fetch(ENDPOINT(), { method: 'POST', body: fd });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.orderId, '05320328058895178882');

  const record = await store.get(body.id);
  assert.equal(record.source, 'cli');
  assert.equal(record.document.originalName, 'order.json');
});

test('a retailer id resolves through the registry aliases', async () => {
  const res = await postJson(fixture('savings.json'), { retailer: 'samsclub', qs: '?dedupe=0' });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).retailer, 'samsclub.com', 'answered with the canonical id');
});

// --- Rejections --------------------------------------------------------------

test('an unregistered retailer -> 400, and names what is registered', async () => {
  const res = await postJson(fixture('scan-and-go.json'), { retailer: 'costco.com' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /unknown retailer "costco\.com"/);
  assert.match(body.error, /samsclub\.com/, 'tells the client what it could have posted');
  assert.equal(queued.length, 0, 'nothing queued');
});

test("a payload for the wrong retailer -> 400 before anything is queued", async () => {
  // Shaped like a receipt, but not this retailer's envelope.
  const res = await postJson({ orderId: '1', store: 'Costco', items: [{ name: 'milk', price: 3.5 }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /does not look like a samsclub\.com receipt/);
  assert.equal(queued.length, 0);
});

test('an empty or non-object body -> 400', async () => {
  const empty = await postJson({});
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /No receipt payload/);

  const array = await fetch(ENDPOINT(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([1, 2, 3]),
  });
  assert.equal(array.status, 400);
});

test('a multipart upload that is not JSON -> 400', async () => {
  const fd = new FormData();
  fd.append('receipt', new Blob([Buffer.from('not json at all')], { type: 'application/json' }), 'order.json');
  const res = await fetch(ENDPOINT(), { method: 'POST', body: fd });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
});

test('an image posted to the JSON endpoint is refused', async () => {
  const fd = new FormData();
  fd.append('receipt', new Blob([Buffer.alloc(64, 7)], { type: 'image/png' }), 'receipt.png');
  const res = await fetch(ENDPOINT(), { method: 'POST', body: fd });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Only JSON receipt payloads/);
});

test('an unknown tenant -> 400', async () => {
  const res = await postJson(fixture('scan-and-go.json'), { headers: { 'X-Tenant-Id': 'nope' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown tenant "nope"/);
});

test('an unknown profile -> 400', async () => {
  const res = await postJson(fixture('scan-and-go.json'), { qs: '?profileId=rp_missing&dedupe=0' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown profile "rp_missing"/);
  assert.equal(queued.length, 0);
});

// --- Options -----------------------------------------------------------------

test('enrich=1 opts a single upload back into enrichment', async () => {
  const res = await postJson(fixture('electronic-voided.json'), { qs: '?enrich=1' });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.enrich, true);
  assert.equal((await store.get(body.id)).options.enrich, true);
});

test('a profile on the upload queues the deeper flow, exactly as a photo does', async () => {
  const profileStore = require('../src/receiptProfiles/profileStore');
  const profile = await profileStore.create(
    { name: 'samsJson', transformer: 'usGrocery', config: {} },
    { tenantId: config.defaultTenantId }
  );

  const res = await postJson(fixture('returned.json'), { qs: `?profileId=${profile.id}&resolveProducts=0` });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.profileId, profile.id);
  assert.equal(body.profileResultUrl, `http://localhost:8080/api/receipts/${body.id}/profileResults/${profile.id}`);
  assert.deepEqual(queued, [{ flow: 'process+apply', id: body.id, profileId: profile.id }]);
});

test('a profile plus products queues the three-level flow', async () => {
  const profileStore = require('../src/receiptProfiles/profileStore');
  const profile = await profileStore.get('samsJson', { tenantId: config.defaultTenantId });
  const res = await postJson(fixture('two-groups.json'), { qs: `?profileId=${profile.id}&resolveProducts=1` });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.productsUrl, `http://localhost:8080/api/receipts/${body.id}/products/${profile.id}`);
  assert.deepEqual(queued, [{ flow: 'process+apply+resolve', id: body.id, profileId: profile.id }]);
});

// --- Identity ----------------------------------------------------------------

test('a JSON receipt is scoped to the uploading identity like any other', async () => {
  const tenants = require('../src/tenants');
  await tenants.register('acme');
  const res = await postJson(fixture('delivery-glass.json'), {
    headers: { 'X-Tenant-Id': 'acme', 'X-User-Id': 'kim' },
  });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  assert.match(id, /^acme:kim:/, 'the composite id carries its own scope');
  const record = await store.get(id);
  assert.equal(record.tenantId, 'acme');
  assert.equal(record.userId, 'kim');
});

// --- Idempotency -------------------------------------------------------------

test('re-posting the same order returns the receipt already ingested', async () => {
  const payload = fixture('items-check-fails.json');
  const first = await postJson(payload);
  assert.equal(first.status, 202);
  const firstBody = await first.json();

  queued.length = 0;
  const second = await postJson(payload);
  assert.equal(second.status, 200, 'not a second 202');
  const secondBody = await second.json();
  assert.equal(secondBody.id, firstBody.id, 'the same receipt');
  assert.equal(secondBody.duplicateOf, firstBody.id);
  assert.equal(queued.length, 0, 'and no second job');
});

test('dedupe=0 forces a fresh receipt for the same order', async () => {
  const payload = fixture('tire-addons.json');
  const first = await (await postJson(payload)).json();
  queued.length = 0;
  const res = await postJson(payload, { qs: '?dedupe=0' });
  assert.equal(res.status, 202, 'a fresh 202, not the 200 a duplicate gets');
  const second = await res.json();
  assert.notEqual(second.id, first.id);
  assert.equal(queued.length, 1, 'the forced re-ingest was queued');
});

test('the same order under a different identity is a different receipt', async () => {
  const payload = fixture('electronic-voided.json');
  const mine = await (await postJson(payload)).json();
  const res = await postJson(payload, { headers: { 'X-Tenant-Id': 'acme', 'X-User-Id': 'kim' } });
  assert.equal(res.status, 202, 'not deduped against the other identity\'s copy');
  const theirs = await res.json();
  assert.notEqual(theirs.id, mine.id, 'the dedupe index is scoped per tenant+user');
  assert.match(theirs.id, /^acme:kim:/);
});

// --- Reading it back ---------------------------------------------------------

test('the stored payload is served back at /receipts/:id/payload', async () => {
  const { id } = await (await postJson(fixture('fuel.json'), { qs: '?dedupe=0' })).json();
  const res = await fetch(`${base}/receipts/${id}/payload`);
  assert.equal(res.status, 200);
  const served = await res.json();
  assert.equal(served.summary.orderId, '05320328058895178882');
});

test('a photographed receipt has no payload to serve', async () => {
  const created = await store.createReceipt({
    buffer: Buffer.alloc(32, 1),
    mimeType: 'image/png',
    originalName: 'r.png',
    source: 'api',
  });
  const res = await fetch(`${base}/receipts/${created.id}/payload`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /uploaded as an image/);
});

test('a JSON receipt renders in the shared web view, linking to its payload', async () => {
  const { id } = await (await postJson(fixture('savings.json'), { qs: '?dedupe=0' })).json();
  const res = await fetch(`${base}/receipts/${id}/view`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`/receipts/${id}/payload`), 'provenance link points at the payload');
  assert.ok(!html.includes('view original photo'), 'and not at a photo it does not have');
  assert.ok(html.includes('samsclub.com'));
});

test('JSON and photo receipts list together', async () => {
  const res = await fetch(`${base}/api/receipts`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.length > 1);
  assert.ok(body.every((r) => r.statusUrl && r.viewUrl), 'one list shape for both kinds');
});
