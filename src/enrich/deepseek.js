'use strict';

// Enrichment by DeepSeek's server-side web search (ENRICH_PROVIDER=deepseek), in
// place of Tavily. Same place in the pipeline, same `item.enrichment` slot, and
// read by the same views: `title` is the name a member sees instead of the
// register's abbreviation, `snippet` the line under it, `url` the ↗ beside it,
// `emoji` the tile when there is no picture.
//
// WHAT IT DOES NOT DO: find a picture. A web search returns pages, not images,
// so `imageUrl` is always null here, and a member's tiles fall back to the emoji.
// Asking the model for an image URL it never saw would be asking it to make one up.
//
// `url` is kept only when the search returned that page (src/deepseekSearch.js).
// `source: 'deepseek'` says where it came from; an enrichment with no `source`
// is Tavily's, as it always was.

const config = require('../config');
const logger = require('../logger');
const deepseekSearch = require('../deepseekSearch');
const { safeJson, normalizeEmoji } = require('../products/resolvers/anthropic');

const SNIPPET_MAX = 280; // the same cut Tavily's snippet gets

// The emoji rides on the same switch as the product emoji (PRODUCT_EMOJI_ENABLED):
// it is one more field in a call that is being made anyway.
function buildSystem(emoji) {
  return `You look up grocery products for a receipt app.
You are given ONE receipt line -- usually the register's abbreviated name for it -- and usually the store. Search the web to find out what product it is, then respond with ONLY a JSON object (no markdown, no commentary) of exactly this shape:

{
  "title": string | null,    // the product's real, human-readable name
  "url": string | null,      // the ONE page from your search results that best shows this product
  "snippet": string | null${
    emoji
      ? `,  // one sentence describing the product, at most 200 characters
  "emoji": string | null     // ONE emoji that depicts the product (e.g. 🥚 eggs, 🥛 milk, 🧻 paper towels)`
      : `   // one sentence describing the product, at most 200 characters`
  }
}

Rules:
- "url" must be copied exactly from your search results. Never construct, shorten or guess a URL.
- "url" is a page FOR THIS PRODUCT: a retailer's or the maker's product page. Not a search-results page, a category or listing page, an article or a review. If no result is a product page for it, use null.
- A store-brand abbreviation usually means that store's house brand ("KS" at Costco is Kirkland Signature, "MM" at Sam's Club is Member's Mark).
- If you cannot tell what the product is, set every field to null. Never invent a product.`;
}

function buildUserPrompt(item, storeName) {
  const lines = [`Receipt line: "${item.description}"`];
  if (storeName) lines.push(`Store: ${storeName}`);
  if (item.price !== null && item.price !== undefined) lines.push(`Price paid: $${Number(item.price).toFixed(2)}`);
  if (item.sku) lines.push(`Item number: ${item.sku}`);
  return lines.join('\n');
}

/**
 * Look up one line with DeepSeek's web search. Returns an enrichment, or null
 * when nothing was identified (that is `skipped`, as a Tavily miss is).
 *
 * @param {string} query   what the cache is keyed by (description + store)
 * @param {object} ctx     { item, storeName }
 */
async function searchItem(query, { item, storeName } = {}) {
  const { apiKey, model, baseUrl, thinking, maxSearches } = config.enrich.deepseek;
  if (!apiKey) return null;
  const emoji = !!config.products.emoji;
  const line = item && item.description ? item : { description: query };

  const { text, results } = await deepseekSearch.search({
    apiKey,
    model,
    baseUrl,
    thinking,
    maxSearches,
    maxTokens: 1024,
    system: buildSystem(emoji),
    user: buildUserPrompt(line, storeName),
  });

  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== 'object') {
    logger.warn({ query }, 'enrich(deepseek): the answer was not JSON');
    return null;
  }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const title = str(parsed.title);
  const url = deepseekSearch.grounded(str(parsed.url), results);
  if (str(parsed.url) && !url) {
    logger.info({ query, url: parsed.url, results: results.length }, 'enrich(deepseek): dropped a link the search did not return');
  }
  if (!title && !url) return null;

  const snippet = str(parsed.snippet);
  return {
    source: 'deepseek',
    query,
    imageUrl: null,
    imageDescription: null,
    title,
    url,
    snippet: snippet ? snippet.slice(0, SNIPPET_MAX) : null,
    emoji: emoji ? normalizeEmoji(parsed.emoji) : null,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { searchItem, buildSystem, buildUserPrompt };
