'use strict';

// Test harness helpers — built on Node built-ins only, so the suite needs no
// test framework, no real Redis, and no network. Each `node --test` file runs
// in its own process, so mutating process.env / require.cache here is isolated.

const fs = require('fs');
const os = require('os');
const path = require('path');

// WHO DOES EACH JOB IS NOT THE HOST'S TO DECIDE HERE. src/config.js loads the
// host's .env, and the three provider orders in it (src/settings/providerOrder.js)
// change which resolver, reader and lookup the suite exercises -- an operator
// setting PRODUCT_RESOLVER=deepseek turned a dozen Anthropic-shaped tests red.
// dotenv never overrides a variable that is already set, so setting these to
// empty BEFORE config loads leaves each job on its default; a test that wants
// another order pins it (`config.products.resolver = 'deepseek'`).
for (const v of ['VISION_PROVIDER', 'ENRICH_PROVIDER', 'PRODUCT_RESOLVER']) {
  if (process.env[v] === undefined) process.env[v] = '';
}

/**
 * Point DATA_DIR at a throwaway temp directory. Must be called BEFORE the
 * first `require('../src/config')` / `require('../src/store')` in a test file,
 * because config reads DATA_DIR at load time.
 * @returns {{ dir: string, cleanup: () => void }}
 */
function useTempDataDir(label = 'receipt-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  process.env.DATA_DIR = dir;
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Point PERSISTENCE at the sqlite backend with a throwaway temp DB file. Must be
 * called BEFORE the first `require('../src/config')` (config reads the env at
 * load time). Returns the db path + a cleanup that removes the file and its
 * WAL/SHM siblings.
 * @returns {{ path: string, cleanup: () => void }}
 */
function useTempSqlite(label = 'receipt-sqlite') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const dbPath = path.join(dir, 'test.db');
  process.env.PERSISTENCE = 'sqlite';
  process.env.SQLITE_PATH = dbPath;
  return {
    path: dbPath,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * Inject an in-memory fake of src/redis.js into the require cache so modules
 * that `require('../redis')` (enrich, queue, server) get a working `cache()`
 * with no real Redis. Call BEFORE requiring those modules.
 * @returns {{ store: Map<string, string>, calls: object }}
 */
function installFakeRedis() {
  const store = new Map();
  const calls = { get: 0, set: 0, ping: 0, lpush: 0, lrange: 0, ltrim: 0, incr: 0, del: 0, scan: 0, ttl: 0, sadd: 0, smembers: 0, sismember: 0, srem: 0 };
  const client = {
    async get(key) {
      calls.get += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value /* , 'EX', ttl */) {
      calls.set += 1;
      store.set(key, value);
      return 'OK';
    },
    async ping() {
      calls.ping += 1;
      return 'PONG';
    },
    // --- minimal list + counter ops (used by productEvents) ---
    async lpush(key, ...values) {
      calls.lpush += 1;
      const arr = store.get(key) || [];
      arr.unshift(...values); // newest at index 0, like Redis LPUSH
      store.set(key, arr);
      return arr.length;
    },
    async lrange(key, start, stop) {
      calls.lrange += 1;
      const arr = store.get(key) || [];
      const end = stop === -1 ? arr.length : stop + 1;
      return arr.slice(start, end);
    },
    async ltrim(key, start, stop) {
      calls.ltrim += 1;
      const arr = store.get(key) || [];
      const end = stop === -1 ? arr.length : stop + 1;
      store.set(key, arr.slice(start, end));
      return 'OK';
    },
    async incr(key) {
      calls.incr += 1;
      const n = (parseInt(store.get(key), 10) || 0) + 1;
      store.set(key, String(n));
      return n;
    },
    async del(key) {
      calls.del += 1;
      const had = store.delete(key);
      return had ? 1 : 0;
    },
    // Single-pass SCAN: ignores the cursor and returns all matching keys with a
    // terminal '0' cursor. Honors a MATCH glob (only '*' is supported, which is
    // all the app uses). Enough for productCache export/import tests.
    async scan(cursor, ...args) {
      calls.scan += 1;
      let match = '*';
      for (let i = 0; i < args.length; i += 1) {
        if (String(args[i]).toUpperCase() === 'MATCH') match = String(args[i + 1]);
      }
      const re = new RegExp('^' + match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const keys = [...store.keys()].filter((k) => re.test(k));
      return ['0', keys];
    },
    // No TTL tracking in the fake; report -1 (exists, no expiry) / -2 (missing).
    async ttl(key) {
      calls.ttl += 1;
      return store.has(key) ? -1 : -2;
    },
    // --- minimal SET ops (used by the tenant registry, src/tenants.js) ---
    async sadd(key, ...members) {
      calls.sadd += 1;
      const set = store.get(key) instanceof Set ? store.get(key) : new Set();
      const before = set.size;
      for (const m of members) set.add(String(m));
      store.set(key, set);
      return set.size - before;
    },
    async smembers(key) {
      calls.smembers += 1;
      const set = store.get(key);
      return set instanceof Set ? [...set] : [];
    },
    async sismember(key, member) {
      calls.sismember += 1;
      const set = store.get(key);
      return set instanceof Set && set.has(String(member)) ? 1 : 0;
    },
    async srem(key, ...members) {
      calls.srem += 1;
      const set = store.get(key);
      if (!(set instanceof Set)) return 0;
      let n = 0;
      for (const m of members) if (set.delete(String(m))) n += 1;
      return n;
    },
  };

  const redisPath = require.resolve('../../src/redis');
  require.cache[redisPath] = {
    id: redisPath,
    filename: redisPath,
    loaded: true,
    exports: {
      createConnection: () => client,
      cache: () => client,
    },
  };
  return { store, calls };
}

/**
 * Replace global.fetch with a handler for the duration of a test.
 * The handler receives (url, options) and returns the value `fetch` resolves
 * to (typically a fake Response — see jsonResponse / textResponse below).
 * @returns {() => void} restore function
 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls);
  };
  const restore = () => {
    globalThis.fetch = original;
  };
  restore.calls = calls;
  return restore;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function textResponse(text, { ok = false, status = 500 } = {}) {
  return {
    ok,
    status,
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  };
}

module.exports = {
  useTempDataDir,
  useTempSqlite,
  installFakeRedis,
  stubFetch,
  jsonResponse,
  textResponse,
};
