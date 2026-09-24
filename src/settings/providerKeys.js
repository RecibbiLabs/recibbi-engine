'use strict';

// The deployment's provider keys: Settings -> Providers, operator only.
// Designed in recibbi-ux-design-atlas (docs/settings.md § 3b, docs/proposals.md
// § 9) before any of it was built here.
//
// Until this file every key below was an environment variable read once at
// boot, so changing one meant editing a file on the host and restarting three
// containers. Four things had to exist for the screen to be true:
//
//   1. A KEY STORE THAT WINS OVER THE ENVIRONMENT. A value saved here overrides
//      .env; removing it falls back to .env; a value that came from .env cannot
//      be removed through the API, because a web request cannot edit a file on
//      the host. Encrypted at rest -- see keyMaterial().
//
//   2. KEYS READ PER CALL, NOT PER BOOT. `value()` is what src/config.js's key
//      fields call on every read, so a key saved at noon is the key the 12:01
//      receipt is read with -- in the worker and the bot as much as in this
//      process. That is why the store is a FILE on the data volume and not a
//      document in src/persistence: it has to be read synchronously, from inside
//      a getter, by three processes, and a stat per read is what tells each of
//      them the file changed. The decrypted snapshot is cached against the
//      file's mtime and size, so a read that finds nothing new costs one stat.
//
//   3. THE TAIL OF A SECRET, AND NEVER MORE. `view()` answers with a secret's
//      last four characters and where it came from. The value itself never
//      leaves this service -- not to recibbi-ux-main, and therefore not into a
//      page, a screenshot of one, or a browser's form history.
//
//   4. A CHECK AGAINST THE PROVIDER ON SAVE, AND THE LAST ANSWER IT GAVE. A key
//      the provider refuses is not stored and the one in use is untouched
//      (src/settings/providerProbe.js). The last answer is recorded on every real
//      call too (`observe()`), because a key can be revoked in the provider's own
//      dashboard without anybody here touching it.
//
// PER DEPLOYMENT, NOT PER MEMBER. There is one Anthropic key and every member's
// receipts are read with it. This service has no idea who is asking -- it never
// has -- so "operator only" is recibbi-ux-main's rule, enforced in its route; see
// src/routes/settings.js for why that is the right place and not a gap here.
//
//   <dataDir>/.registry/provider-keys.json          the saved values, encrypted
//   <dataDir>/.registry/provider-keys.secret        the key they are encrypted
//                                                   with, unless PROVIDER_KEYS_SECRET
//   <dataDir>/.registry/provider-checks/<key>.json  the last answer, per provider
//
// `.registry` is the directory the tenant registry and the share table already
// use, and its leading dot keeps it from ever colliding with a tenant's own.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock } = require('./lock');
const { SettingsError } = require('./validate');

// Required lazily: src/config.js calls value() from inside its getters, so a
// top-level require of config here would be a cycle at load time.
const config = () => require('../config');
const logger = () => require('../logger');

/**
 * The providers THIS service holds a key for, and the variable each field is
 * spelled as in .env. The atlas's catalogue.js -> PROVIDERS lists these four
 * with `holder: 'engine'`; Clerk and Auth0 are recibbi-ux-main's own, and
 * DeepSeek is nobody's -- nothing in either service calls it, so a key saved for
 * it would be read by nothing. It is refused rather than stored.
 */
const PROVIDERS = {
  anthropic: { name: 'Anthropic', fields: { apiKey: { env: 'ANTHROPIC_API_KEY', secret: true } } },
  openai: { name: 'OpenAI', fields: { apiKey: { env: 'OPENAI_API_KEY', secret: true } } },
  tavily: { name: 'Tavily', fields: { apiKey: { env: 'TAVILY_API_KEY', secret: true } } },
  telegram: { name: 'Telegram', fields: { botToken: { env: 'TELEGRAM_BOT_TOKEN', secret: true } } },
};

// A pasted key is one token. The bounds stop a paste of the wrong thing -- a
// sentence, a whole .env -- not a real key of an unusual shape.
const MIN_LEN = 8;
const MAX_LEN = 512;

// How long an identical answer is not re-recorded. Every product line is a call,
// five at a time; writing the same "answered" on each would be a file write per
// line for a fact that did not change. A DIFFERENT answer is always written.
const OBSERVE_EVERY_MS = 60 * 1000;

function registryDir() {
  return path.join(config().dataDir, '.registry');
}
function keysFile() {
  return path.join(registryDir(), 'provider-keys.json');
}
function secretFile() {
  return path.join(registryDir(), 'provider-keys.secret');
}
function checkFile(key) {
  return path.join(registryDir(), 'provider-checks', `${key}.json`);
}

function provider(key) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? PROVIDERS[key] : null;
}

function known(key) {
  const p = provider(key);
  if (!p) throw new SettingsError(404, `Nothing in Recibbi's engine reads a "${key}" key.`);
  return p;
}

function tail(v) {
  return v ? String(v).slice(-4) : null;
}

/** A short, one-way name for a key: which key an answer was about, without the key. */
function fingerprint(v) {
  return v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 16) : null;
}

function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}

// --- encryption at rest --------------------------------------------------------

/**
 * The 32 bytes the saved values are sealed with.
 *
 * PROVIDER_KEYS_SECRET when the operator sets one -- the strong form, because
 * then the data volume alone does not open the store. Otherwise a random key
 * minted into the registry directory on the first save, mode 0600. That second
 * form is honest about what it is: it keeps the keys out of a copy of the JSON
 * file, a log line or a backup of the database, and it does NOT protect against
 * somebody holding the whole volume. docs/SETTINGS.md § 13 says so too.
 *
 * `create` is true only on a save. A reader that finds no key file has nothing
 * sealed to open, and must not mint one: three processes racing to create it
 * would seal values two different ways.
 */
function keyMaterial({ create = false } = {}) {
  const env = process.env.PROVIDER_KEYS_SECRET;
  if (env) return crypto.createHash('sha256').update(env).digest();
  const file = secretFile();
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } catch (err) {
    if (err.code !== 'ENOENT' || !create) return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // `wx`: if another process minted it a moment ago, read theirs instead.
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

function seal(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function open(sealed, key) {
  const [v, iv, tag, ct] = String(sealed).split(':');
  if (v !== 'v1' || !key) throw new Error('unreadable');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// --- the saved values ----------------------------------------------------------

let snapshot = null; // { stamp, doc, values }

function readDoc() {
  try {
    const doc = JSON.parse(fs.readFileSync(keysFile(), 'utf8'));
    return doc && typeof doc === 'object' && doc.providers ? doc : { version: 1, providers: {} };
  } catch (err) {
    if (err.code !== 'ENOENT') logger().error({ err: err.message }, 'provider keys: store unreadable');
    return { version: 1, providers: {} };
  }
}

/**
 * The saved values, decrypted, as { provider: { field: value } }.
 *
 * ONE STAT PER READ when nothing changed. The file is replaced by rename on every
 * write, so a new mtime or size is a new file, and a worker that has been running
 * since yesterday picks up a key saved a second ago on its next call.
 *
 * A value that will not open -- PROVIDER_KEYS_SECRET changed, the key file was
 * lost -- is logged loudly and treated as NOT SAVED, so the .env value (if any)
 * answers and `view()` says so. Serving it as saved would have the page name a
 * key that is not the one in use.
 */
function saved() {
  let st;
  try {
    st = fs.statSync(keysFile());
  } catch {
    snapshot = null;
    return { doc: { version: 1, providers: {} }, values: {} };
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  if (snapshot && snapshot.stamp === stamp) return snapshot;

  const doc = readDoc();
  const key = keyMaterial();
  const values = {};
  for (const [pk, fields] of Object.entries(doc.providers)) {
    for (const [fk, row] of Object.entries(fields || {})) {
      if (!row || !row.sealed) continue;
      try {
        (values[pk] = values[pk] || {})[fk] = open(row.sealed, key);
      } catch {
        logger().error(
          { provider: pk, field: fk },
          'provider keys: a saved value will not decrypt (PROVIDER_KEYS_SECRET changed, or the key file is gone) -- ignoring it'
        );
      }
    }
  }
  snapshot = { stamp, doc, values };
  return snapshot;
}

function envValue(pk, fk) {
  const f = PROVIDERS[pk] && PROVIDERS[pk].fields[fk];
  return (f && process.env[f.env]) || '';
}

/**
 * The key in use for one field, RIGHT NOW: what was saved here, else .env, else
 * ''. This is the function src/config.js's key fields call on every read.
 */
function value(pk, fk) {
  const s = saved().values[pk];
  return (s && s[fk]) || envValue(pk, fk);
}

/** Every field of one provider, as value() answers it. */
function values(pk) {
  const out = {};
  for (const fk of Object.keys(known(pk).fields)) out[fk] = value(pk, fk);
  return out;
}

// --- the last answer -----------------------------------------------------------

function readCheck(pk) {
  try {
    return JSON.parse(fs.readFileSync(checkFile(pk), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The last answer the provider gave, BUT ONLY ABOUT THE KEY IN USE.
 *
 * Each record carries the fingerprint of the key it was about. An answer about
 * a key that has since been replaced -- here, or by an edit to .env and a
 * restart -- is not an answer about this one, and showing it would paint a new
 * key red for somebody else's mistake. So it is dropped, and the card says the
 * key has not been called yet, which is the truth.
 */
function checkFor(pk) {
  const c = readCheck(pk);
  if (!c) return null;
  const now = fingerprint(Object.values(values(pk)).join('\u0000'));
  if (c.fp !== now) return null;
  const out = { at: c.at, ok: !!c.ok };
  if (c.status) out.status = c.status;
  if (c.said) out.said = c.said;
  return out;
}

const lastWritten = new Map(); // pk -> { fp, ok, status, t }

function writeCheck(pk, fp, result) {
  const row = { at: new Date().toISOString(), ok: !!result.ok, fp };
  if (result.status) row.status = result.status;
  if (result.said) row.said = String(result.said).slice(0, 120);
  writeAtomic(checkFile(pk), JSON.stringify(row), 0o600);
  lastWritten.set(pk, { fp, ok: row.ok, status: row.status || null, t: Date.now() });
}

/**
 * Record what a provider said to a REAL call, made with `used`.
 *
 * Only two kinds of answer are about the key: a 2xx (it was accepted) and a
 * 401/403 (it was refused). A 429, a 500 or a timeout is a fact about the
 * provider's afternoon, and recording it would paint a good key red.
 *
 * Best effort by construction. It runs beside a member's receipt being read,
 * and must never be the reason that fails.
 */
function observe(pk, used, status, said) {
  try {
    if (!provider(pk) || !used) return;
    let result;
    if (status >= 200 && status < 300) result = { ok: true };
    else if (status === 401 || status === 403) result = { ok: false, status, said };
    else return;

    // The fingerprint is of the value(s) the CALL used, joined as checkFor()
    // joins the ones in use -- a one-field provider's is just its key.
    const fp = fingerprint(used);
    const last = lastWritten.get(pk);
    if (last && last.fp === fp && last.ok === result.ok && last.status === (result.status || null) &&
        Date.now() - last.t < OBSERVE_EVERY_MS) return;
    writeCheck(pk, fp, result);
    if (!result.ok) logger().warn({ provider: pk, status }, 'provider refused its key');
  } catch (err) {
    logger().warn({ err: err.message, provider: pk }, 'provider check not recorded');
  }
}

// --- what the page is allowed to know ------------------------------------------

/**
 * One provider, as GET /api/settings/providers answers it. The shape is the
 * atlas's fixtures.js -> providerKeys(), field for field:
 *
 *   from      'saved' | 'env' | null
 *   tail      a secret's last four characters, and never more of it
 *   savedAt   when it was saved here
 *   envTail   what .env holds UNDER a saved value -- so Remove can say, before
 *             it is pressed, whether it falls back to a key or to nothing
 */
function view(pk) {
  const p = known(pk);
  const s = saved();
  const rows = (s.doc.providers[pk] || {});
  const fields = {};
  for (const [fk, f] of Object.entries(p.fields)) {
    const env = envValue(pk, fk);
    const mine = s.values[pk] && s.values[pk][fk];
    let out;
    if (mine) {
      out = { from: 'saved', savedAt: (rows[fk] && rows[fk].savedAt) || null };
      if (f.secret) out.tail = tail(mine);
      else out.value = mine;
      if (env) {
        if (f.secret) out.envTail = tail(env);
        else out.envValue = env;
      }
    } else if (env) {
      out = f.secret ? { from: 'env', tail: tail(env) } : { from: 'env', value: env };
    } else {
      out = { from: null };
    }
    fields[fk] = out;
  }
  return { fields, check: checkFor(pk) };
}

/** Every provider this service holds, keyed as the atlas's catalogue keys them. */
function viewAll() {
  const out = {};
  for (const pk of Object.keys(PROVIDERS)) out[pk] = view(pk);
  return out;
}

// --- writes --------------------------------------------------------------------

/**
 * Only what CHANGED, validated. A blank field means KEEP -- the page never
 * received the secret, so it has nothing to send back and cannot send a whole
 * record. A field this provider does not have is refused rather than dropped:
 * a 200 over a write that stored nothing is a screen agreeing with itself and
 * nobody else.
 */
function readPatch(pk, patch) {
  const p = known(pk);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SettingsError(400, 'a provider key write is an object of fields');
  }
  const out = {};
  for (const [fk, raw] of Object.entries(patch)) {
    if (!p.fields[fk]) {
      throw new SettingsError(400, `${p.name} has no "${fk}" (expected: ${Object.keys(p.fields).join(' | ')})`);
    }
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      throw new SettingsError(400, `"${fk}" must be a string`);
    }
    const v = (raw || '').trim();
    if (!v) continue;
    if (v.length < MIN_LEN || v.length > MAX_LEN || /\s/.test(v)) {
      throw new SettingsError(400, `That does not look like a ${p.name} key: one unbroken string, ` +
        `${MIN_LEN} to ${MAX_LEN} characters.`);
    }
    out[fk] = v;
  }
  if (!Object.keys(out).length) throw new SettingsError(400, 'Every field was blank, so there was nothing to save.');
  return out;
}

/**
 * Save a key -- AFTER the provider has accepted it.
 *
 * The probe runs with the values the provider WOULD be called with, the patch
 * over whatever is in use, and a refusal throws before anything is written: the
 * key in use keeps working. Replacing a working Anthropic key with a mistyped one
 * would stop every member's receipts being read, and the first person to find
 * out would be one of them.
 *
 * `probe` is injectable so the store can be tested without a network; the route
 * passes the real one.
 */
async function save(pk, patch, { probe } = {}) {
  const p = known(pk);
  const changes = readPatch(pk, patch);
  const check = probe || require('./providerProbe').probe;

  return withLock('providerKeys', async () => {
    const candidate = { ...values(pk), ...changes };
    const answer = await check(pk, candidate);
    if (!answer.ok) {
      const why = answer.status
        ? `it answered ${answer.status}${answer.said ? ` ${answer.said}` : ''}`
        : answer.said || 'it could not be reached';
      throw new SettingsError(answer.refused ? 422 : 502,
        answer.refused ? `${p.name} did not accept it: ${why}.`
                       : `${p.name} could not check it (${why}), so nothing was stored.`);
    }

    const key = keyMaterial({ create: true });
    const doc = readDoc();
    const rows = { ...(doc.providers[pk] || {}) };
    const at = new Date().toISOString();
    for (const [fk, v] of Object.entries(changes)) rows[fk] = { sealed: seal(v, key), savedAt: at };
    doc.providers[pk] = rows;
    doc.version = 1;
    writeAtomic(keysFile(), JSON.stringify(doc, null, 2));
    snapshot = null;

    // The provider has just answered for exactly this key, which is the most
    // recent fact there is about it.
    writeCheck(pk, fingerprint(Object.values(candidate).join('\u0000')), { ok: true });
    logger().info({ provider: pk, fields: Object.keys(changes) }, 'provider key saved');
    return view(pk);
  });
}

/**
 * Take away what was saved HERE. A value from .env is untouched and cannot be
 * touched: a web request cannot edit a file on the host, which is why the page
 * offers no Remove for one.
 *
 * The check goes too. The key in use has just changed and nothing has called the
 * provider with this one yet, so there is no answer to show -- not an old one.
 * (checkFor() would drop it anyway, by fingerprint; deleting it says so.)
 */
async function remove(pk) {
  known(pk);
  return withLock('providerKeys', async () => {
    const doc = readDoc();
    if (doc.providers[pk]) {
      delete doc.providers[pk];
      writeAtomic(keysFile(), JSON.stringify(doc, null, 2));
      snapshot = null;
      try {
        fs.unlinkSync(checkFile(pk));
      } catch {
        /* nothing recorded */
      }
      lastWritten.delete(pk);
      logger().info({ provider: pk }, 'provider key removed');
    }
    return view(pk);
  });
}

module.exports = {
  PROVIDERS,
  provider,
  value,
  values,
  view,
  viewAll,
  save,
  remove,
  observe,
  fingerprint,
  // exported for tests
  _paths: { keysFile, secretFile, checkFile },
  _reset() {
    snapshot = null;
    lastWritten.clear();
  },
};
