'use strict';

// Product resolver backed by DeepSeek's chat model (deepseek-flash by default).
// Same contract, prompt and normalization as resolvers/anthropic.js -- only the
// call differs -- so a product named by either reads the same in the view and
// in the shared cache (whose key carries the resolver id, so the two never mix).
//
// TWO PATHS, chosen by config.products.deepseek.webSearch:
//
//   on (default)  DeepSeek's server-side web search (src/deepseekSearch.js), on
//                 its Anthropic-format endpoint. productUrl is kept ONLY if the
//                 search returned that page -- a link the model assembled from
//                 a pattern is dropped, and the rest of the product stands.
//   off           the OpenAI-format chat call, no search. The prompt is built
//                 with `grounded: false`, which asks for a link only when the
//                 model is certain of it and null otherwise.
//
// Either way a missing link is honest; a plausible-looking 404 is not.

const config = require('../../config');
const logger = require('../../logger');
const providerKeys = require('../../settings/providerKeys');
const deepseekSearch = require('../../deepseekSearch');
const { buildSystem, buildUserPrompt, safeJson, normalize } = require('./anthropic');

async function resolveWithSearch(item, ctx, cfg) {
  const { apiKey, model, baseUrl, thinking, maxSearches } = cfg.products.deepseek;
  const { text, results } = await deepseekSearch.search({
    apiKey,
    model,
    baseUrl,
    thinking,
    maxSearches,
    maxTokens: 2048,
    system: buildSystem(cfg, { grounded: true }),
    user: buildUserPrompt(item, ctx),
  });
  const fields = normalize(safeJson(text));
  if (fields && fields.productUrl) {
    const kept = deepseekSearch.grounded(fields.productUrl, results);
    if (!kept) {
      logger.info(
        { description: item.description, url: fields.productUrl, results: results.length },
        'products(deepseek): dropped a link the search did not return'
      );
    }
    fields.productUrl = kept;
  }
  return fields;
}

/**
 * @param {object} item  LineItem
 * @param {object} ctx   { storeName, storeDate, config, log }
 * @returns {Promise<object|null>} ProductFields or null
 */
async function resolve(item, ctx) {
  const cfg = (ctx && ctx.config) || config;
  const emojiEnabled = !!(cfg.products && cfg.products.emoji);

  if (cfg.products.deepseek.webSearch) {
    const fields = await resolveWithSearch(item, ctx, cfg);
    if (fields && !emojiEnabled) fields.emoji = null;
    return fields;
  }

  const { apiKey, model, baseUrl, thinking } = cfg.products.deepseek;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      thinking: { type: thinking ? 'enabled' : 'disabled' },
      messages: [
        { role: 'system', content: buildSystem(cfg, { grounded: false }) },
        { role: 'user', content: buildUserPrompt(item, ctx) },
      ],
    }),
  });
  providerKeys.observe('deepseek', apiKey, res.status, res.statusText);
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content || '';
  // JSON mode can answer with empty content. That is a failed call, not "no
  // confident match": thrown, it is recorded as an error and never cached.
  if (!text.trim()) {
    throw new Error(`DeepSeek API returned no content (finish_reason: ${choice?.finish_reason || 'none'})`);
  }
  const fields = normalize(safeJson(text));
  if (!fields) logger.debug({ description: item.description }, 'products(deepseek): no product in reply');
  // The flag is authoritative, as in the Anthropic resolver.
  if (fields && !emojiEnabled) fields.emoji = null;
  return fields;
}

module.exports = {
  id: 'deepseek',
  meta: {
    name: 'DeepSeek line-item resolver',
    description:
      'Maps a receipt line item to product info using DeepSeek, grounding the link with DeepSeek\'s server-side web search: a link is kept only when the search returned that page.',
  },
  ready: (cfg) => !!((cfg || config).products.deepseek.apiKey),
  resolve,
};
