'use strict';

// WHO DOES EACH JOB: an ordered list of providers per job, and the first one
// that can actually do it, decided when the job runs.
//
// Three jobs call an outside model, and each used to name exactly one provider
// in .env:
//
//   vision     reads a photographed receipt          VISION_PROVIDER
//   enrich     the web lookup behind each line       ENRICH_PROVIDER
//   products   names a line as a product (resolver)  PRODUCT_RESOLVER
//
// One name meant one way to fail silently. VISION_PROVIDER=anthropic with no
// Anthropic key, and a DeepSeek key saved in Settings, read every photo with
// Tesseract -- or with nothing, where Tesseract has no language data -- while
// a working reader sat one setting away. So each variable now takes a LIST, in
// order of preference:
//
//   VISION_PROVIDER=anthropic,deepseek
//
// and the job goes to THE FIRST ONE THAT IS USABLE WHEN IT RUNS:
//
//   - it has a key: saved in Settings -> Providers, or in .env (providerKeys.value());
//   - and the provider has not REFUSED that key: the last answer recorded for
//     exactly this key, by the probe on save or by observe() on a real call,
//     is not a 401/403 (providerKeys.view().check).
//
// DECIDED PER CALL, NEVER AT BOOT, for the same reason the keys are read per
// call: a key saved at noon, or refused by its provider at noon, changes who
// reads the 12:01 receipt -- in the worker and the bot as much as in the api.
// And the call sites FALL THROUGH: a provider that refuses its key during the
// call (the check was stale, or nothing had called it yet) is recorded as
// refused by observe(), and the next usable one does the same job in the same
// call. So "is this key valid" is answered before a provider is chosen where it
// is already known, and by the provider itself where it is not -- and a list
// in which nothing works ends in one error that says why, provider by provider,
// rather than in a timeout.
//
// THE ORDER ITSELF CAN BE CHANGED FROM THE SCREEN. Settings -> Providers saves
// an order per job, and a saved order wins over .env exactly as a saved key
// does; removing it falls back to .env. It is not a secret, so it is a plain
// JSON file beside the keys, read with the same one-stat-per-call cache:
//
//   <dataDir>/.registry/provider-order.json   { version, jobs: { vision: { order, savedAt } } }
//
// A test (or anything in-process) can PIN a job's order by assigning to
// config.vision.provider / config.enrich.provider / config.products.resolver,
// which is what the suite always did with the single name; see src/config.js.

const fs = require('fs');
const path = require('path');
const { withLock } = require('./lock');
const { SettingsError } = require('./validate');

const config = () => require('../config');
const logger = () => require('../logger');
const providerKeys = () => require('./providerKeys');

/**
 * The jobs, the providers that can do each, and what each list is when nothing
 * names one. The candidates' ids are also the providerKeys ids that hold their
 * keys: an OCR reader called `deepseek` reads with the `deepseek` key.
 */
const JOBS = {
  vision: {
    name: 'Reading photographed receipts',
    env: 'VISION_PROVIDER',
    candidates: ['anthropic', 'openai', 'deepseek'],
    fallback: ['anthropic'],
  },
  enrich: {
    name: 'Looking each line up on the web',
    env: 'ENRICH_PROVIDER',
    candidates: ['tavily', 'deepseek'],
    fallback: ['tavily'],
  },
  products: {
    name: 'Naming each line as a product',
    env: 'PRODUCT_RESOLVER',
    candidates: ['anthropic', 'deepseek'],
    fallback: ['anthropic'],
  },
};

function job(id) {
  if (!Object.prototype.hasOwnProperty.call(JOBS, id)) {
    throw new SettingsError(404, `There is no "${id}" job (expected: ${Object.keys(JOBS).join(' | ')}).`);
  }
  return JOBS[id];
}

/* ------------------------------------------------------------------ parsing */

const warned = new Set();

/**
 * "anthropic, DeepSeek ,anthropic" -> ['anthropic', 'deepseek']. Lower-cased,
 * trimmed, each once, in the order given. A name that cannot do this job is
 * dropped with ONE warning per value -- a typo in .env should be loud in the log
 * and not fatal to a service that may have a working provider later in the list.
 */
function parseList(jobId, raw) {
  const j = JOBS[jobId];
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const id = part.trim().toLowerCase();
    if (!id || out.includes(id)) continue;
    if (!j.candidates.includes(id)) {
      const k = `${jobId}:${id}`;
      if (!warned.has(k)) {
        warned.add(k);
        logger().warn({ job: jobId, env: j.env, provider: id, known: j.candidates }, 'provider order: not a provider for this job; ignored');
      }
      continue;
    }
    out.push(id);
  }
  return out;
}

/* ---------------------------------------------------------- the saved order */

function orderFile() {
  return path.join(config().dataDir, '.registry', 'provider-order.json');
}

let snapshot = null; // { stamp, doc }

function emptyDoc() {
  return { version: 1, jobs: {} };
}

/** The saved orders, re-read only when the file changed (one stat per call). */
function savedDoc() {
  let st;
  try {
    st = fs.statSync(orderFile());
  } catch {
    snapshot = null;
    return emptyDoc();
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  if (snapshot && snapshot.stamp === stamp) return snapshot.doc;
  let doc = emptyDoc();
  try {
    const parsed = JSON.parse(fs.readFileSync(orderFile(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object') doc = parsed;
  } catch (err) {
    logger().error({ err: err.message }, 'provider order: saved order unreadable; using .env');
  }
  snapshot = { stamp, doc };
  return doc;
}

function writeDoc(doc) {
  const file = orderFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
  snapshot = null;
}

/* ------------------------------------------------------------------ pinning */

const pins = new Map(); // jobId -> string[]

/** In-process override (tests, via the config setters). null/'' unpins. */
function pin(jobId, value) {
  job(jobId);
  if (value === null || value === undefined || value === '') {
    pins.delete(jobId);
    return;
  }
  // Kept as given, unknown names included: a pin is a test saying exactly what
  // it wants, and one naming a provider that does not exist is testing that.
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((v) => String(v).trim().toLowerCase())
    .filter(Boolean);
  pins.set(jobId, [...new Set(list)]);
}

/* -------------------------------------------------------------- the answers */

/**
 * The order for a job, and where it came from:
 *   'pinned'   assigned in this process (tests)
 *   'saved'    Settings -> Providers
 *   'env'      the job's variable in .env
 *   'default'  nothing named one
 */
function order(jobId) {
  const j = job(jobId);
  if (pins.has(jobId)) return { order: pins.get(jobId).slice(), from: 'pinned' };
  const s = savedDoc().jobs[jobId];
  const saved = s && Array.isArray(s.order) ? s.order.filter((id) => j.candidates.includes(id)) : [];
  if (saved.length) return { order: saved, from: 'saved', savedAt: s.savedAt || null };
  const env = parseList(jobId, process.env[j.env]);
  if (env.length) return { order: env, from: 'env' };
  return { order: j.fallback.slice(), from: 'default' };
}

/**
 * Does this provider hold a key for this job right now? Read through config --
 * config.vision.deepseek.apiKey and the like -- which is providerKeys.value()
 * per call (saved, else .env), or a value a test pinned.
 */
function hasKey(jobId, id) {
  const section = config()[jobId === 'products' ? 'products' : jobId];
  const holder = section && section[id];
  return !!(holder && typeof holder === 'object' && holder.apiKey);
}

/**
 * Why a provider cannot do the job right now, or null when it can.
 *   'no key'    nothing saved here and nothing in .env
 *   'refused'   the provider refused exactly this key the last time it was asked
 *   'unknown'   not a provider for this job (only possible under a pin)
 */
function blocker(jobId, id) {
  const j = JOBS[jobId];
  if (!j.candidates.includes(id)) return { why: 'unknown' };
  if (!hasKey(jobId, id)) return { why: 'no key' };
  const c = providerKeys().view(id).check;
  if (c && c.ok === false) return { why: 'refused', status: c.status || null, at: c.at || null };
  return null;
}

/**
 * The job, walked in order: who would do it now, and why each one ahead of it
 * cannot. `chosen` is null when nobody can.
 *
 *   { job, order, from, chosen, usable: [ids], skipped: [{ id, why, status }] }
 */
function pick(jobId) {
  const o = order(jobId);
  const usable = [];
  const skipped = [];
  for (const id of o.order) {
    const b = blocker(jobId, id);
    if (b) skipped.push({ id, ...b });
    else usable.push(id);
  }
  return { job: jobId, ...o, chosen: usable[0] || null, usable, skipped };
}

/** The usable providers, in order. What a call site walks. */
function usable(jobId) {
  return pick(jobId).usable;
}

/** Did the provider refuse the key it holds, as of now? For a call site deciding to fall through. */
function refused(id) {
  try {
    const c = providerKeys().view(id).check;
    return !!(c && c.ok === false);
  } catch {
    return false;
  }
}

/** A refusal as skipped[] spells it, with the status the provider answered. */
function refusal(id) {
  let status = null;
  try {
    const c = providerKeys().view(id).check;
    status = (c && c.status) || null;
  } catch {
    /* status unknown */
  }
  return { id, why: 'refused', status };
}

/** "anthropic (no key), deepseek (refused: 401)" -- for an error nobody has to decode. */
function explain(skipped) {
  return (skipped || [])
    .map((s) => `${s.id} (${s.why}${s.status ? `: ${s.status}` : ''})`)
    .join(', ');
}

/**
 * The sentence a job fails with when nobody can do it. Names the list, where it
 * came from, and each provider's reason.
 */
function nobody(jobId, p = pick(jobId)) {
  const j = JOBS[jobId];
  const where = p.from === 'saved' ? 'the order saved in Settings -> Providers' : p.from === 'env' ? j.env : `the default (${j.env} unset)`;
  return `no provider can do "${jobId}": ${explain(p.skipped) || 'the list is empty'} -- from ${where}. ` +
    'Add a key in Settings -> Providers or the host .env, or change the order.';
}

/* ----------------------------------------------------------- the screen's view */

/** One job, as GET /api/settings/provider-order answers it. */
function view(jobId) {
  const j = job(jobId);
  const p = pick(jobId);
  const env = parseList(jobId, process.env[j.env]);
  return {
    job: jobId,
    name: j.name,
    env: j.env,
    order: p.order,
    from: p.from,
    savedAt: p.savedAt || null,
    envOrder: env,
    fallback: j.fallback.slice(),
    candidates: j.candidates.slice(),
    chosen: p.chosen,
    status: Object.fromEntries(j.candidates.map((id) => {
      const b = blocker(jobId, id);
      return [id, b ? b : { why: null }];
    })),
  };
}

function viewAll() {
  return Object.fromEntries(Object.keys(JOBS).map((id) => [id, view(id)]));
}

/* ------------------------------------------------------------------- writes */

/**
 * Save an order for a job. The list is the providers to TRY, in order: each a
 * provider this job has, each once, at least one. A provider left out is not
 * tried -- which is how an operator stops one job from calling a provider whose
 * key another job still uses.
 *
 * NOT refused for naming a provider with no key: the order is the operator's
 * preference, and a key added tomorrow should not need the order saved again.
 * The view says which ones are blocked and why, and the job skips them.
 */
async function save(jobId, body) {
  const j = job(jobId);
  const raw = body && body.order;
  if (!Array.isArray(raw) || !raw.length) {
    throw new SettingsError(400, `"order" must be a non-empty list of: ${j.candidates.join(', ')}.`);
  }
  const list = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!j.candidates.includes(id)) {
      throw new SettingsError(400, `"${v}" cannot do this job (expected: ${j.candidates.join(', ')}).`);
    }
    if (list.includes(id)) throw new SettingsError(400, `"${id}" is in the list twice.`);
    list.push(id);
  }
  return withLock('providerOrder', async () => {
    const doc = JSON.parse(JSON.stringify(savedDoc()));
    doc.version = 1;
    doc.jobs[jobId] = { order: list, savedAt: new Date().toISOString() };
    writeDoc(doc);
    logger().info({ job: jobId, order: list }, 'provider order saved');
    return view(jobId);
  });
}

/** Take away the saved order: the job's .env variable answers again, or the default. */
async function remove(jobId) {
  job(jobId);
  return withLock('providerOrder', async () => {
    const doc = JSON.parse(JSON.stringify(savedDoc()));
    if (doc.jobs[jobId]) {
      delete doc.jobs[jobId];
      writeDoc(doc);
      logger().info({ job: jobId }, 'provider order removed; .env answers');
    }
    return view(jobId);
  });
}

module.exports = {
  JOBS,
  parseList,
  order,
  pick,
  usable,
  refused,
  refusal,
  blocker,
  explain,
  nobody,
  hasKey,
  view,
  viewAll,
  save,
  remove,
  pin,
  _paths: { orderFile },
  _reset() {
    snapshot = null;
    pins.clear();
    warned.clear();
  },
};
