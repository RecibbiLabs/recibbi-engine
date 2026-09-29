'use strict';

// A CATEGORY FOR EVERY LINE THAT HAS NONE.
//
// The Products screen's category sidebar is built from the books -- every
// category some line carries, once (the atlas's categoriesOf()). Until now a
// line got a category from exactly one place: the product resolver, a web
// search per line that runs only when a receipt profile is applied to an
// upload. A synced Sam's Club receipt never meets it -- the retailer already
// sent a real name and a picture, so enrichment is off for it -- and
// samsclub.com sends no department either (`categoryPathId` is null on 289 of
// the 295 products in the corpus). So 295 Sam's Club products sat under no
// category, and the sidebar offered only what one Costco receipt had said.
//
// This is the cheap step that closes that: no web search, just the line's name
// read by a model, BATCHED -- one call for a receipt, a few for the whole
// history -- and two sources, in the order the atlas's catalogue lists them
// (assets/js/catalogue.js -> SOURCES):
//
//   recibbi   the category this member's books already give the SAME product
//             on another receipt. Nothing leaves the engine for it.
//   model     the name, read by the product resolver's model, and answered
//             from the categories already in the books where one fits.
//
// WHAT IT NEVER TOUCHES. A line the member named keeps what the member said --
// including a category they cleared. A line that already has a category from
// anywhere (its enrichment, or the resolver's result through the projection)
// keeps it. So running this twice writes nothing the second time, and it is
// safe as the one-off over history and as a pipeline step alike.
//
// THE LIST STAYS OPEN, and that is the atlas's rule rather than a loophole in
// it (pages/products.js: "THE FILTERS DO NOT PRETEND THE CATEGORY LIST IS
// FIXED"). SEED is where a first receipt starts, so a member's first hundred
// products land in a dozen aisles rather than a hundred near-synonyms; the
// model may still name a new one when nothing fits, and from then on it is in
// the list the next call is shown -- as is any category the member typed. A
// resolver's free text is not (see teaches()): it keeps its own lines, but it
// does not pull other products after it.
//
// Written onto `item.enrichment.category`, with `categoryBy` saying which
// source answered -- the projection reads the category from there exactly as
// it reads the resolver's.

const config = require('../config');
const logger = require('../logger');
const providerKeys = require('../settings/providerKeys');
const project = require('./project');
const providerOrder = require('../settings/providerOrder');

/* Where the list starts: a warehouse club's aisles, named the way the atlas
   names them (Meat & Seafood, Dairy & Eggs, Prepared Foods, ...). */
const SEED = [
  'Produce',
  'Meat & Seafood',
  'Dairy & Eggs',
  'Bakery',
  'Prepared Foods',
  'Frozen',
  'Pantry',
  'Snacks & Candy',
  'Breakfast & Cereal',
  'Beverages',
  'Coffee & Tea',
  'Alcohol',
  'Household',
  'Health & Wellness',
  'Personal Care',
  'Baby',
  'Pet',
  'Home & Furniture',
  'Outdoor & Garden',
  'Electronics',
  'Office',
  'Clothing',
  'Toys & Games',
  'Auto & Tires',
  'Fuel',
  'Services',
];

const BATCH = 60; // lines per model call
const MAX_CATEGORY = 40; // a category is a label, not a sentence

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The categories a vocabulary is built from: the books' own first, then SEED, once each. */
function vocabulary(existing) {
  const seen = new Map();
  for (const c of [...(existing || []), ...SEED]) {
    const s = str(c);
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
  }
  return [...seen.values()];
}

/**
 * The model's answer -> a category, or null. A label it returns in another
 * case is the vocabulary's spelling, so "dairy & eggs" does not become a
 * second filter beside "Dairy & Eggs"; anything that is not a short label is
 * no answer at all rather than a category called "I'm not sure".
 */
function clean(answer, vocab) {
  const s = str(answer);
  if (!s || s.length > MAX_CATEGORY || /[\n{}<>]/.test(s)) return null;
  if (/^(null|none|n\/a|unknown|other|misc(ellaneous)?)$/i.test(s)) return null;
  const hit = (vocab || []).find((v) => v.toLowerCase() === s.toLowerCase());
  return hit || s;
}

/* ------------------------------------------------------------- the model */

function buildSystem(vocab) {
  return `You sort the lines of a member's shopping receipts into store departments for a receipt app.
You are given numbered lines, each a product name and the store it was bought at. Answer with ONLY a JSON object (no markdown, no commentary) mapping each line's number to ONE category, for example {"1": "Produce", "2": "Household"}.

Use one of these categories whenever one fits, spelled exactly as written:
${vocab.map((v) => `- ${v}`).join('\n')}

Rules:
- Pick the department a shopper would look for the product in: eggs and cheese are "Dairy & Eggs", a rotisserie chicken is "Prepared Foods", paper towels and detergent are "Household", vitamins and medicine are "Health & Wellness", tires and motor oil are "Auto & Tires", gasoline is "Fuel".
- Only if none of the categories fits at all, answer a new short department name (at most three words, Title Case).
- If you cannot tell what a line is, answer null for it. Never guess wildly.`;
}

function buildUser(lines) {
  return lines
    .map((l, i) => `${i + 1}. ${l.description}${l.store ? ` (${l.store})` : ''}`)
    .join('\n');
}

function safeJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function askAnthropic(system, user) {
  const { apiKey, model, version, baseUrl } = config.products.anthropic;
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': version },
    body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
  });
  providerKeys.observe('anthropic', apiKey, res.status, res.statusText);
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function askDeepseek(system, user) {
  const { apiKey, model, baseUrl } = config.products.deepseek;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  providerKeys.observe('deepseek', apiKey, res.status, res.statusText);
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

const ASKERS = { anthropic: askAnthropic, deepseek: askDeepseek };

/**
 * Which models read the lines, in order: the PRODUCT_RESOLVER order's usable
 * ones (src/settings/providerOrder.js) -- a key its provider has not refused --
 * and then any other model here that has one, because categorizing is a job
 * any of them can do and a list written for the web-search resolver should not
 * leave lines uncategorized while a key sits unused. Empty when none -- then
 * this step files nothing and says so.
 */
function modelChain() {
  const first = providerOrder.usable('products').filter((id) => ASKERS[id]);
  const rest = Object.keys(ASKERS).filter((id) => !first.includes(id) && !providerOrder.blocker('products', id));
  return [...first, ...rest].map((id) => ({ id, ask: ASKERS[id] }));
}

/** The first of them, or null. */
function modelAsker() {
  return modelChain()[0] || null;
}

/**
 * Categorize lines with the model: [{description, store}] -> [category|null],
 * aligned by index. Batched; a batch that fails answers null for its lines and
 * the rest still stand.
 */
async function classifyWithModel(lines, vocab) {
  const chain = modelChain();
  if (!chain.length) return { answers: lines.map(() => null), model: null, failed: 0 };
  const answers = new Array(lines.length).fill(null);
  let failed = 0;
  for (let at = 0; at < lines.length; at += BATCH) {
    const chunk = lines.slice(at, at + BATCH);
    for (;;) {
      const asker = chain[0];
      if (!asker) {
        failed += chunk.length;
        break;
      }
      try {
        const parsed = safeJson(await asker.ask(buildSystem(vocab), buildUser(chunk)));
        if (!parsed || typeof parsed !== 'object') throw new Error('the answer was not a JSON object');
        chunk.forEach((_, i) => {
          answers[at + i] = parsed[String(i + 1)] === undefined ? null : parsed[String(i + 1)];
        });
        break;
      } catch (err) {
        // A refused key drops that model for the rest of the run and asks the
        // next one the same batch; anything else loses this batch only.
        if (providerOrder.refused(asker.id)) {
          chain.shift();
          logger.warn({ model: asker.id, next: chain[0] ? chain[0].id : null }, 'categorize: model refused its key; trying the next');
          continue;
        }
        failed += chunk.length;
        logger.warn({ err: err.message, lines: chunk.length, model: asker.id }, 'categorize: a batch went unanswered');
        break;
      }
    }
  }
  return { answers, model: chain[0] ? chain[0].id : null, failed };
}

/* ---------------------------------------------------------- the lines */

/**
 * Does this line still need a category? Not if the member named it, and not
 * if any source already gave it one -- read through the projection, so a
 * category only the resolver's result carries counts as the card does.
 *
 * `redo` asks again about lines THIS step categorized (`categoryBy` set) --
 * for when the vocabulary has improved. Still never a member's line, and
 * never a category the enrichment or the resolver gave.
 */
function needsCategory(item, resolved, { redo = false } = {}) {
  if (!item || typeof item !== 'object') return false;
  const e = item.enrichment && typeof item.enrichment === 'object' ? item.enrichment : null;
  if (e && e.named === 'member') return false;
  if (!str(item.description)) return false;
  if (redo && e && e.categoryBy) return true;
  const view = project.enrichmentView(item, project.resolvedFor(item, resolved));
  return !(view && view.category);
}

/**
 * Is this category one the VOCABULARY should offer? A member's is -- they
 * chose it -- and so is one this step gave, so a department the model had to
 * invent once is the one it is offered next time. The resolver's and the
 * enrichment's are not: each is one web search's free text, and offering
 * "Dairy" beside "Dairy & Eggs" is how a list of aisles becomes a list of
 * synonyms. Those still categorize their own lines; they just do not teach.
 */
function teaches(view) {
  return !!(view && view.category && (view.named === 'member' || view.categoryBy));
}

function stampCategory(item, category, by) {
  const e = item.enrichment && typeof item.enrichment === 'object' ? { ...item.enrichment } : {};
  e.category = category;
  e.categoryBy = by;
  item.enrichment = e;
}

/**
 * Categorize every line in a set of receipts that has no category, in place.
 *
 * One question per PRODUCT, not per line: the same eggs on forty receipts are
 * asked about once and answered on all forty, and a product the books have
 * already categorized is answered from the books without asking at all.
 *
 * @param {object[]} entries   [{ record, resolved }] -- resolved is the
 *                             receipt's resolvedIndex(), or null
 * @param {object}   [opts]
 * @param {Map}      [opts.known]     productKeyOf -> category, from the books
 * @param {string[]} [opts.existing]  categories the books teach (see teaches())
 * @param {Function} [opts.classify]  (lines, vocab) -> { answers, model } (tests)
 * @param {boolean}  [opts.dryRun]    answer, but write nothing onto the lines
 * @returns {Promise<object>} what was done, and which records changed
 */
async function categorizeRecords(
  entries,
  { known = new Map(), existing = [], classify = classifyWithModel, dryRun = false, redo = false } = {}
) {
  const pending = new Map(); // productKeyOf -> { description, store, targets: [item] }
  const learned = new Map(known);
  const taught = new Set(existing);
  for (const { record, resolved } of entries) {
    for (const item of (record && record.items) || []) {
      const key = project.productKeyOf(record, item);
      if (!needsCategory(item, resolved, { redo })) {
        // A line that has one teaches the rest of this run -- a product
        // categorized on one receipt answers the same product on the others.
        const view = item && project.enrichmentView(item, project.resolvedFor(item, resolved));
        const c = view && view.category;
        if (c && !learned.has(key)) learned.set(key, c);
        if (teaches(view)) taught.add(c);
        continue;
      }
      let p = pending.get(key);
      if (!p) {
        p = { description: str(item.description), store: str(record.store && record.store.name), targets: [] };
        pending.set(key, p);
      }
      p.targets.push({ record, item });
    }
  }

  const report = { products: pending.size, lines: 0, byRecibbi: 0, byModel: 0, unanswered: 0, model: null, failed: 0, categories: {} };
  const answer = new Map(); // key -> { category, by }
  const ask = [];
  for (const [key, p] of pending) {
    if (learned.has(key)) answer.set(key, { category: learned.get(key), by: 'recibbi' });
    else ask.push([key, p]);
  }

  if (ask.length) {
    const vocab = vocabulary([...taught]);
    const { answers, model, failed } = await classify(ask.map(([, p]) => ({ description: p.description, store: p.store })), vocab);
    report.model = model || null;
    report.failed = failed || 0;
    ask.forEach(([key], i) => {
      const c = clean(answers && answers[i], vocab);
      if (c) answer.set(key, { category: c, by: 'model' });
    });
  }

  const changed = new Set();
  for (const [key, p] of pending) {
    const a = answer.get(key);
    if (!a) {
      report.unanswered += 1;
      continue;
    }
    if (a.by === 'recibbi') report.byRecibbi += 1;
    else report.byModel += 1;
    report.categories[a.category] = (report.categories[a.category] || 0) + 1;
    for (const { record, item } of p.targets) {
      report.lines += 1;
      if (dryRun) continue;
      stampCategory(item, a.category, a.by);
      changed.add(record);
    }
  }
  report.records = [...changed];
  report.answers = answer;
  return report;
}

/**
 * Write answers already worked out onto a record's lines: every line that
 * still needs a category and whose product has an answer. For a caller that
 * worked the answers out over one copy of a receipt and writes them onto a
 * FRESHER copy -- the history job, which must not put back a receipt as it was
 * before a member named something on it in the meantime. Returns the count.
 */
function applyAnswers(record, answers, resolved, { redo = false } = {}) {
  let n = 0;
  for (const item of (record && record.items) || []) {
    if (!needsCategory(item, resolved, { redo })) continue;
    const a = answers.get(project.productKeyOf(record, item));
    if (!a) continue;
    const e = item.enrichment || {};
    if (e.category === a.category && e.categoryBy === a.by) continue;
    stampCategory(item, a.category, a.by);
    n += 1;
  }
  return n;
}

module.exports = {
  SEED,
  BATCH,
  vocabulary,
  clean,
  buildSystem,
  buildUser,
  needsCategory,
  teaches,
  classifyWithModel,
  modelAsker,
  modelChain,
  categorizeRecords,
  applyAnswers,
};
