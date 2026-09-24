'use strict';

require('dotenv').config();

const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

// Decide which OCR/extraction provider to actually use. `auto` is resolved PER
// CALL, at the bottom of this file: it asks whether the reader has a key, and a
// key can now arrive from Settings -> Providers while the worker is running.
const visionProvider = (process.env.VISION_PROVIDER || 'anthropic').toLowerCase();
const ocrMode = (process.env.OCR_PROVIDER || 'auto').toLowerCase();

const config = {
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  // --- Multi-tenancy ---------------------------------------------------------
  // Every resource is scoped to an identity: a (tenantId, userId) pair. The
  // public, API-facing id of a resource is the COMPOSITE id
  // `<tenantId>:<userId>:<cacheId>` (see src/identity.js), so an id is
  // self-describing and storage is physically isolated per tenant/user.
  //
  // These defaults are the IMPLICIT identity used when a request/CLI omits one,
  // so a single-tenant deployment can pass nothing and everything lands under
  // `main/main`. Set them EMPTY (`DEFAULT_TENANT_ID=`) to require explicit
  // identity on every request — strict multi-tenant mode. Leaving the vars
  // unset entirely falls back to `main` for convenience (dev + tests).
  defaultTenantId: process.env.DEFAULT_TENANT_ID === undefined ? 'main' : process.env.DEFAULT_TENANT_ID,
  defaultUserId: process.env.DEFAULT_USER_ID === undefined ? 'main' : process.env.DEFAULT_USER_ID,

  port: int(process.env.PORT, 8080),
  // Used to build shareable links (Telegram replies, API responses).
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${int(process.env.PORT, 8080)}`).replace(/\/$/, ''),

  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  queueName: process.env.QUEUE_NAME || 'receipts',
  queueConcurrency: int(process.env.QUEUE_CONCURRENCY, 2),
  jobAttempts: int(process.env.JOB_ATTEMPTS, 3),

  // Base data dir. Per-tenant/user records live UNDER it at
  // `<dataDir>/<tenant>/<user>/{receipts,uploads,profileResults,products}` and
  // per-tenant profile definitions at `<dataDir>/<tenant>/receiptProfiles`
  // (resolved by src/identity.js, not by fixed paths here).
  dataDir,
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 15) * 1024 * 1024,

  // Pluggable persistence layer for the durable record stores (receipts, profile
  // definitions, profile results, product results, and the tenant registry).
  // The backend is chosen here — exactly like OCR_PROVIDER picks the OCR engine —
  // NOT per-record. `sqlite` (the default) stores documents in a single SQLite
  // table; `filesystem` (the original approach) writes scope-partitioned JSON
  // files under dataDir. `postgresql` is a planned drop-in (TODO) — not
  // implemented yet. NOTE: uploaded image blobs always stay on the filesystem
  // (under uploads/) regardless of backend; a separate blob-store abstraction
  // comes later.
  persistence: {
    backend: (process.env.PERSISTENCE || 'sqlite').toLowerCase(), // sqlite | filesystem | postgresql(TODO)
    sqlite: {
      // SQLite database file. Defaults under dataDir so it shares the data
      // volume; override with SQLITE_PATH (e.g. a dedicated mounted file).
      path: path.resolve(process.env.SQLITE_PATH || path.join(dataDir, 'receipt-enricher.db')),
    },
  },

  // Blob storage: bytes addressed by their own id, behind ONE seam that answers
  // with a URL (src/blobs). Its first tenant is the profile photograph, which is
  // required to survive a move to an object store without a page changing — so
  // nothing outside src/blobs ever builds a blob URL, it only stores the one it
  // was handed. `local` writes under <dataDir>/<tenant>/<user>/blobs/; an `s3`
  // backend is the planned drop-in and would change only what put() returns.
  //
  // NOTE: receipt image/payload uploads still live in uploads/ and do NOT go
  // through this yet (src/store.js writes them directly). They can move onto it
  // later; the seam was built for the case that has no record to derive a path
  // from at serving time.
  blobs: {
    backend: (process.env.BLOB_STORE || 'local').toLowerCase(), // local | s3(TODO)
    // A profile photograph, not a receipt. Deliberately much smaller than
    // maxUploadBytes: an avatar is rendered at 96px and a member has no reason
    // to send 15MB of one, while the bytes are served back on every page draw.
    maxBytes: int(process.env.AVATAR_MAX_KB, 4096) * 1024,
  },

  // Receipt Profiles: user-defined transformation rules applied to a parsed
  // receipt (see docs/RECEIPT-PROFILES.md). Definitions and results are durable
  // JSON, mirroring the receipt store. Limits guard the user-supplied rules
  // (regex compile + length caps) since the API is unauthenticated.
  receiptProfiles: {
    // profile definitions (per tenant) and results (per tenant/user) are stored
    // under dataDir via src/identity.js path helpers, not fixed paths.
    // Transformers are code modules shipped WITH the app (not user-uploaded), so
    // they live under src, not DATA_DIR. A profile references one by id.
    transformersDir: path.join(__dirname, 'receiptProfiles', 'transformers'),
    // Optional server-wide default profile (id or name) applied at upload time
    // when the request omits a profileId. Empty = no default.
    defaultProfileId: process.env.DEFAULT_PROFILE_ID || '',
  },

  // Retailer JSON ingest: structured receipt payloads posted straight from a
  // Unlisted share links: `GET /r/:token` renders ONE receipt to somebody with
  // no account, and the token is the whole of the credential. The row lives in
  // its own table (src/shares.js) rather than on the receipt, because a share
  // is a grant: revoking it must not be an edit to the receipt, and reading a
  // receipt must not carry a live capability in it.
  share: {
    // How long a link stays alive. A share is a grant handed to somebody
    // outside the system, and one that never expires is one nobody remembers
    // to revoke. 0 disables expiry (the row then lives until it is revoked).
    ttlDays: int(process.env.SHARE_TTL_DAYS, 30),
  },

  // retailer's own order API (see docs/RETAILER-INGEST.md). These skip OCR
  // entirely — a per-retailer ADAPTER normalizes the payload into the same
  // canonical { store, items, totals } the OCR path produces, so everything
  // downstream (profiles, products, views, queue) is shared. Adapters are code
  // modules shipped WITH the app (like transformers/resolvers), selected by the
  // retailer id in the URL, never by request-supplied code.
  retailers: {
    adaptersDir: path.join(__dirname, 'retailers', 'adapters'),
    // Enrichment (Tavily image/metadata lookup) default for JSON receipts.
    // OFF by default: a retailer payload already carries clean product names
    // and its own thumbnails, so the lookup mostly re-buys what we were given.
    // Per-upload override: `enrich=1` / `enrich=0`.
    enrichByDefault: bool(process.env.RETAILER_ENRICH_DEFAULT, false),
    // The payload is always written to uploads/<id>.json — the worker normalizes
    // it out-of-band, exactly as it OCRs a photo out-of-band. This flag decides
    // whether it is KEPT after processing: on (the default) a receipt can be
    // re-normalized when its adapter improves, without re-fetching from the
    // retailer. Retailer payloads carry personal data (member name, address,
    // phone, email, card last-4) that nothing downstream reads, so set 0 to
    // delete the payload once the receipt is done.
    storeRawPayload: bool(process.env.RETAILER_STORE_RAW_PAYLOAD, true),
    maxPayloadBytes: int(process.env.RETAILER_MAX_PAYLOAD_MB, 4) * 1024 * 1024,
    // Re-posting the same order id (a sync tool replaying its history) returns
    // the receipt already created instead of a duplicate. The index lives in
    // Redis, so an eviction degrades to today's behavior: a second record.
    dedupe: bool(process.env.RETAILER_DEDUPE, true),
    dedupeTtlSeconds: int(process.env.RETAILER_DEDUPE_TTL_SECONDS, 60 * 60 * 24 * 90),
  },

  // Local directory for Tesseract language data (eng.traineddata[.gz]). Used as
  // both the cache and the offline lang-path so first run needs no CDN download
  // — handy on networks that block/inspect the jsdelivr CDN. Override with
  // TESSDATA_PATH (e.g. a mounted volume in Docker).
  tessdataDir: path.resolve(process.env.TESSDATA_PATH || path.join(__dirname, '..', 'tessdata')),

  // Upper bound (ms) on a single Tesseract recognition. tesseract.js has no
  // built-in timeout: if language data can't be loaded it can hang forever
  // (e.g. a CDN-blocked download, or an empty/mounted tessdata dir). The OCR
  // module races the call against this so a stuck recognition fails *that job*
  // instead of stalling a worker slot indefinitely. Override with TESSERACT_TIMEOUT_MS.
  tesseractTimeoutMs: Number(process.env.TESSERACT_TIMEOUT_MS) || 120000,

  // Tesseract orientation handling. Before recognition the OCR module runs
  // Tesseract's OSD (orientation & script detection) to find the page rotation
  // (0/90/180/270) so a sideways or upside-down phone photo is corrected first.
  // Needs osd.traineddata in tessdataDir; if it's missing or OSD isn't confident
  // the module falls back to skew-only auto-rotation. Disable with TESSERACT_OSD=0.
  tesseractOsd: process.env.TESSERACT_OSD !== '0',
  // Minimum OSD confidence before a 90/180/270 rotation is trusted and applied.
  // Below this we leave orientation alone (a low-confidence reading on a noisy
  // photo can otherwise flip an already-upright image into garbage).
  tesseractOsdMinConfidence: Number(process.env.TESSERACT_OSD_MIN_CONFIDENCE) || 1.0,

  // JSON file mapping canonical store names to their aliases/substrings. The
  // parser uses it to normalize store names (e.g. "Costco Wholesale" -> "Costco")
  // across the vision and OCR paths. Override to ship your own store list.
  storeAliasesPath: path.resolve(
    process.env.STORE_ALIASES_PATH || path.join(__dirname, 'parse', 'store-aliases.json')
  ),

  // Extraction. The provider picks the OCR engine (like PERSISTENCE picks the
  // record backend), NOT a per-receipt choice:
  //   'vision'     — a multimodal LLM (Anthropic/OpenAI) returns structured JSON.
  //   'tesseract'  — offline, in-process Tesseract OCR (the lightweight default).
  //   anything else — a REST OCR backend (see `ocr.rest` below). The two
  //                   PaddleOCR sidecars ship as 'paddle' (PP-OCRv6 small) and
  //                   'paddle-vl' (PaddleOCR-VL 1.6); add more by registering a
  //                   URL under ocr.rest and setting OCR_PROVIDER to its name.
  // ocrProvider: 'vision' | 'tesseract' | 'paddle' | 'paddle-vl' | <rest backend>
  // -- defined below with the other values that are read per call.

  // Generic REST OCR backends. Each entry maps an OCR_PROVIDER value to a remote
  // HTTP OCR service that the worker calls (src/ocr/rest.js). The service takes
  // an image and returns transcribed text; the heuristic parser then turns that
  // text into line items (same path as Tesseract). This keeps heavy OCR engines
  // (e.g. PaddleOCR + its model blobs) OUT of the Node image — they run as their
  // own optional containers, selected at deploy time. The default URLs match the
  // compose service names; override per-provider with OCR_<NAME>_URL.
  ocr: {
    // Upper bound (ms) on a single REST OCR call. PaddleOCR-VL is ~120s/receipt,
    // so this is generous; override with OCR_REST_TIMEOUT_MS.
    restTimeoutMs: int(process.env.OCR_REST_TIMEOUT_MS, 600000),
    rest: {
      paddle: {
        url: process.env.OCR_PADDLE_URL || 'http://ocr-paddle:8090',
      },
      'paddle-vl': {
        url: process.env.OCR_PADDLE_VL_URL || 'http://ocr-paddle-vl:8090',
      },
    },
  },

  vision: {
    provider: visionProvider, // 'anthropic' | 'openai'
    anthropic: {
      // apiKey: read per call -- see the bottom of this file.
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      version: process.env.ANTHROPIC_VERSION || '2023-06-01',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    },
    openai: {
      // apiKey: read per call -- see the bottom of this file.
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
    },
  },

  // Product resolution: the final pipeline stage. Maps each cleaned line item
  // from a receipt PROFILE RESULT to product information (title, description,
  // substantiating web link) via a configurable backend *resolver* (an adapter).
  // The resolver is chosen by config — like OCR_PROVIDER picks the OCR engine —
  // NOT by a per-receipt record. The first resolver ('anthropic') calls a
  // low-end Anthropic model; a Tavily resolver can be added later by dropping a
  // module in resolvers/ and setting PRODUCT_RESOLVER=tavily.
  products: {
    enabled: bool(process.env.PRODUCTS_ENABLED, true),
    resolver: (process.env.PRODUCT_RESOLVER || 'anthropic').toLowerCase(),
    // Resolver modules ship WITH the app (code, not user data), like transformers.
    resolversDir: path.join(__dirname, 'products', 'resolvers'),
    // Durable product results mirror the receipt + profile-result stores: stored
    // per tenant/user under dataDir via src/identity.js (not a fixed path).
    // Cap on line items resolved per receipt (each item is one backend call).
    maxItems: int(process.env.PRODUCT_MAX_ITEMS, 100),
    // Max line-item lookups to run concurrently within one receipt. Each lookup
    // is an independent, network-bound backend call, so resolving them in a
    // bounded pool (instead of one-at-a-time) cuts wall-clock time roughly by
    // this factor. Keep it modest to stay under backend rate limits.
    concurrency: int(process.env.PRODUCT_CONCURRENCY, 5),
    // Shared, Redis-backed cache in front of the per-item resolver lookups
    // (src/products/productCache.js). Keyed by resolver + store + sku +
    // description, so the same product recurring across receipts/sessions skips
    // the backend call. Shared across all worker/server processes.
    cacheEnabled: bool(process.env.PRODUCT_CACHE_ENABLED, true),
    // Product identity is stable, so cache entries can live a while (30 days).
    cacheTtlSeconds: int(process.env.PRODUCT_CACHE_TTL_SECONDS, 60 * 60 * 24 * 30),
    // Size of the per-lookup event ring buffer feeding /products/monitor
    // (src/products/productEvents.js). 0 disables instrumentation entirely.
    eventsMax: int(process.env.PRODUCT_EVENTS_MAX, 500),
    // Resolve products by default whenever an upload applies a receipt profile
    // (opt out per-upload with resolveProducts=0). Products require a profile,
    // so an upload with no profile (and no DEFAULT_PROFILE_ID) still won't resolve.
    resolveOnUpload: bool(process.env.PRODUCT_RESOLVE_ON_UPLOAD, true),
    // Map each resolved product to a single, meaningful emoji (e.g. 🥚 for
    // Kirkland eggs) during the product-enrichment lookup, rendered in the
    // product view's image placeholder. ON by default but optional: when off,
    // the resolver neither asks for nor stores an emoji (no extra prompt, no
    // behavior change for existing data). It costs nothing extra — the emoji is
    // requested in the SAME backend call that identifies the product.
    emoji: bool(process.env.PRODUCT_EMOJI_ENABLED, true),
    anthropic: {
      // Reuses the same Anthropic credentials/endpoint as the vision OCR path.
      // apiKey: read per call -- see the bottom of this file.
      model: process.env.PRODUCT_ANTHROPIC_MODEL || 'claude-haiku-4-5',
      version: process.env.ANTHROPIC_VERSION || '2023-06-01',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      // Use Anthropic's server-side web_search/web_fetch tools so productUrl is a
      // real, grounded link (the retrieval happens on Anthropic's infra, which is
      // why it isn't blocked by the TLS-interception wall that breaks Tavily here).
      // If the configured model can't use the tools, set PRODUCT_ANTHROPIC_MODEL
      // to a model that can (e.g. claude-sonnet-4-6), or disable with =0.
      webSearch: bool(process.env.PRODUCT_ANTHROPIC_WEB_SEARCH, true),
    },
  },

  // Enrichment via Tavily
  enrich: {
    // enabled: read per call -- see the bottom of this file.
    maxItems: int(process.env.ENRICH_MAX_ITEMS, 40),
    cacheTtlSeconds: int(process.env.ENRICH_CACHE_TTL_SECONDS, 60 * 60 * 24 * 7),
    tavily: {
      // apiKey: read per call -- see the bottom of this file.
      baseUrl: process.env.TAVILY_BASE_URL || 'https://api.tavily.com',
      searchDepth: process.env.TAVILY_SEARCH_DEPTH || 'basic',
      maxResults: int(process.env.TAVILY_MAX_RESULTS, 3),
    },
  },

  telegram: {
    // enabled, token: read per call -- see the bottom of this file.
    // Where the Bot API lives. Overridable only so a test can stand one up.
    apiRoot: (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/$/, ''),
    // Where the bot uploads receipts. Inside compose this is the api service.
    apiUrl: (process.env.API_URL || `http://localhost:${int(process.env.PORT, 8080)}`).replace(/\/$/, ''),
    // Tenant the bot's uploads belong to (must be provisioned, unless it's the
    // server default). Empty = let the server use its default tenant. Each
    // Telegram user maps to a distinct userId (`tg_<telegram-user-id>`), so a
    // tenant's Telegram users are isolated from one another.
    tenantId: process.env.TELEGRAM_TENANT_ID || '',
  },
};

// --- Values read PER CALL ------------------------------------------------------
//
// Every provider key below can be saved from Settings -> Providers, and a saved
// key wins over .env (src/settings/providerKeys.js). So none of them can be a
// value captured at boot: a key saved at noon has to be the key the 12:01
// receipt is read with, in the worker and the bot as much as in the api -- or
// the reach line on the operator's card ("used from the next receipt read") is
// false.
//
// Each is a getter over the store, so every existing `config.vision.anthropic.
// apiKey` and every `resolver.ready(config)` became per call without changing a
// line at the call site. So did the three answers that were DERIVED from a key
// at boot: `ocrProvider` under `auto`, `enrich.enabled`, `telegram.enabled`.
//
// ASSIGNING ONE PINS IT, for this process. That is what the suite does
// (`config.vision.anthropic.apiKey = 'sk-ant-test'`), and it is nothing a running
// service does.
function live(target, prop, read) {
  let pinned;
  Object.defineProperty(target, prop, {
    enumerable: true,
    configurable: true,
    get: () => (pinned !== undefined ? pinned : read()),
    set: (v) => {
      pinned = v;
    },
  });
}

// Lazy, because the store requires this file.
const keyOf = (pk, fk) => () => require('./settings/providerKeys').value(pk, fk);

live(config.vision.anthropic, 'apiKey', keyOf('anthropic', 'apiKey'));
live(config.vision.openai, 'apiKey', keyOf('openai', 'apiKey'));
live(config.products.anthropic, 'apiKey', keyOf('anthropic', 'apiKey'));
live(config.enrich.tavily, 'apiKey', keyOf('tavily', 'apiKey'));
live(config.telegram, 'token', keyOf('telegram', 'botToken'));

// Derived from the keys, so derived per call too. ENRICH_ENABLED set explicitly
// is the operator's answer and still wins; unset, it follows whether there is a
// Tavily key -- which is what "Without it: no line is enriched" on the card says.
live(config.enrich, 'enabled', () => bool(process.env.ENRICH_ENABLED, !!config.enrich.tavily.apiKey));
live(config.telegram, 'enabled', () => !!config.telegram.token);
live(config, 'ocrProvider', () => {
  if (ocrMode !== 'auto') return ocrMode;
  const reader = config.vision.provider === 'openai' ? config.vision.openai : config.vision.anthropic;
  return reader.apiKey ? 'vision' : 'tesseract';
});

module.exports = config;
