'use strict';

// DeepSeek's server-side web search, shared by the enrichment lookup
// (src/enrich/deepseek.js) and the product resolver (products/resolvers/deepseek.js).
//
// It lives on DeepSeek's ANTHROPIC-FORMAT endpoint (<baseUrl>/anthropic), not the
// OpenAI-format one the photo reader uses: that is where DeepSeek runs a
// `web_search` server tool -- the same one that serves Claude Code's Web Search
// when Claude Code is pointed at DeepSeek. The tool type is the one Claude Code
// sends, `web_search_20250305`; `web_search_20260209` is accepted too. Both were
// checked live on 2026-09-23. The answer comes back in Anthropic's shape:
// server_tool_use and web_search_tool_result blocks, then the model's text. The
// search runs on DeepSeek's side, so nothing here reaches the open web -- which
// matters on a network whose TLS interception blocks Tavily.
//
// GROUNDED MEANS "IN THE RESULTS". Every page the search returned is collected,
// so a caller keeps a URL the model names only when the search actually returned
// it (`grounded()`), and drops one the model assembled on its own.
//
// Thinking is sent explicitly: DeepSeek thinks unless told not to, and a lookup
// is a search and a summary, not a proof.

const providerKeys = require('./settings/providerKeys');

const TOOL_TYPE = 'web_search_20250305';

// A server-tool loop that hits its iteration cap answers `pause_turn`; the turn
// is re-sent to let it finish, as the Anthropic resolver does.
const MAX_CONTINUATIONS = 4;

function textOf(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Every page a web_search_tool_result block carries (an error block carries none). */
function resultsOf(content) {
  const out = [];
  for (const b of content || []) {
    if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue;
    for (const r of b.content) {
      if (r && r.type === 'web_search_result' && typeof r.url === 'string') {
        out.push({ url: r.url, title: typeof r.title === 'string' ? r.title : null });
      }
    }
  }
  return out;
}

// Same page, spelled either way: host without `www.`, path without a trailing
// slash, and neither the query string nor the fragment -- a model that copies a
// result URL often drops its tracking parameters, and that is still the page the
// search returned.
function pageOf(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it encoded */
  }
  return `${url.hostname.toLowerCase().replace(/^www\./, '')}${path.replace(/\/+$/, '').toLowerCase()}`;
}

/**
 * The URL, if the search returned that page; null if it did not. A link the
 * model built from a pattern -- a plausible product id on a real retailer's
 * domain -- is the one kind of wrong a member cannot tell from right.
 */
function grounded(url, results) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const page = pageOf(url.trim());
  if (!page) return null;
  return (results || []).some((r) => pageOf(r.url) === page) ? url.trim() : null;
}

/**
 * One question, answered with DeepSeek's web search available.
 *
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {string} o.baseUrl       DeepSeek's base URL, without /anthropic
 * @param {boolean} [o.thinking]
 * @param {number} [o.maxSearches] `max_uses` on the tool; DeepSeek enforces it
 * @param {number} [o.maxTokens]
 * @param {string} o.system
 * @param {string} o.user
 * @returns {Promise<{ text: string, results: Array<{url:string,title:string|null}>, searches: number }>}
 */
async function search(o) {
  const tool = { type: TOOL_TYPE, name: 'web_search' };
  if (o.maxSearches > 0) tool.max_uses = o.maxSearches;

  let messages = [{ role: 'user', content: o.user }];
  const results = [];
  let searches = 0;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const res = await fetch(`${o.baseUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': o.apiKey,
        // Ignored by DeepSeek; sent so the request is a well-formed Messages call.
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: o.model,
        max_tokens: o.maxTokens || 2048,
        system: o.system,
        thinking: { type: o.thinking ? 'enabled' : 'disabled' },
        tools: [tool],
        messages,
      }),
    });
    providerKeys.observe('deepseek', o.apiKey, res.status, res.statusText);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    results.push(...resultsOf(data.content));
    searches += (data.usage && data.usage.server_tool_use && data.usage.server_tool_use.web_search_requests) || 0;

    if (data.stop_reason === 'pause_turn') {
      messages = [...messages, { role: 'assistant', content: data.content }];
      continue;
    }
    const text = textOf(data.content);
    // Nothing to read is a failed call, not "no product": thrown, it is recorded
    // as an error and never cached.
    if (!text.trim()) throw new Error(`DeepSeek API returned no answer (stop_reason: ${data.stop_reason || 'none'})`);
    return { text, results, searches };
  }
  throw new Error(`DeepSeek web search did not finish after ${MAX_CONTINUATIONS} continuations`);
}

module.exports = { search, grounded, TOOL_TYPE, _internal: { resultsOf, pageOf, textOf } };
