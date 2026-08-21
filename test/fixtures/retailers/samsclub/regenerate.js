'use strict';

// Regenerate the Sam's Club adapter fixtures from a real receipt-sync corpus.
//
//   node test/fixtures/retailers/samsclub/regenerate.js [rawDir]
//
// Default rawDir: ../codex-receipt-retailer-ground-truth/samsclub.com
//
// The corpus is gitignored and does not travel with this repo, so the hermetic
// suite runs against the SCRUBBED payloads this script writes next to it. Each
// fixture is a real payload with its personal data replaced — see README.md.
// Money, quantities, ids, dates and structure are left byte-for-byte intact,
// because those are exactly what the adapter is tested on.

const fs = require('fs');
const path = require('path');

const RAW = process.argv[2] || path.join(__dirname, '../../../../../codex-receipt-retailer-ground-truth/samsclub.com');
const OUT = __dirname;

// One payload per structurally distinct case in docs/samsclub-receipt-schema.md.
// The point of each is what the adapter has to get right, not the shopping.
const CASES = [
  ['00769925960064747015.json', 'scan-and-go.json', 'SCAN_AND_GO: 4 lines, one sold by the pound (trap 3)'],
  ['008220651018835151852.json', 'savings.json', 'IN_STORE with a priceDetails.savings row (positive, subtracted)'],
  ['05320328058895178882.json', 'fuel.json', 'FUEL: one line, gallons in quantityString, 3-decimal unit price'],
  ['10106821731.json', 'tire-addons.json', 'ACC_TIRE: addOns[] line, Product fee, no paymentMethods'],
  ['10143302015.json', 'delivery-glass.json', 'DELIVERY on GLASS: no club, Shipping fee, catalogue usItemIds'],
  ['18269993991048725005.json', 'electronic-voided.json', 'ELECTRONIC: voided zero-quantity membership rows'],
  ['9885842023.json', 'two-groups.json', 'the one payload whose order splits across two fulfillment groups'],
  ['647034762218919246966.json', 'returned.json', 'a RETURNED category, line still at its original positive price'],
  ['976767076793172856129.json', 'items-check-fails.json', 'line sum $147.21 over a $141.97 subtotal — a voided line still on the tape'],
  ['019102914021720042734.json', 'total-check-fails.json', 'a $2.00 counter fee in no fees[] row — total check fails, items check passes'],
];

// Keys whose value is personal WHEREVER they appear.
const REDACT_ANYWHERE = {
  firstName: 'Ada',
  lastName: 'Member',
  fullName: 'Ada Member',
  email: 'member@example.invalid',
  txPhoneNumber: null,
  phoneNumber: '',
};

// Address keys, redacted ONLY inside a personal subtree. A club's address is a
// public business address and stays real — the adapter reads it onto
// `store.branch`, and a fixture that asserts a made-up club proves less.
const REDACT_IN_PERSONAL = {
  addressLineOne: '1 Example Way',
  addressLineTwo: '',
  addressString: '1 Example Way, Springfield, FL 32100',
  city: 'Springfield',
  state: 'FL',
  postalCode: '32100',
  extendedPostalCode: '0000',
  latitude: 29.0,
  longitude: -81.0,
};

// Subtrees that are about the MEMBER rather than the order.
const PERSONAL_SUBTREES = new Set(['customer', 'deliveryAddress', 'vehicleInfo', 'billingAddress']);

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/g;

// Every key whose original value must not survive anywhere in the output. Used
// to verify the scrub generically, instead of trusting the key list above to be
// complete — that list has already been wrong once (deliveryAddress.fullName).
const PERSONAL_KEYS = new Set([
  ...Object.keys(REDACT_ANYWHERE),
  ...Object.keys(REDACT_IN_PERSONAL),
  'name', // only collected inside a personal subtree
  'nickName',
  'vin',
]);

function scrub(value, key, personal) {
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, personal));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const inPersonal = personal || PERSONAL_SUBTREES.has(k);

      // The 17-digit membership-scoped customer id.
      if (k === 'id' && key === 'customer') {
        out[k] = '00000000000000000';
        continue;
      }
      // The vehicle on a tire order identifies its owner as surely as a name.
      if (inPersonal && (k === 'name' || k === 'nickName' || k === 'vin')) {
        out[k] = v === null ? null : k === 'name' ? 'Example Vehicle 2020' : null;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(REDACT_ANYWHERE, k)) {
        out[k] = v === null ? null : REDACT_ANYWHERE[k];
        continue;
      }
      if (inPersonal && Object.prototype.hasOwnProperty.call(REDACT_IN_PERSONAL, k)) {
        out[k] = v === null ? null : REDACT_IN_PERSONAL[k];
        continue;
      }
      // Card last-4: real on the paper receipt, but no reason to commit a real
      // one. Keep the SHAPE ("*4149", "*3536 (Food)", "Sam's Cash").
      if (k === 'description' && typeof v === 'string' && /^\*\d{4}/.test(v)) {
        out[k] = v.replace(/^\*\d{4}/, '*0000');
        continue;
      }
      out[k] = scrub(v, k, inPersonal);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Catch anything the key lists missed — "Emailed to <address>", HTML with a
    // tel: link in tireInfo.instructions, a name inside a rich-text part.
    return value.replace(EMAIL_RE, 'member@example.invalid').replace(PHONE_RE, '555-555-0100');
  }
  return value;
}

/**
 * Collect every personal value present in the ORIGINAL payload, so the check
 * below can assert none of them survived. Generic by construction: it does not
 * depend on scrub() having handled the right keys.
 */
function personalValues(value, key, personal, out = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((v) => personalValues(v, key, personal, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const inPersonal = personal || PERSONAL_SUBTREES.has(k);
      if ((PERSONAL_KEYS.has(k) && (inPersonal || k in REDACT_ANYWHERE)) || (k === 'id' && key === 'customer')) {
        if (typeof v === 'string' && v.trim().length >= 4) out.add(v.trim());
      }
      personalValues(v, k, inPersonal, out);
    }
    return out;
  }
  if (typeof value === 'string') {
    for (const hit of value.match(EMAIL_RE) || []) out.add(hit);
    for (const hit of value.match(PHONE_RE) || []) out.add(hit);
  }
  return out;
}

const ALLOWED = new Set([
  'Ada', 'Member', 'Ada Member', 'member@example.invalid', '555-555-0100',
  '1 Example Way', '1 Example Way, Springfield, FL 32100', 'Springfield',
  '32100', '0000', 'Example Vehicle 2020', '00000000000000000',
]);

function main() {
  if (!fs.existsSync(RAW)) {
    console.error(`corpus not found: ${RAW}\nPass the raw dir as the first argument.`);
    process.exit(1);
  }
  const index = [];
  for (const [src, dest, note] of CASES) {
    const from = path.join(RAW, src);
    if (!fs.existsSync(from)) {
      console.error(`  MISSING ${src} — skipped`);
      continue;
    }
    const payload = JSON.parse(fs.readFileSync(from, 'utf8'));
    const scrubbed = scrub(payload, null, null);
    fs.writeFileSync(path.join(OUT, dest), JSON.stringify(scrubbed, null, 1) + '\n');
    index.push({ file: dest, from: src, note });
    console.log(`  ${dest}  <- ${src}`);
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  // Fail loudly if any personal value from the source survived the scrub.
  let leaked = 0;
  for (const { file, from } of index) {
    const original = JSON.parse(fs.readFileSync(path.join(RAW, from), 'utf8'));
    const scrubbedText = fs.readFileSync(path.join(OUT, file), 'utf8');
    for (const secret of personalValues(original, null, false)) {
      if (ALLOWED.has(secret)) continue;
      if (scrubbedText.includes(secret)) {
        console.error(`  LEAK in ${file}: ${JSON.stringify(secret)}`);
        leaked += 1;
      }
    }
  }
  console.log(
    leaked
      ? `\n${leaked} leak(s) survived — fix scrub() before committing.`
      : `\n${index.length} fixtures written, no personal values survived.`
  );
  process.exit(leaked ? 1 : 0);
}

main();
