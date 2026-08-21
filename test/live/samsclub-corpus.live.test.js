'use strict';

// The Sam's Club adapter against a FULL receipt-sync corpus — every payload, not
// the ten committed fixtures. This is the test that keeps
// docs/samsclub-receipt-schema.md honest: it re-derives the document's headline
// counts from the payloads themselves and fails if a claim stops holding.
//
//   node --test test/live/samsclub-corpus.live.test.js
//   SAMSCLUB_CORPUS=/path/to/corpus node --test test/live/samsclub-corpus.live.test.js
//
// It lives under test/live/ because the corpus is gitignored and does not travel
// with this repo. It self-skips when the directory is absent, so it never breaks
// the hermetic suite. Unlike the other live tests it hits no network and needs
// no keys — the "live" part is the data.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const adapter = require('../../src/retailers/adapters/samsclub.com.js');

const CORPUS =
  process.env.SAMSCLUB_CORPUS ||
  path.resolve(__dirname, '../../../codex-receipt-retailer-ground-truth/samsclub.com');

// The counts docs/samsclub-receipt-schema.md reports for the 248-payload Sam's
// Club history. A different corpus will differ — the assertions below only apply
// when the totals line up, and are reported rather than enforced otherwise.
const DOCUMENTED = {
  receipts: 248,
  lineItems: 1438, // 1,435 in `detail` + 3 add-on lines
  itemsCheckPasses: 247,
  totalCheckPasses: 246,
  reconciled: 245,
};

function loadCorpus() {
  if (!fs.existsSync(CORPUS)) return null;
  const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.json'));
  return files.length ? files : null;
}

test("the whole corpus normalizes, and reproduces the schema doc's counts", (t) => {
  const files = loadCorpus();
  if (!files) {
    t.skip(`no corpus at ${CORPUS} (set SAMSCLUB_CORPUS to point at one)`);
    return;
  }

  const stats = { receipts: 0, lineItems: 0, detected: 0, itemsCheckPasses: 0, totalCheckPasses: 0, reconciled: 0, incomplete: 0 };
  const failures = { items: [], total: [] };

  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8'));
    stats.receipts += 1;
    if (adapter.detect(payload)) stats.detected += 1;

    const out = adapter.normalize(payload);
    stats.lineItems += out.items.length;
    if (out.source.incomplete) stats.incomplete += 1;

    // Invariants that must hold on EVERY payload, whatever corpus this is.
    assert.equal(out.store.name, "Sam's Club", `${file}: canonical chain name`);
    assert.equal(out.totals.itemCount, out.items.length, `${file}: itemCount is counted, not copied`);
    for (const item of out.items) {
      assert.equal(typeof item.description, 'string', `${file}: every line has a description`);
      assert.ok(item.price === null || Number.isFinite(item.price), `${file}: prices are numbers or null`);
      if (item.measuredQty !== null) {
        assert.ok(item.unit, `${file}: a measured quantity always names its unit`);
      }
    }

    if (out.totals.subtotalMatch) stats.itemsCheckPasses += 1;
    else if (out.totals.subtotalMatch === false) failures.items.push(`${file} (${out.totals.sumOfItems} vs ${out.totals.subtotal})`);
    if (out.totals.totalMatch) stats.totalCheckPasses += 1;
    else if (out.totals.totalMatch === false) failures.total.push(`${file} (${out.totals.expectedTotal} vs ${out.totals.total})`);
    if (out.totals.reconciled) stats.reconciled += 1;
  }

  console.log('\n  Sam\'s Club corpus:', CORPUS);
  console.log(`  receipts ............ ${stats.receipts}`);
  console.log(`  line items .......... ${stats.lineItems}`);
  console.log(`  detected as ours .... ${stats.detected}/${stats.receipts}`);
  console.log(`  items check passes .. ${stats.itemsCheckPasses}/${stats.receipts}`);
  console.log(`  total check passes .. ${stats.totalCheckPasses}/${stats.receipts}`);
  console.log(`  reconciled (both) ... ${stats.reconciled}/${stats.receipts}`);
  console.log(`  incomplete payloads . ${stats.incomplete}`);
  if (failures.items.length) console.log('  items check failed:', failures.items.join(', '));
  if (failures.total.length) console.log('  total check failed:', failures.total.join(', '));

  assert.equal(stats.detected, stats.receipts, 'every payload in the corpus is recognized as ours');

  if (stats.receipts !== DOCUMENTED.receipts) {
    console.log(`\n  (a ${stats.receipts}-receipt corpus, not the ${DOCUMENTED.receipts} the schema doc describes — counts reported, not asserted)`);
    return;
  }

  // Same corpus the doc was written from: hold it to the doc's numbers.
  assert.equal(stats.lineItems, DOCUMENTED.lineItems, 'line item count matches §2');
  assert.equal(stats.itemsCheckPasses, DOCUMENTED.itemsCheckPasses, 'items check matches §7');
  assert.equal(stats.totalCheckPasses, DOCUMENTED.totalCheckPasses, 'total check matches §7');
  assert.equal(stats.reconciled, DOCUMENTED.reconciled, 'reconciled count matches §7');
  assert.equal(stats.incomplete, 0, 'this is a repaired history: both halves present everywhere (§1)');
});
