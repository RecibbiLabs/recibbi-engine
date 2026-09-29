'use strict';

const fsp = require('fs/promises');
const config = require('../config');
const logger = require('../logger');
const { imagePathFor } = require('../store');
const { UnrecoverableError } = require('bullmq');
const providerKeys = require('../settings/providerKeys');
const providerOrder = require('../settings/providerOrder');

const EXTRACTION_PROMPT = `You are a precise receipt transcriber. You are given a photo of a grocery store receipt.
Transcribe the contents and respond with ONLY a JSON object (no markdown, no commentary) of this exact shape:

{
  "store": { "name": string | null, "date": string | null },
  "items": [
    {
      "description": string,      // the line-item name EXACTLY as printed (see transcription rules)
      "sku": string | null,        // item/SKU number if printed, else null
      "qty": number | null,
      "unitPrice": number | null,
      "price": number              // the charged amount for the line, as a number
    }
  ],
  "totals": { "subtotal": number | null, "tax": number | null, "total": number | null }
}

Transcription rules (this output is used as OCR ground truth, so fidelity matters more than readability):
- Transcribe each item "description" VERBATIM — character for character as printed on the receipt.
- Do NOT clean up, expand, normalize, correct, or translate the text. Keep the receipt's original
  abbreviations ("KS SPARK WAT", not "Kirkland Signature Sparkling Water"; "5DZ EGGS", not "5 Dozen Eggs"),
  its capitalization, its spacing, and its punctuation as printed.
- Do NOT add words that are not printed (e.g. do not append "Cheese", "Water", or a brand the receipt omits).
- Only fix a character if the printed glyph is genuinely ambiguous in the image; never "improve" a name
  that is already legible.

Other rules:
- Only include real purchased products. Exclude subtotals, tax lines, totals, payment/tender lines, store info,
  and standalone savings/discount lines from "items" UNLESS the discount is printed as its own line tied to an
  item — in that case transcribe it verbatim as a separate item with a negative price.
- Prices are plain numbers (e.g. 12.99), never strings, never with currency symbols.
- If a value is not present, use null. Never invent SKUs or prices.
- "store.name" is the printed store/header name as-is.
- "date" should be ISO-ish (YYYY-MM-DD) when you can determine it, otherwise the raw printed date or null.`;

function bufferToBase64(buf) {
  return buf.toString('base64');
}

function safeJson(text) {
  if (!text) return null;
  let t = text.trim();
  // Strip ```json fences if the model added them despite instructions.
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Fall back to the first {...} block.
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch (err) {
    logger.warn({ err: err.message }, 'vision: failed to parse model JSON');
    return null;
  }
}

async function extractWithAnthropic(base64, mimeType) {
  const { apiKey, model, version, baseUrl } = config.vision.anthropic;
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': version,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });
  // The last answer, for the operator's card: a key can be revoked in the
  // provider's own dashboard without anybody here touching it.
  providerKeys.observe('anthropic', apiKey, res.status, res.statusText);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return text;
}

async function extractWithOpenAI(base64, mimeType) {
  const { apiKey, model, baseUrl } = config.vision.openai;
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EXTRACTION_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  providerKeys.observe('openai', apiKey, res.status, res.statusText);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// DeepSeek speaks the OpenAI chat format at its own path (no /v1). Two things
// differ from the OpenAI call above: JSON mode is asked for, because the prompt
// already names the shape and a reply that parses is the only kind that helps;
// and `thinking` is set explicitly, because DeepSeek thinks unless told not to.
async function extractWithDeepSeek(base64, mimeType) {
  const { apiKey, model, baseUrl, thinking } = config.vision.deepseek;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
      thinking: { type: thinking ? 'enabled' : 'disabled' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EXTRACTION_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  providerKeys.observe('deepseek', apiKey, res.status, res.statusText);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content || '';
  // DeepSeek documents that JSON mode can answer with empty content. That says
  // nothing about the receipt, so it fails the attempt and the job is retried,
  // rather than sealing a receipt with no items.
  if (!text.trim()) {
    throw new Error(`DeepSeek API returned no content (finish_reason: ${choice?.finish_reason || 'none'})`);
  }
  return text;
}

const READERS = {
  anthropic: extractWithAnthropic,
  openai: extractWithOpenAI,
  deepseek: extractWithDeepSeek,
};

/**
 * Read a photo with the FIRST USABLE READER in the VISION_PROVIDER order
 * (src/settings/providerOrder.js): one with a key its provider has not refused.
 *
 * A reader that REFUSES its key during this call -- nothing had called it
 * since the key changed, or the key was revoked in the provider's dashboard --
 * is recorded as refused (providerKeys.observe(), inside each call) and the
 * next usable reader reads the same photo. Any other failure (a 429, a 500, an
 * answer that is not JSON) is the provider's afternoon, not its key: it fails
 * this attempt and the queue retries, as it always did.
 *
 * NOBODY CAN READ is UNRECOVERABLE, and says why, reader by reader: retrying a
 * missing key three times is six minutes of "processing" for nothing.
 *
 * @returns {Promise<{ rawText: string|null, structured: object|null, reader: string }>}
 */
async function extract(record) {
  const pick = providerOrder.pick('vision');
  if (!pick.chosen) throw new UnrecoverableError(`vision OCR cannot run: ${providerOrder.nobody('vision', pick)}`);

  const buf = await fsp.readFile(imagePathFor(record));
  const base64 = bufferToBase64(buf);
  let mimeType = record.image.mimeType;
  if (!/^image\//.test(mimeType)) mimeType = 'image/jpeg';

  const refusedNow = [];
  for (const id of pick.usable) {
    const read = READERS[id];
    if (!read) continue;
    try {
      const text = await read(base64, mimeType);
      if (refusedNow.length) {
        logger.warn({ id: record.id, reader: id, refused: refusedNow.map((r) => r.id) }, 'vision: read by a later reader after a refusal');
      }
      return { rawText: text, structured: safeJson(text), reader: id };
    } catch (err) {
      if (!providerOrder.refused(id)) throw err;
      refusedNow.push(providerOrder.refusal(id));
      logger.warn({ id: record.id, reader: id, err: err.message }, 'vision: reader refused its key; trying the next');
    }
  }
  throw new UnrecoverableError(
    `vision OCR cannot run: ${providerOrder.explain([...pick.skipped, ...refusedNow])} -- ` +
      'every reader in the order is missing a key or refused it.'
  );
}

module.exports = { extract };
