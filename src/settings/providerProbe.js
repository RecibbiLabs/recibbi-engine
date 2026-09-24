'use strict';

// Ask a provider whether it accepts a key, BEFORE it is stored.
//
// One cheap, authenticated, side-effect-free call per provider. Each was checked
// against the live provider with a bogus key before being relied on (2026-09-23),
// and every one answers 401 to a key it does not know:
//
//   anthropic  GET  /v1/models              x-api-key       401 authentication_error
//   openai     GET  /v1/models              Bearer          401 invalid_api_key
//   tavily     GET  /usage                  Bearer          401 "missing or invalid API key"
//   telegram   GET  /bot<token>/getMe                       401 Unauthorized
//
// None of them spends a credit. A search would have proven Tavily's key too, and
// billed the operator for the privilege every time they pressed Save.
//
// THE ANSWER HAS THREE SHAPES, not two, and the difference is what the operator
// is told. `refused` means the provider looked at the key and said no -- retype
// it. Anything else (a 429, a 500, no network) means nothing was learned about
// the key at all, and it is not stored either: "Anthropic did not accept it"
// would be a false sentence about a key that may be perfectly good.

const config = require('../config');

const TIMEOUT_MS = 10000;

const CALLS = {
  anthropic: (v) => [
    `${config.vision.anthropic.baseUrl}/v1/models?limit=1`,
    { headers: { 'x-api-key': v.apiKey, 'anthropic-version': config.vision.anthropic.version } },
  ],
  openai: (v) => [
    `${config.vision.openai.baseUrl}/v1/models`,
    { headers: { authorization: `Bearer ${v.apiKey}` } },
  ],
  tavily: (v) => [
    `${config.enrich.tavily.baseUrl}/usage`,
    { headers: { authorization: `Bearer ${v.apiKey}` } },
  ],
  telegram: (v) => [`${config.telegram.apiRoot}/bot${v.botToken}/getMe`, {}],
};

/**
 * @param {string} pk      provider key
 * @param {object} values  every field, as the provider would be called with it
 * @returns {Promise<{ ok: boolean, refused?: boolean, status?: number, said?: string }>}
 */
async function probe(pk, values) {
  const call = CALLS[pk];
  if (!call) return { ok: false, said: 'nothing in the engine knows how to ask it' };
  const [url, init] = call(values);
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, said: err.name === 'TimeoutError' ? 'it did not answer in time' : 'it could not be reached' };
  }
  // Drain the body; nothing in it is needed, and an unread body holds the socket.
  await res.arrayBuffer().catch(() => null);
  if (res.ok) return { ok: true, status: res.status };
  return {
    ok: false,
    refused: res.status === 401 || res.status === 403,
    status: res.status,
    said: res.statusText || undefined,
  };
}

module.exports = { probe, CALLS };
