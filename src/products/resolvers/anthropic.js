'use strict';

// Default product resolver: map ONE receipt line item to product info via a
// low-end Anthropic model (Haiku 4.5 by default). Mirrors src/ocr/vision.js —
// the project calls the Anthropic REST API directly with `fetch` (no SDK), so
// this keeps that convention.
//
// When config.products.anthropic.webSearch is on, the request enables Anthropic's
// SERVER-SIDE web_search/web_fetch tools so `productUrl` is a real, grounded link
// — the web retrieval runs on Anthropic's infrastructure, which is why it works
// on this managed network even though direct outbound fetches to Tavily/CDNs
// are TLS-blocked. With it off, the model answers from its own knowledge and the
// URL may be approximate.

const config = require('../../config');
const logger = require('../../logger');
const providerKeys = require('../../settings/providerKeys');

// The system prompt is built per-call because the emoji field is optional
// (config.products.emoji): when off we don't ask for it at all, so there's no
// behavior change and no wasted tokens. The base prompt is otherwise constant.
function buildSystem(cfg) {
  const emoji = !!(cfg && cfg.products && cfg.products.emoji);
  return `You are a product-research assistant for a grocery receipt app.
You are given a SINGLE receipt line item — possibly noisy or abbreviated (e.g. "KS SPARK WAT", "5DZ EGGS") — and possibly the store name and the price paid.
Identify the real retail product the line refers to, then respond with ONLY a JSON object (no markdown, no commentary) of exactly this shape:

{
  "productTitle": string | null,        // the product's real, human-readable name
  "productDescription": string | null,  // 1-3 sentences describing the product
  "productUrl": string | null,          // the single best web page that substantiates this product
  "brand": string | null,
  "category": string | null,            // e.g. "Beverages", "Dairy", "Produce"${
    emoji
      ? `
  "emoji": string | null,               // ONE emoji that best represents the product (see rules)`
      : ''
  }
  "confidence": number                  // 0..1, your confidence this is the right product
}

Rules:
- "productUrl" must be the ONE link that best substantiates the product (a retailer or manufacturer product page preferred). Return the actual URL you found, never a guessed or placeholder URL.
- Use the store name and price (when provided) to disambiguate — a store-brand abbreviation usually maps to that store's house brand.${
    emoji
      ? `
- "emoji" must be a SINGLE emoji that most meaningfully depicts the product (e.g. 🥚 for eggs, 🥛 for milk, 🍌 for bananas, 🧻 for paper towels). Pick the most specific food/grocery emoji that fits; use null only if nothing reasonably represents it. Never return more than one emoji or any text.`
      : ''
  }
- If you cannot confidently identify a product, set the unknown fields to null and "confidence" to a low value. Never invent a product or a URL.`;
}

/**
 * Build the user-turn prompt, customized to the fields actually present. The
 * line-item description is always included; store name, price, sku and qty are
 * added only when available (a receipt may carry none of them).
 * @param {object} item  { description, sku, qty, unitPrice, price }
 * @param {object} ctx   { storeName, storeDate }
 */
function buildUserPrompt(item, ctx) {
  const lines = [`Receipt line item: "${item.description}"`];
  if (ctx && ctx.storeName) lines.push(`Store: ${ctx.storeName}`);
  if (item.price !== null && item.price !== undefined) lines.push(`Price paid: $${Number(item.price).toFixed(2)}`);
  if (item.unitPrice !== null && item.unitPrice !== undefined) lines.push(`Unit price: $${Number(item.unitPrice).toFixed(2)}`);
  if (item.qty !== null && item.qty !== undefined) lines.push(`Quantity: ${item.qty}`);
  if (item.sku) lines.push(`SKU/item number: ${item.sku}`);
  lines.push('Identify the product and return the JSON object described above.');
  return lines.join('\n');
}

// Server-side web tools, included only when webSearch is enabled.
// `allowed_callers: ['direct']` is REQUIRED for low-end models: by default these
// tool versions are wired for *programmatic tool calling* (the dynamic-filtering
// path), which Haiku doesn't support — the API 400s ("does not support
// programmatic tool calling") unless we opt the tools into direct calling, i.e.
// the normal server-side tool loop. Opus/Sonnet support either path.
function buildTools(cfg) {
  if (!cfg.products.anthropic.webSearch) return [];
  return [
    { type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] },
    { type: 'web_fetch_20260209', name: 'web_fetch', allowed_callers: ['direct'] },
  ];
}

// Reuse vision.js's lenient JSON extraction shape: strip ``` fences, fall back
// to the first {...} block, parse. Kept local to avoid coupling the modules.
function safeJson(text) {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch (err) {
    logger.warn({ err: err.message }, 'products(anthropic): failed to parse model JSON');
    return null;
  }
}

function textFrom(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Accept only a short string that actually contains a pictographic emoji, so a
// stray sentence or placeholder ("none", "N/A") can never leak into the view.
// ZWJ sequences (e.g. 👨‍🍳) push the code-unit length up, so allow a little room
// while still rejecting prose.
function normalizeEmoji(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 16) return null;
  if (!/\p{Extended_Pictographic}/u.test(t)) return null;
  return t;
}

/** Normalize the model's JSON into ProductFields (tolerant of missing keys). */
function normalize(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out = {
    productTitle: str(parsed.productTitle),
    productDescription: str(parsed.productDescription),
    productUrl: str(parsed.productUrl),
    brand: str(parsed.brand),
    category: str(parsed.category),
    emoji: normalizeEmoji(parsed.emoji),
    confidence: num(parsed.confidence),
  };
  // Nothing usable came back.
  if (!out.productTitle && !out.productDescription && !out.productUrl) return null;
  return out;
}

const MAX_CONTINUATIONS = 4; // server-tool loops return pause_turn at the iter limit

/**
 * @param {object} item  LineItem
 * @param {object} ctx   { storeName, storeDate, config, log }
 * @returns {Promise<object|null>} ProductFields or null
 */
async function resolve(item, ctx) {
  const cfg = (ctx && ctx.config) || config;
  const { apiKey, model, version, baseUrl } = cfg.products.anthropic;
  const tools = buildTools(cfg);
  const system = buildSystem(cfg);
  const emojiEnabled = !!(cfg.products && cfg.products.emoji);

  let messages = [{ role: 'user', content: buildUserPrompt(item, ctx) }];

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const body = {
      model,
      max_tokens: 2048,
      system,
      messages,
    };
    if (tools.length) body.tools = tools;

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': version,
      },
      body: JSON.stringify(body),
    });
    providerKeys.observe('anthropic', apiKey, res.status, res.statusText);
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await res.json();

    // Server-side tool loop hit its iteration cap: re-send to resume (no extra
    // user turn — the API detects the trailing server_tool_use and continues).
    if (data.stop_reason === 'pause_turn') {
      messages = [...messages, { role: 'assistant', content: data.content }];
      continue;
    }
    const fields = normalize(safeJson(textFrom(data.content)));
    // The flag is authoritative: drop any emoji the model volunteered when the
    // feature is off, so toggling it cleanly disables the field end-to-end.
    if (fields && !emojiEnabled) fields.emoji = null;
    return fields;
  }

  // Exhausted continuations without a final answer.
  logger.warn({ description: item.description }, 'products(anthropic): gave up after max continuations');
  return null;
}

module.exports = {
  id: 'anthropic',
  meta: {
    name: 'Anthropic line-item resolver',
    description:
      'Maps a receipt line item to product info using a low-end Anthropic model, optionally grounding the link with server-side web search.',
  },
  ready: (cfg) => !!((cfg || config).products.anthropic.apiKey),
  resolve,
  // exported for unit tests
  buildSystem,
  buildUserPrompt,
  buildTools,
  safeJson,
  normalize,
  normalizeEmoji,
};
