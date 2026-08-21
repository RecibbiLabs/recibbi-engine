'use strict';

// Retailer adapter registry: which adapters exist, and how a URL id resolves to
// one. Pure module tests — no Redis, no HTTP, no filesystem beyond src/.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/retailers/registry');

test('the shipped Sam\'s Club adapter is registered', () => {
  const listed = registry.list();
  const sams = listed.find((r) => r.id === 'samsclub.com');
  assert.ok(sams, 'samsclub.com is in the listing');
  assert.equal(sams.name, "Sam's Club");
  assert.equal(sams.storeName, "Sam's Club");
  assert.ok(sams.schema.includes('samsclub-receipt-schema'), 'points at its schema doc');
});

test('list() returns one entry per adapter, not one per alias', () => {
  const ids = registry.list().map((r) => r.id);
  assert.deepEqual(ids, [...new Set(ids)], 'no duplicate ids');
  const sams = registry.list().filter((r) => r.id === 'samsclub.com');
  assert.equal(sams.length, 1, 'five aliases still yield one listing entry');
});

test('a retailer id resolves case- and punctuation-insensitively', () => {
  for (const id of ['samsclub.com', 'SamsClub.COM', 'samsclub', 'sams-club', "Sam's Club", 'www.samsclub.com']) {
    const adapter = registry.get(id);
    assert.ok(adapter, `${id} resolves`);
    assert.equal(adapter.id, 'samsclub.com', `${id} -> samsclub.com`);
  }
});

test('an unregistered retailer resolves to null, not a throw', () => {
  assert.equal(registry.get('costco.com'), null);
  assert.equal(registry.get(''), null);
  assert.equal(registry.get(undefined), null);
  assert.equal(registry.has('costco.com'), false);
  assert.equal(registry.has('samsclub'), true);
});

test('a resolved adapter exposes the full contract', () => {
  const adapter = registry.get('samsclub.com');
  assert.equal(typeof adapter.detect, 'function');
  assert.equal(typeof adapter.normalize, 'function');
  assert.ok(Array.isArray(adapter.aliases));
});

test('the contract-only types module is not registered as an adapter', () => {
  assert.equal(registry.get('types'), null);
});

test('reload() re-scans and stays stable', () => {
  const before = registry.list().map((r) => r.id).sort();
  registry.reload();
  assert.deepEqual(registry.list().map((r) => r.id).sort(), before);
});
