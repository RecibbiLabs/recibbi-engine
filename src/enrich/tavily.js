'use strict';

const config = require('../config');
const logger = require('../logger');
const providerKeys = require('../settings/providerKeys');

/**
 * Look up one item via the Tavily Search API, asking for related images.
 * Returns a compact enrichment object or null.
 */
async function searchItem(query) {
  const { apiKey, baseUrl, searchDepth, maxResults } = config.enrich.tavily;
  if (!apiKey) return null;

  const res = await fetch(`${baseUrl}/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: searchDepth,
      include_images: true,
      include_image_descriptions: true,
      max_results: maxResults,
    }),
  });

  providerKeys.observe('tavily', apiKey, res.status, res.statusText);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const firstImage = Array.isArray(data.images) && data.images.length ? data.images[0] : null;
  const firstResult = Array.isArray(data.results) && data.results.length ? data.results[0] : null;

  return {
    query,
    imageUrl: firstImage ? firstImage.url || null : null,
    imageDescription: firstImage ? firstImage.description || null : null,
    title: firstResult ? firstResult.title || null : null,
    url: firstResult ? firstResult.url || null : null,
    snippet: firstResult ? (firstResult.content || '').slice(0, 280) || null : null,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { searchItem };
