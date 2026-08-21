'use strict';

const fs = require('fs');
const config = require('../config');

// Built-in fallback used only if the aliases JSON is missing or unreadable, so
// store detection keeps working out of the box.
const DEFAULT_ALIASES = {
  Costco: ['costco wholesale', 'costco'],
  Sprouts: ['sprouts'],
  Publix: ['publix'],
  Walmart: ['walmart', 'wal-mart'],
  Target: ['target'],
  Kroger: ['kroger'],
  'Whole Foods': ['whole foods'],
  "Trader Joe's": ['trader joe'],
  Safeway: ['safeway'],
  Aldi: ['aldi'],
  Wegmans: ['wegmans'],
  "Sam's Club": ["sam's club", 'sams club'],
  'H-E-B': ['h-e-b', 'heb'],
  'Winn-Dixie': ['winn-dixie', 'winn dixie'],
};

/**
 * Load the configurable store-alias table (canonical name -> [aliases]) and
 * flatten it into [{ alias, canonical }], longest alias first so the most
 * specific match wins. Falls back to DEFAULT_ALIASES on any read/parse error.
 */
function loadStoreAliases() {
  let map = DEFAULT_ALIASES;
  try {
    const parsed = JSON.parse(fs.readFileSync(config.storeAliasesPath, 'utf8'));
    if (parsed && parsed.aliases && typeof parsed.aliases === 'object') map = parsed.aliases;
  } catch {
    /* keep DEFAULT_ALIASES */
  }
  const flat = [];
  for (const [canonical, aliases] of Object.entries(map)) {
    if (!Array.isArray(aliases)) continue;
    for (const a of aliases) flat.push({ alias: String(a).toLowerCase(), canonical });
  }
  flat.sort((a, b) => b.alias.length - a.alias.length);
  return flat;
}

const STORE_ALIASES = loadStoreAliases();

// Lines that are clearly NOT products.
const NOISE_RE =
  /\b(subtotal|sub total|total|tax|balance|change|cash|debit|credit|visa|mastercard|amex|tend|tender|payment|auth|approval|savings|member|membership|loyalty|points|invoice|receipt|cashier|register|store\s*#|tel|phone|thank you|customer|account|ref#|aid:)\b/i;

const PRICE_RE = /(-?\$?\d{1,4}\.\d{2})\b/g;

function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function detectStore(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const { alias, canonical } of STORE_ALIASES) {
    if (lower.includes(alias)) return canonical;
  }
  return null;
}

/**
 * Canonicalize a store name to a known chain when possible, so the same store
 * groups consistently regardless of how it was extracted. The vision model
 * tends to return the full printed header ("Costco Wholesale"), while the OCR
 * path detects the bare chain — this collapses both to "Costco". Unknown stores
 * are kept verbatim (trimmed).
 */
function canonicalStoreName(name) {
  if (!name) return null;
  return detectStore(name) || String(name).trim() || null;
}

function detectDate(text) {
  if (!text) return null;
  const m =
    text.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/) ||
    text.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
  if (!m) return null;
  return m[0];
}

/** Normalize a structured object (from the vision model) into the canonical shape. */
function normalizeStructured(structured, rawText) {
  const storeName = canonicalStoreName(structured?.store?.name) || detectStore(rawText);
  const storeDate = structured?.store?.date || detectDate(rawText);
  const items = (structured?.items || [])
    .map((it) => ({
      description: String(it.description || '').trim(),
      sku: it.sku ? String(it.sku).trim() : null,
      qty: toNumber(it.qty),
      unitPrice: toNumber(it.unitPrice),
      price: toNumber(it.price),
      enrichment: null,
    }))
    .filter((it) => it.description);
  const totals = {
    subtotal: toNumber(structured?.totals?.subtotal),
    tax: toNumber(structured?.totals?.tax),
    total: toNumber(structured?.totals?.total),
  };
  return finalize({ name: storeName, date: storeDate }, items, totals);
}

/** Best-effort heuristic parse of raw OCR text. */
function parseText(rawText) {
  const store = { name: detectStore(rawText), date: detectDate(rawText) };
  const items = [];
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (NOISE_RE.test(line)) continue;
    const prices = line.match(PRICE_RE);
    if (!prices) continue;
    const priceStr = prices[prices.length - 1];
    const price = toNumber(priceStr);
    if (price === null) continue;

    // Description = everything before the trailing price, minus stray SKU digits.
    let desc = line.slice(0, line.lastIndexOf(priceStr)).trim();
    desc = desc.replace(/\s{2,}/g, ' ').replace(/[*#]+$/, '').trim();

    // A leading run of >=5 digits often indicates a SKU/item number.
    let sku = null;
    const skuMatch = desc.match(/\b(\d{5,})\b/);
    if (skuMatch) sku = skuMatch[1];

    if (!desc || desc.replace(/[^a-z]/gi, '').length < 2) continue; // skip junk
    items.push({ description: desc, sku, qty: null, unitPrice: null, price, enrichment: null });
  }

  // Pull totals from the raw text if present.
  const totals = { subtotal: null, tax: null, total: null };
  const grab = (label) => {
    // \b boundaries prevent "total" from matching inside "subtotal".
    const re = new RegExp('\\b' + label + '\\b\\s*\\$?(\\d{1,5}\\.\\d{2})', 'i');
    const m = rawText && rawText.match(re);
    return m ? toNumber(m[1]) : null;
  };
  totals.subtotal = grab('sub\\s*total');
  totals.tax = grab('tax');
  totals.total = grab('total');

  return finalize(store, items, totals);
}

// Item prices should add up to the printed subtotal (which is pre-tax). A gap
// beyond this tolerance usually means a line item was missed or misread.
const SUBTOTAL_TOLERANCE = 0.02;

function finalize(store, items, totals) {
  const sumOfItems = Math.round(
    items.reduce((acc, it) => acc + (it.price || 0), 0) * 100
  ) / 100;
  const subtotal = totals.subtotal ?? null;
  // Heuristic data-quality signal. null when there's no subtotal to compare
  // against; otherwise whether the items reconcile with it.
  const subtotalMatch =
    subtotal == null ? null : Math.abs(sumOfItems - subtotal) <= SUBTOTAL_TOLERANCE;
  return {
    store: store && (store.name || store.date) ? store : null,
    items,
    totals: {
      subtotal,
      tax: totals.tax ?? null,
      total: totals.total ?? null,
      itemCount: items.length,
      sumOfItems,
      subtotalMatch,
    },
  };
}

// `finalize` is exported so retailer JSON adapters (src/retailers/adapters/*)
// build their totals the same way the OCR path does — same itemCount, same
// sumOfItems rounding, same subtotal reconciliation tolerance.
module.exports = { normalizeStructured, parseText, finalize };
