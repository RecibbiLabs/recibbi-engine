'use strict';

// The two settings records, and the properties that are not obvious from
// reading them: that absence takes a DIFFERENT default per switch, that a save
// can empty an address, that a form can never set the avatar, and that two
// switches flipped at once do not lose one of the two.
//
// Hermetic: temp DATA_DIR, fake Redis, no network.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('settings-stores-test');
installFakeRedis();

const config = require('../src/config');
const memberProfile = require('../src/settings/memberProfile');
const retailerPrefs = require('../src/settings/retailerPrefs');
const { withLock } = require('../src/settings/lock');
const { SettingsError } = require('../src/settings/validate');

const alice = { tenantId: 'acme', userId: 'alice' };
const bob = { tenantId: 'acme', userId: 'bob' };

after(() => tmp.cleanup());

// --- the profile ------------------------------------------------------------

test('an unset profile reads as empty, not as missing', async () => {
  const p = await memberProfile.get({ tenantId: 'acme', userId: 'nobody' });
  assert.equal(p.firstName, null);
  assert.equal(p.avatarUrl, null);
  // The address SHAPE is always there even when nothing in it is, so no caller
  // has to distinguish "no address object" from "an empty address".
  assert.deepEqual(p.address, {
    line1: null, line2: null, city: null, state: null, postalCode: null, country: null,
  });
});

test('a postal code on its own is a complete address', async () => {
  // The rule most likely to be quietly hardened later by somebody adding a
  // `required` to the first line because a half address is useless. It is not.
  const saved = await memberProfile.save(bob, { postalCode: '78704' });
  assert.equal(saved.address.postalCode, '78704');
  assert.equal(saved.address.line1, null);
  assert.equal(saved.address.country, null);
  assert.equal(memberProfile.hasAddress(saved), true);
});

test('a save is a replacement, so an address can be emptied', async () => {
  await memberProfile.save(alice, {
    firstName: 'Ada', lastName: 'Member',
    line1: '2117 Cedar Ridge Ln', city: 'Austin', state: 'TX', postalCode: '78704', country: 'US',
  });
  assert.equal(memberProfile.hasAddress(await memberProfile.get(alice)), true);

  // A member who moved and has not decided where to. Under merge semantics this
  // would be impossible to express at all.
  const cleared = await memberProfile.save(alice, { firstName: 'Ada', lastName: 'Member' });
  assert.equal(memberProfile.hasAddress(cleared), false);
  assert.equal(cleared.address.city, null);
  assert.equal(cleared.firstName, 'Ada');
});

test('an empty body is refused, but eight empty boxes still clear the record', async () => {
  const scope = { tenantId: 'acme', userId: 'clearer' };
  await memberProfile.save(scope, { firstName: 'Ada', city: 'Austin', postalCode: '78704' });

  // `{}` is a client that forgot its Content-Type, not a member. Under
  // replacement semantics it would wipe the record and answer 200.
  await assert.rejects(() => memberProfile.save(scope, {}), /clears nothing/);
  assert.equal((await memberProfile.get(scope)).firstName, 'Ada', 'nothing was wiped');

  // A member who empties every box posts every field, and that DOES clear it.
  const cleared = await memberProfile.save(scope, {
    firstName: '', lastName: '', line1: '', line2: '', city: '', state: '', postalCode: '', country: '',
  });
  assert.equal(cleared.firstName, null);
  assert.equal(memberProfile.hasAddress(cleared), false);
});

test('blank and whitespace store as null, so absent has ONE representation', async () => {
  const saved = await memberProfile.save(bob, { firstName: '  Sam  ', lastName: '   ', city: '' });
  assert.equal(saved.firstName, 'Sam'); // trimmed
  assert.equal(saved.lastName, null); // not ''
  assert.equal(saved.address.city, null);
});

test('a form can never set the avatar, however it asks', async () => {
  // A form that could set this would be a form that points a member's own
  // avatar at any URL on the internet.
  await memberProfile.setAvatarUrl(alice, '/api/settings/profile/photo/abcd1234abcd1234.png');
  const saved = await memberProfile.save(alice, {
    firstName: 'Ada',
    avatarUrl: 'https://evil.example/tracker.gif',
  });
  assert.equal(saved.avatarUrl, '/api/settings/profile/photo/abcd1234abcd1234.png');
});

test('a length is refused by the engine, not only by the page', async () => {
  await assert.rejects(
    () => memberProfile.save(alice, { firstName: 'x'.repeat(61) }),
    (err) => err instanceof SettingsError && err.status === 400 && /firstName/.test(err.message)
  );
  // ...and the limit is in the message, so nobody trims one character at a time.
  await assert.rejects(
    () => memberProfile.save(alice, { postalCode: '1'.repeat(20) }),
    /16 characters \(got 20\)/
  );
});

test('a name is only bounded by length — it is never pattern-matched', async () => {
  // Every regex anybody has written for this rejects somebody's actual name.
  for (const name of ["O'Brien-Smith", '之瑜', 'Ada', 'Æthelflæd', 'María José', 'X']) {
    const saved = await memberProfile.save(bob, { firstName: name });
    assert.equal(saved.firstName, name);
  }
});

test('one member cannot read another\'s profile: the key IS the owner', async () => {
  await memberProfile.save(alice, { firstName: 'Ada' });
  await memberProfile.save(bob, { firstName: 'Bo' });
  assert.equal((await memberProfile.get(alice)).firstName, 'Ada');
  assert.equal((await memberProfile.get(bob)).firstName, 'Bo');
  // A different tenant with the same user segment is a different member.
  assert.equal((await memberProfile.get({ tenantId: 'other', userId: 'alice' })).firstName, null);
});

test('the session projection carries a name and a photo, and nothing else', async () => {
  await memberProfile.save(alice, { firstName: 'Ada', lastName: 'Member', city: 'Austin' });
  const p = memberProfile.sessionProjection(await memberProfile.get(alice));
  assert.deepEqual(Object.keys(p).sort(), ['avatarUrl', 'displayName']);
  assert.equal(p.displayName, 'Ada Member');
  // Null, not a fallback invented here: the precedence (typed, then the
  // provider's, then the email) lives in ONE place and this is not it.
  assert.equal(memberProfile.sessionProjection(null).displayName, null);
});

test('the profile does not collide with the OCR receipt-profile store', () => {
  // The two things called a profile. A require() of the wrong one would
  // typecheck, run, and store an address in the transformation rules.
  const receiptProfiles = require('../src/receiptProfiles/profileStore');
  assert.notEqual(memberProfile.keyFor(alice).kind, 'receiptProfiles');
  assert.equal(memberProfile.keyFor(alice).kind, 'settings');
  assert.equal(typeof receiptProfiles.count, 'function'); // a different module entirely
  assert.equal(receiptProfiles.list === memberProfile.get, false);
});

// --- retailer preferences ---------------------------------------------------

test('ABSENT IS NOT OFF, and the default differs per switch', async () => {
  const none = await retailerPrefs.all({ tenantId: 'acme', userId: 'fresh' });
  assert.deepEqual(none, {});

  // A member who has never opened Settings is looking at retailer photographs
  // right now, so the switch that governs them must not read "off".
  assert.equal(retailerPrefs.valueOf(none, 'samsclub.com', 'productIcons'), true);
  assert.equal(retailerPrefs.valueOf(none, 'samsclub.com', 'enrichFromRetailer'), false);

  // Every shape of absence takes the same branch.
  assert.equal(retailerPrefs.valueOf({}, 'samsclub', 'productIcons'), true);
  assert.equal(retailerPrefs.valueOf({ samsclub: {} }, 'samsclub', 'productIcons'), true);
  assert.equal(retailerPrefs.valueOf({ samsclub: { productIcons: null } }, 'samsclub', 'productIcons'), true);
  assert.equal(retailerPrefs.valueOf({ samsclub: { productIcons: false } }, 'samsclub', 'productIcons'), false);
});

test('the enrichment default follows RETAILER_ENRICH_DEFAULT, not a second constant', async () => {
  // An operator who turns enrichment on must not find every switch still
  // reading "off" — that is one question with two hardcoded answers.
  const original = config.retailers.enrichByDefault;
  try {
    config.retailers.enrichByDefault = true;
    assert.equal(retailerPrefs.valueOf({}, 'samsclub', 'enrichFromRetailer'), true);
    assert.equal(retailerPrefs.defaults().enrichFromRetailer, true);
  } finally {
    config.retailers.enrichByDefault = original;
  }
  assert.equal(retailerPrefs.defaults().enrichFromRetailer, false);
});

test('every spelling of a retailer reaches ONE row of settings', async () => {
  // The adapter's aliases collapse, then the TLD comes off: the record's
  // `retailer` field is a domain, the design atlas keys by the bare slug.
  for (const spelling of ['samsclub.com', 'samsclub', 'sams-club', "Sam's Club", 'SAMSCLUB.COM']) {
    assert.equal(retailerPrefs.prefKey(spelling), 'samsclub', `"${spelling}"`);
  }
  await retailerPrefs.set(alice, "Sam's Club", { productIcons: false });
  const prefs = await retailerPrefs.all(alice);
  assert.deepEqual(Object.keys(prefs), ['samsclub']);
  assert.equal(retailerPrefs.valueOf(prefs, 'samsclub.com', 'productIcons'), false);
});

test('a retailer with no adapter still gets a preference', async () => {
  // Settings draws a card for every retailer in the catalogue, not only the
  // integrated ones. Refusing to store Costco would make the screen lie.
  const row = await retailerPrefs.set(alice, 'costco', { enrichFromRetailer: true });
  assert.equal(row.enrichFromRetailer, true);
  assert.equal(retailerPrefs.valueOf(await retailerPrefs.all(alice), 'costco', 'enrichFromRetailer'), true);
});

test('an unknown switch is refused, not ignored', async () => {
  // A 200 over a write that stored nothing leaves the control agreeing on
  // screen and disagreeing with the books.
  await assert.rejects(() => retailerPrefs.set(alice, 'samsclub', { darkMode: true }), /unknown retailer setting/);
  await assert.rejects(() => retailerPrefs.set(alice, 'samsclub', { productIcons: 'yes' }), /must be true or false/);
  await assert.rejects(() => retailerPrefs.set(alice, 'samsclub', {}), /no settings given/);
});

test('two switches flipped at once do not lose one of the two', async () => {
  // The two sit one above the other in the same card, so this is ordinary use.
  // Without the lock the first flip silently reverts — a control that undoes
  // itself with nothing to say, because nothing refused it.
  const scope = { tenantId: 'acme', userId: 'racer' };
  await Promise.all([
    retailerPrefs.set(scope, 'samsclub', { productIcons: false }),
    retailerPrefs.set(scope, 'samsclub', { enrichFromRetailer: true }),
  ]);
  const prefs = await retailerPrefs.all(scope);
  assert.equal(retailerPrefs.valueOf(prefs, 'samsclub', 'productIcons'), false);
  assert.equal(retailerPrefs.valueOf(prefs, 'samsclub', 'enrichFromRetailer'), true);
});

test('a photo upload landing mid-save loses neither the names nor the picture', async () => {
  const scope = { tenantId: 'acme', userId: 'racer2' };
  await Promise.all([
    memberProfile.save(scope, { firstName: 'Ada', lastName: 'Member' }),
    memberProfile.setAvatarUrl(scope, '/api/settings/profile/photo/deadbeefdeadbeef.jpg'),
  ]);
  const p = await memberProfile.get(scope);
  assert.equal(p.firstName, 'Ada');
  assert.equal(p.avatarUrl, '/api/settings/profile/photo/deadbeefdeadbeef.jpg');
});

test('the lock serializes per key, so one member never waits on another', async () => {
  const order = [];
  const slow = () => new Promise((r) => setTimeout(r, 20)).then(() => order.push('slow'));
  const fast = async () => { order.push('fast'); };
  await Promise.all([withLock('a', slow), withLock('b', fast)]);
  assert.deepEqual(order, ['fast', 'slow']);
});

test('a rejection inside the lock does not cancel what is queued behind it', async () => {
  const seen = [];
  const results = await Promise.allSettled([
    withLock('k', async () => { throw new Error('refused'); }),
    withLock('k', async () => { seen.push('ran'); return 'ok'; }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(seen, ['ran']);
});
