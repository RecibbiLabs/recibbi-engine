'use strict';

// A category for every line that has none (src/catalogue/categorize.js): the
// books first, the model second, one question per product, and never over
// anything a member or a resolver already said. Then the one-off over history
// and the pipeline step, each checked by the verifier.
//
// Hermetic: temp DATA_DIR and SQLite, fake Redis, and the model is either an
// injected classifier or a stubbed fetch -- nothing leaves the process.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useTempDataDir, useTempSqlite, installFakeRedis, stubFetch, jsonResponse, textResponse } = require('./helpers/harness');

const tmp = useTempDataDir('catalogue-categorize-test');
const db = useTempSqlite('catalogue-categorize-sqlite');
installFakeRedis();
process.env.ENRICH_PROVIDER = 'tavily';

const config = require('../src/config');
const persistence = require('../src/persistence');
const store = require('../src/store');
const identity = require('../src/identity');
const catalogue = require('../src/catalogue');
const categorize = require('../src/catalogue/categorize');
const { processReceipt } = require('../src/pipeline');

after(() => {
  persistence._reset();
  db.cleanup();
  tmp.cleanup();
});

const ME = { tenantId: 'tenantC', userId: 'userC' };

function line(description, sku, price, extra = {}) {
  return { description, sku, qty: 1, unitPrice: price, price, enrichment: null, ...extra };
}

async function doneReceipt(scope, { date, items, name = "Sam's Club", retailer = null }) {
  const rec = await store.createReceipt({
    buffer: Buffer.from('x'),
    mimeType: 'image/png',
    originalName: 'r.png',
    source: 'test',
    ...scope,
  });
  return store.update(rec.id, { status: 'done', store: { name, date }, items, totals: {}, retailer });
}

/** A classifier that answers from a table and remembers what it was asked. */
function fakeClassifier(table) {
  const asked = [];
  const classify = async (lines, vocab) => {
    asked.push({ lines: lines.map((l) => l.description), vocab });
    return { answers: lines.map((l) => (l.description in table ? table[l.description] : null)), model: 'fake', failed: 0 };
  };
  classify.asked = asked;
  return classify;
}

/* ------------------------------------------------------------------ pure */

test('the vocabulary is the books first, then the seed, each once whatever its case', () => {
  const v = categorize.vocabulary(['Dairy', 'produce', 'Refrigerated Dips']);
  assert.deepEqual(v.slice(0, 3), ['Dairy', 'produce', 'Refrigerated Dips']);
  assert.ok(!v.includes('Produce'), 'the books spelling wins over the seed');
  assert.ok(v.includes('Meat & Seafood') && v.includes('Auto & Tires'));
  assert.equal(new Set(v.map((c) => c.toLowerCase())).size, v.length);
});

test('an answer is the vocabulary spelling, a new short label, or nothing', () => {
  const vocab = categorize.vocabulary([]);
  assert.equal(categorize.clean('dairy & eggs', vocab), 'Dairy & Eggs');
  assert.equal(categorize.clean('  Fuel ', vocab), 'Fuel');
  assert.equal(categorize.clean('Party Supplies', vocab), 'Party Supplies');
  for (const junk of [null, '', 'null', 'None', 'Unknown', 'Other', 42, 'x'.repeat(41), '{"a":1}', 'two\nlines']) {
    assert.equal(categorize.clean(junk, vocab), null, String(junk));
  }
});

test('one question per product; a line that already has a category, or a member name, is not asked about', async () => {
  const sams = { id: 'tenantC:userC:aaaaaaaaaaaaaaaa', status: 'done', retailer: 'samsclub.com', store: { name: "Sam's Club" } };
  const r1 = {
    ...sams,
    items: [
      line('Kerrygold Butter', 'KG', 12),
      line('Cheerios', 'CH', 7),
      line('Kerrygold Butter', 'KG', 12),
      line('Mystery', 'MY', 1),
      line('Tires', 'TR', 400, { enrichment: { category: 'Auto & Tires' } }),
      line('Named', 'NM', 3, { enrichment: { named: 'member', title: 'Mine', category: null } }),
    ],
  };
  const r2 = { ...sams, id: 'tenantC:userC:bbbbbbbbbbbbbbbb', items: [line('Kerrygold Butter', 'KG', 12), line('Tires', 'TR', 400)] };
  const classify = fakeClassifier({ 'Kerrygold Butter': 'Dairy & Eggs', Cheerios: 'breakfast & cereal' });

  const report = await categorize.categorizeRecords([{ record: r1 }, { record: r2 }], { classify });

  assert.equal(classify.asked.length, 1);
  assert.deepEqual(classify.asked[0].lines.sort(), ['Cheerios', 'Kerrygold Butter', 'Mystery']);
  assert.ok(classify.asked[0].vocab.includes('Auto & Tires'));
  // Butter answered on all three of its lines; the second receipt's tires
  // learned from the first receipt's, without asking.
  assert.equal(r1.items[0].enrichment.category, 'Dairy & Eggs');
  assert.equal(r1.items[2].enrichment.categoryBy, 'model');
  assert.equal(r2.items[0].enrichment.category, 'Dairy & Eggs');
  assert.equal(r1.items[1].enrichment.category, 'Breakfast & Cereal', 'the vocabulary spelling');
  assert.deepEqual(r2.items[1].enrichment, { category: 'Auto & Tires', categoryBy: 'recibbi' });
  // Nothing claimed about what the model could not tell, or what the member cleared.
  assert.equal(r1.items[3].enrichment, null);
  assert.deepEqual(r1.items[5].enrichment, { named: 'member', title: 'Mine', category: null });
  assert.equal(r1.items[4].enrichment.categoryBy, undefined, 'an existing category is left alone');

  assert.equal(report.products, 4);
  assert.equal(report.byModel, 2);
  assert.equal(report.byRecibbi, 1);
  assert.equal(report.unanswered, 1);
  assert.equal(report.lines, 5);
});

test("the vocabulary offers the member's categories and this step's, not a search's free text", async () => {
  const record = {
    id: 'tenantC:userC:eeeeeeeeeeeeeeee',
    status: 'done',
    store: { name: 'Costco' },
    items: [
      line('SEARCHED', 'S1', 1, { enrichment: { title: 'Dip', category: 'Refrigerated Dips' } }),
      line('MINE', 'S2', 1, { enrichment: { named: 'member', title: 'Treat', category: 'Treats' } }),
      line('INVENTED', 'S3', 1, { enrichment: { category: 'Party Supplies', categoryBy: 'model' } }),
      line('NEW', 'S4', 1),
    ],
  };
  const resolved = { bySku: new Map([['s4x', { productTitle: 'x', category: 'Dairy' }]]), byDescription: new Map() };
  const classify = fakeClassifier({ NEW: 'Pantry' });
  await categorize.categorizeRecords([{ record, resolved }], { classify, existing: ['Garden Center'] });
  const vocab = classify.asked[0].vocab;
  assert.ok(vocab.includes('Treats') && vocab.includes('Party Supplies') && vocab.includes('Garden Center'));
  assert.ok(!vocab.includes('Refrigerated Dips'), "a search's category is not offered");
  assert.equal(record.items[0].enrichment.category, 'Refrigerated Dips', 'but it keeps its own line');
});

test("a resolver's category counts as one: that line is not asked about", async () => {
  const record = { id: 'tenantC:userC:cccccccccccccccc', status: 'done', store: { name: 'Costco' }, items: [line('KS FR 2DZ', '1738408', 4.89)] };
  const resolved = { bySku: new Map([['1738408', { productTitle: 'Eggs', category: 'Dairy & Eggs' }]]), byDescription: new Map() };
  const classify = fakeClassifier({});
  const report = await categorize.categorizeRecords([{ record, resolved }], { classify });
  assert.equal(classify.asked.length, 0);
  assert.equal(report.products, 0);
  assert.equal(record.items[0].enrichment, null);
});

/* --------------------------------------------------------------- the model */

test('the model is asked in batches, answers by line number, and a failed batch answers nothing', async () => {
  const saved = { key: config.products.anthropic.apiKey, ds: config.products.deepseek.apiKey, resolver: config.products.resolver };
  config.products.anthropic.apiKey = 'sk-ant-test';
  config.products.deepseek.apiKey = '';
  config.products.resolver = 'anthropic';
  let n = 0;
  const restore = stubFetch((url, options) => {
    n += 1;
    assert.match(url, /\/v1\/messages$/);
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined, 'no web search');
    assert.match(body.system, /- Meat & Seafood/);
    if (n === 2) return textResponse('overloaded', { status: 529 });
    const count = body.messages[0].content.split('\n').length;
    const answer = {};
    for (let i = 1; i <= count; i += 1) answer[String(i)] = i % 2 ? 'produce' : null;
    return jsonResponse({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(answer) + '\n```' }] });
  });
  try {
    const lines = Array.from({ length: categorize.BATCH + 5 }, (_, i) => ({ description: `Line ${i}`, store: 'Sam’s Club' }));
    const out = await categorize.classifyWithModel(lines, categorize.vocabulary([]));
    assert.equal(n, 2);
    assert.equal(out.model, 'anthropic');
    assert.equal(out.failed, 5);
    assert.equal(out.answers[0], 'produce');
    assert.equal(out.answers[1], null);
    assert.deepEqual(out.answers.slice(categorize.BATCH), [null, null, null, null, null]);
  } finally {
    restore();
    config.products.anthropic.apiKey = saved.key;
    config.products.deepseek.apiKey = saved.ds;
    config.products.resolver = saved.resolver;
  }
});

test('with no model key, nothing is asked and nothing is claimed', async () => {
  const saved = { key: config.products.anthropic.apiKey, ds: config.products.deepseek.apiKey };
  config.products.anthropic.apiKey = '';
  config.products.deepseek.apiKey = '';
  const restore = stubFetch((url) => {
    throw new Error(`reached the network at ${url}`);
  });
  try {
    const out = await categorize.classifyWithModel([{ description: 'Eggs' }], []);
    assert.deepEqual(out, { answers: [null], model: null, failed: 0 });
  } finally {
    restore();
    config.products.anthropic.apiKey = saved.key;
    config.products.deepseek.apiKey = saved.ds;
  }
});

/* ------------------------------------------------------ over the books */

test('the one-off over history: categorized, re-indexed, verified, and a second run does nothing', async () => {
  const a = await doneReceipt(ME, { date: '2026-05-01', retailer: 'samsclub.com', items: [line('Raspberries 12 oz.', 'RASP', 4), line('Paper Towels', 'PT', 20)] });
  const b = await doneReceipt(ME, { date: '2026-06-01', retailer: 'samsclub.com', items: [line('Raspberries 12 oz.', 'RASP', 4), line('Gas', 'FUEL', 40)] });
  await catalogue.rebuild(ME);

  const dry = await catalogue.categorizeHistory(ME, { dryRun: true, classify: fakeClassifier({ 'Raspberries 12 oz.': 'Produce' }) });
  assert.equal(dry.written, 0);
  assert.equal(dry.lines, 2);
  assert.equal((await store.get(a.id)).items[0].enrichment, null, 'a dry run writes nothing');

  const classify = fakeClassifier({ 'Raspberries 12 oz.': 'Produce', 'Paper Towels': 'Household', Gas: 'Fuel' });
  const done = await catalogue.categorizeHistory(ME, { classify });
  assert.equal(classify.asked.length, 1);
  assert.equal(done.products, 3);
  assert.equal(done.lines, 4);
  assert.equal(done.written, 2);
  assert.deepEqual(done.categories, { Produce: 1, Household: 1, Fuel: 1 });

  assert.equal((await store.get(b.id)).items[1].enrichment.category, 'Fuel');
  const v = await catalogue.verify(ME);
  assert.equal(v.ok, true, JSON.stringify(v));
  const page = await catalogue.page(ME, {});
  assert.deepEqual(page.facets.options.category, ['Fuel', 'Household', 'Produce']);
  assert.equal(page.facets.counts.category.Produce, 1);

  const again = fakeClassifier({});
  const second = await catalogue.categorizeHistory(ME, { classify: again });
  assert.equal(again.asked.length, 0);
  assert.equal(second.products, 0);
  assert.equal(second.written, 0);
});

test('a new receipt takes the category the books already give its product, without asking', async () => {
  const c = await doneReceipt(ME, { date: '2026-07-01', retailer: 'samsclub.com', items: [line('Raspberries 12 oz.', 'RASP', 4), line('Socks', 'SK', 9)] });
  const record = await store.get(c.id);
  const classify = fakeClassifier({ Socks: 'Clothing' });
  const n = await catalogue.categorizeReceipt(record, { classify });
  assert.equal(n, 2);
  assert.deepEqual(record.items[0].enrichment, { category: 'Produce', categoryBy: 'recibbi' });
  assert.equal(record.items[1].enrichment.category, 'Clothing');
  assert.deepEqual(classify.asked[0].lines, ['Socks']);
});

test('redo asks again about what this step said, and about nothing a member or the resolver said', async () => {
  const d = await doneReceipt(ME, {
    date: '2026-08-01',
    retailer: 'samsclub.com',
    items: [
      line('Wooden Kitchen Playset', 'TOY', 90, { enrichment: { category: 'Baby', categoryBy: 'model' } }),
      line('Mine', 'MINE', 1, { enrichment: { named: 'member', category: 'Treats' } }),
      line('Searched', 'SRCH', 2, { enrichment: { title: 'Searched', category: 'Pantry' } }),
    ],
  });
  const plain = fakeClassifier({ 'Wooden Kitchen Playset': 'Toys & Games' });
  await catalogue.categorizeHistory(ME, { classify: plain });
  const askedFirst = plain.asked.flatMap((a) => a.lines);
  assert.ok(!askedFirst.includes('Wooden Kitchen Playset'), 'without redo, a categorized line is not asked about');
  assert.equal((await store.get(d.id)).items[0].enrichment.category, 'Baby');

  const classify = fakeClassifier({ 'Wooden Kitchen Playset': 'toys & games' });
  const redone = await catalogue.categorizeHistory(ME, { classify, redo: true });
  const asked = classify.asked.flatMap((a) => a.lines);
  assert.ok(asked.includes('Wooden Kitchen Playset'));
  assert.ok(!asked.includes('Mine') && !asked.includes('Searched'));
  assert.ok(classify.asked[0].vocab.includes('Toys & Games'));
  const after = (await store.get(d.id)).items;
  assert.deepEqual(after[0].enrichment, { category: 'Toys & Games', categoryBy: 'model' });
  assert.equal(after[1].enrichment.category, 'Treats');
  assert.equal(after[2].enrichment.category, 'Pantry');
  assert.ok(redone.written >= 1);
  assert.equal((await catalogue.verify(ME)).ok, true);
});

test('switched off, a receipt is not categorized', async () => {
  const saved = config.products.categorize;
  config.products.categorize = false;
  try {
    const record = { id: 'tenantC:userC:dddddddddddddddd', items: [line('Socks', 'SK2', 9)] };
    const classify = fakeClassifier({ Socks: 'Clothing' });
    assert.equal(await catalogue.categorizeReceipt(record, { classify }), 0);
    assert.equal(classify.asked.length, 0);
  } finally {
    config.products.categorize = saved;
  }
});

/* ------------------------------------------------------------ the pipeline */

test('a Sam’s Club receipt through the pipeline arrives categorized, and the verifier agrees', async () => {
  const saved = { key: config.products.anthropic.apiKey, ds: config.products.deepseek.apiKey, resolver: config.products.resolver, enrich: config.enrich.enabled };
  config.products.anthropic.apiKey = 'sk-ant-test';
  config.products.deepseek.apiKey = '';
  config.products.resolver = 'anthropic';
  config.enrich.enabled = false;
  const restore = stubFetch((url, options) => {
    if (!/\/v1\/messages$/.test(url)) throw new Error(`the pipeline reached the network at ${url}`);
    const count = JSON.parse(options.body).messages[0].content.split('\n').length;
    const answer = {};
    for (let i = 1; i <= count; i += 1) answer[String(i)] = 'Fuel';
    return jsonResponse({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
  });
  try {
    const fixture = path.join(__dirname, 'fixtures', 'retailers', 'samsclub', 'fuel.json');
    const payload = fs.readFileSync(fixture);
    const rec = await store.createRetailerReceipt({
      payload,
      retailer: 'samsclub.com',
      originalName: 'fuel.json',
      source: 'sync',
      origin: { retailer: 'samsclub.com', orderId: JSON.parse(payload).summary.orderId },
      options: { enrich: false },
    });
    const done = await processReceipt(rec.id);
    assert.equal(done.status, 'done');
    const named = done.items.filter((i) => i.description);
    assert.ok(named.length > 0);
    for (const item of named) assert.equal(item.enrichment && item.enrichment.category, 'Fuel', item.description);
    assert.equal(restore.calls.length, 1, 'one call for the whole receipt');
    const v = await catalogue.verify(identity.scopeOf(done.id));
    assert.equal(v.ok, true, JSON.stringify(v));
  } finally {
    restore();
    config.products.anthropic.apiKey = saved.key;
    config.products.deepseek.apiKey = saved.ds;
    config.products.resolver = saved.resolver;
    config.enrich.enabled = saved.enrich;
  }
});
