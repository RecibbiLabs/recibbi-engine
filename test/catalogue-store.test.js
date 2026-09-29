'use strict';

// The catalogue at rest: indexing a receipt, the verifier, the rebuild, naming
// a product across its receipts, and remembering that name. Runs against the
// SQLITE backend (the deployment default); the filesystem backend gets the one
// case that differs -- listing a sub-keyed kind -- at the bottom.
//
// THE VERIFIER IS MADE TO FAIL ON PURPOSE, in each of the ways it claims to
// detect. A check that passes for everything checks nothing.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, useTempSqlite } = require('./helpers/harness');

const tmp = useTempDataDir('catalogue-store-test');
const db = useTempSqlite('catalogue-store-sqlite');

const persistence = require('../src/persistence');
const store = require('../src/store');
const catalogue = require('../src/catalogue');

after(() => {
  persistence._reset();
  db.cleanup();
  tmp.cleanup();
});

const ME = { tenantId: 'tenantA', userId: 'userA' };
const STRANGER = { tenantId: 'tenantB', userId: 'userB' };

function line(description, sku, price, extra = {}) {
  return { description, sku, qty: 1, unitPrice: price, price, enrichment: null, ...extra };
}

async function doneReceipt(scope, { date, items, name = 'Costco' }) {
  const rec = await store.createReceipt({
    buffer: Buffer.from('x'),
    mimeType: 'image/png',
    originalName: 'r.png',
    source: 'test',
    ...scope,
  });
  return store.update(rec.id, { status: 'done', store: { name, date }, items, totals: {} });
}

test('indexing a done receipt files one row per product, and the verifier agrees', async () => {
  const r = await doneReceipt(ME, { date: '2026-01-05', items: [line('EGGS', '1', 5), line('MILK', '2', 3), line('EGGS', '1', 5)] });
  const res = await catalogue.indexReceipt(r);
  assert.equal(res.products, 2);

  const all = await catalogue.products(ME);
  assert.equal(all.length, 2);
  const eggs = all.find((p) => p.line === 'sku:1');
  assert.equal(eggs.qty, 2);
  assert.equal(eggs.spent, 10);

  const v = await catalogue.verify(ME);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.products, 2);
});

test('an unindexed receipt is MISSING to the verifier, and rebuild fills it', async () => {
  await doneReceipt(ME, { date: '2026-02-05', items: [line('EGGS', '1', 5), line('BREAD', '3', 4)] });
  let v = await catalogue.verify(ME);
  assert.equal(v.ok, false);
  assert.equal(v.missing.count, 2);
  assert.equal(v.index.wrong, 1);

  const built = await catalogue.rebuild(ME);
  assert.equal(built.receipts, 2);
  v = await catalogue.verify(ME);
  assert.equal(v.ok, true, JSON.stringify(v));
  const eggs = (await catalogue.products(ME)).find((p) => p.line === 'sku:1');
  assert.equal(eggs.times, 2);
  assert.equal(eggs.buys[0].day, '2026-02-05', 'newest first');
});

test('a tampered row is STALE, an orphan row is EXTRA, and rebuild removes both', async () => {
  const [row] = await persistence.list({ kind: 'purchases', tenant: ME.tenantId, user: ME.userId });
  const { cacheId } = require('../src/identity').resolveId(row.receiptId);
  await persistence.put({ kind: 'purchases', tenant: ME.tenantId, user: ME.userId, id: row.productId, sub: cacheId }, { ...row, spent: 999 });
  await persistence.put(
    { kind: 'purchases', tenant: ME.tenantId, user: ME.userId, id: 'p000000000000000000000000', sub: 'gone' },
    { ...row, productId: 'p000000000000000000000000', receiptId: `${ME.tenantId}:${ME.userId}:gone` }
  );
  let v = await catalogue.verify(ME);
  assert.equal(v.stale.count, 1);
  assert.equal(v.extra.count, 1);

  const built = await catalogue.rebuild(ME);
  assert.equal(built.removed, 1);
  v = await catalogue.verify(ME);
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('re-indexing a receipt whose lines changed deletes the rows it no longer implies', async () => {
  const r = await doneReceipt(ME, { date: '2026-03-01', items: [line('JAM', '9', 3), line('TEA', '8', 2)] });
  await catalogue.indexReceipt(r);
  const changed = await store.update(r.id, { items: [line('JAM', '9', 3)] });
  const res = await catalogue.indexReceipt(changed);
  assert.equal(res.removed, 1);
  assert.equal((await catalogue.products(ME)).some((p) => p.line === 'sku:8'), false);
  assert.equal((await catalogue.verify(ME)).ok, true);
});

test('a receipt that is not done has no rows, and loses the ones it had', async () => {
  const r = await doneReceipt(ME, { date: '2026-03-02', items: [line('RICE', '7', 6)] });
  await catalogue.indexReceipt(r);
  assert.ok((await catalogue.products(ME)).some((p) => p.line === 'sku:7'));
  const reread = await store.update(r.id, { status: 'processing' });
  await catalogue.indexReceipt(reread);
  assert.equal((await catalogue.products(ME)).some((p) => p.line === 'sku:7'), false);
  assert.equal((await catalogue.verify(ME)).ok, true);
});

test('a product id is only a product in its own scope: a stranger gets null, and their books are empty', async () => {
  const [prod] = await catalogue.products(ME);
  assert.ok(await catalogue.get(ME, prod.id));
  assert.equal(await catalogue.get(STRANGER, prod.id), null);
  assert.deepEqual(await catalogue.products(STRANGER), []);
  assert.equal(await catalogue.get(ME, '../../etc/passwd'), null, 'a malformed id is not looked up at all');
});

test('naming a product writes every line of it on every receipt, and answers the product', async () => {
  const eggs = (await catalogue.products(ME)).find((p) => p.line === 'sku:1');
  const flagged = await doneReceipt(ME, {
    date: '2026-01-20',
    items: [line('EGGS', '1', 5, { enrichment: { title: 'Egg?', needsReview: true, reviewNote: 'Which eggs?', confidence: 0.4 } })],
  });
  await catalogue.indexReceipt(flagged);

  const after = await catalogue.nameProduct(ME, eggs.id, { title: 'Large Eggs', brand: 'Farm', category: 'Dairy' });
  assert.equal(after.times, 3);
  assert.equal(after.item.enrichment.title, 'Large Eggs');
  assert.equal(after.item.enrichment.named, 'member');

  for (const b of after.buys) {
    const rec = await store.get(b.record.id);
    const lines = rec.items.filter((it) => it.sku === '1');
    assert.ok(lines.length);
    for (const it of lines) {
      assert.equal(it.enrichment.title, 'Large Eggs');
      assert.equal(it.enrichment.named, 'member');
      assert.equal(it.enrichment.confidence, null, 'a member’s answer carries no confidence');
      assert.equal(it.enrichment.needsReview, undefined, 'the review flag comes off');
      assert.equal(it.enrichment.reviewNote, undefined);
    }
    // Another product on the same receipt is untouched.
    for (const it of rec.items.filter((x) => x.sku !== '1')) assert.notEqual(it.enrichment && it.enrichment.named, 'member');
  }
  assert.equal((await catalogue.verify(ME)).ok, true);
});

test('a naming patch is checked: wrong types are refused, not coerced', async () => {
  const [prod] = await catalogue.products(ME);
  await assert.rejects(() => catalogue.nameProduct(ME, prod.id, { title: 5 }), { status: 400 });
  await assert.rejects(() => catalogue.nameProduct(ME, prod.id, {}), { status: 400 });
  await assert.rejects(() => catalogue.nameProduct(ME, prod.id, null), { status: 400 });
  await assert.rejects(() => catalogue.nameProduct(STRANGER, prod.id, { title: 'mine now' }), { status: 404 });
});

test('a failed write mid-name puts back what it had written, and says nothing changed', async () => {
  const eggs = (await catalogue.products(ME)).find((p) => p.line === 'sku:1');
  const before = await Promise.all(eggs.buys.map((b) => store.get(b.record.id)));
  const realPut = persistence.put;
  let receiptWrites = 0;
  persistence.put = async (key, value) => {
    if (key.kind === 'receipts' && ++receiptWrites === 2) throw new Error('disk full');
    return realPut(key, value);
  };
  try {
    await assert.rejects(() => catalogue.nameProduct(ME, eggs.id, { title: 'Nope' }), { status: 502 });
  } finally {
    persistence.put = realPut;
  }
  for (const orig of before) {
    const now = await store.get(orig.id);
    assert.deepEqual(
      now.items.map((i) => i.enrichment && i.enrichment.title),
      orig.items.map((i) => i.enrichment && i.enrichment.title)
    );
  }
});

test('a name the member gave is applied to the next receipt the product turns up on', async () => {
  const next = await doneReceipt(ME, { date: '2026-06-01', items: [line('EGGS', '1', 5), line('NEW THING', '55', 1)] });
  const n = await catalogue.applyRememberedNames(next);
  assert.equal(n, 1);
  assert.equal(next.items[0].enrichment.title, 'Large Eggs');
  assert.equal(next.items[0].enrichment.named, 'member');
  assert.equal(next.items[1].enrichment, null, 'a product nobody named is left alone');

  // A line the member already named on this receipt keeps its own answer.
  const own = await doneReceipt(ME, { date: '2026-06-02', items: [line('EGGS', '1', 5, { enrichment: { title: 'Duck eggs', named: 'member' } })] });
  assert.equal(await catalogue.applyRememberedNames(own), 0);
  assert.equal(own.items[0].enrichment.title, 'Duck eggs');

  // Another member's books are not named by my answer.
  const theirs = await doneReceipt(STRANGER, { date: '2026-06-01', items: [line('EGGS', '1', 5)] });
  assert.equal(await catalogue.applyRememberedNames(theirs), 0);
});

test('scopes() finds every member that holds receipts', async () => {
  const found = await catalogue.scopes();
  const keys = found.map((s) => `${s.tenantId}/${s.userId}`).sort();
  assert.deepEqual(keys, ['tenantA/userA', 'tenantB/userB']);
});

test('the page envelope reads the persisted rows with filters and the order applied', async () => {
  await catalogue.rebuild(ME);
  const env = await catalogue.page(ME, { filters: require('../src/catalogue/query').parse({ named: 'member' }), sort: 'name_az', limit: 10, offset: 0 });
  assert.equal(env.matched, 1);
  // The card is drawn from the NEWEST purchase, and the newest receipt with
  // these eggs is the one the member named "Duck eggs" on its own line.
  assert.equal(env.records[0].item.enrichment.title, 'Duck eggs');
  assert.ok(env.records[0].buys.some((b) => b.item.enrichment && b.item.enrichment.title === 'Large Eggs'));
  assert.ok(env.total > env.matched);
});

test('the filesystem backend lists purchase rows the same way', async () => {
  persistence._reset();
  const config = require('../src/config');
  const prev = config.persistence.backend;
  config.persistence.backend = 'filesystem';
  try {
    const scope = { tenantId: 'fsT', userId: 'fsU' };
    const r = await doneReceipt(scope, { date: '2026-01-01', items: [line('A', '1', 1), line('B', '2', 2)] });
    await catalogue.indexReceipt(r);
    const r2 = await doneReceipt(scope, { date: '2026-01-02', items: [line('A', '1', 1)] });
    await catalogue.indexReceipt(r2);
    const all = await catalogue.products(scope);
    assert.equal(all.length, 2);
    assert.equal(all.find((p) => p.line === 'sku:1').times, 2);
    assert.equal((await catalogue.get(scope, all[0].id)).id, all[0].id);
    assert.equal((await catalogue.verify(scope)).ok, true);
    assert.ok((await catalogue.scopes()).some((s) => s.tenantId === 'fsT'));
  } finally {
    config.persistence.backend = prev;
    persistence._reset();
  }
});
