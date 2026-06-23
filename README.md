# Recibbi Labs Receipt Insights

Turn a phone photo of a grocery receipt into a structured, enriched breakdown.

You send a photo (Costco, Sprouts, Publix, etc.). The service extracts the line
items and prices, looks up a product image and a bit of metadata for each item
via **Tavily**, and gives you a shareable link to the full breakdown. Two ways
in: a **Telegram bot** and a **CLI**. Everything runs in containers and works
with **Docker or Podman**.

---

## How it works

```
                 ┌──────────────┐         ┌──────────────────────────────┐
   Telegram ───► │              │         │            worker            │
                 │   api (REST  │  BullMQ  │  OCR/vision → parse → Tavily │
   CLI / curl ─► │   + web view)│ ───────► │  enrich → summarize          │
                 │              │  (Redis) │                              │
                 └──────┬───────┘         └───────────────┬──────────────┘
                        │  durable receipt records (JSON + image)         │
                        └──────────────── shared volume ──────────────────┘
```

The flow:

1. **Ingest** — a receipt image arrives via the REST API. The Telegram bot is
   just another REST client: it downloads the photo and POSTs it to the same
   endpoint, so there is a single ingestion path.
2. **Queue** — the API saves the image + a record to disk, then enqueues a tiny
   job (`{ receiptId }`) on a **Redis-backed BullMQ queue**. The API responds
   `202 Accepted` immediately. Jobs survive restarts and retry with backoff, so
   incoming receipts are not dropped under load or transient failures.
3. **Process** (worker):
   - **Extract** the receipt — a vision model (Anthropic or OpenAI) returns
     structured line items directly, or Tesseract OCR produces raw text that a
     heuristic parser turns into items.
   - **Parse** into a canonical shape: `{ store, items[], totals }`.
   - **Enrich** each item through Tavily (image + title + snippet), cached in
     Redis so repeat items don't re-spend API credits.
   - **Summarize** and mark the record `done`.
4. **View** — open the link. The web page updates as you refresh; the same data
   is available as JSON.

**Graceful degradation:** with no API keys at all, it still runs — it falls back
to offline Tesseract OCR and simply skips enrichment. Add a Tavily key to get
images; add a vision key for much better item extraction.

**Receipt profiles (optional):** a *profile* runs a code **transformer** that
canonicalizes a parsed receipt — normalizing store names, dates, and item
descriptions — and stores the result separately with an auto-derived change log
(the original record is never modified). Apply one synchronously to an
already-processed receipt, asynchronously (`?async=1`), or pass a `profileId` at
upload time to run it automatically **after** OCR via a BullMQ flow
(`process-receipt` child → `applyProfile` parent). Two transformers ship today:
`usGrocery` (vision-clean receipts) and `tesseractGroceryUs` (repairs noisy
Tesseract output). See [`docs/RECEIPT-PROFILES.md`](docs/RECEIPT-PROFILES.md) and
the API reference in [`docs/API.md`](docs/API.md).

**Products (final stage):** once a profile result exists, the **product
resolver** maps each cleaned line item to real product information — a title, a
description, and the top web link that substantiates it. The backend is a
configurable **resolver/adapter** picked by `PRODUCT_RESOLVER` (like
`OCR_PROVIDER` picks the OCR engine); the shipped `anthropic` resolver calls a
low-end model (`claude-haiku-4-5`) and grounds the link with Anthropic's
server-side web search. It runs by default after a profile is applied — so a
single upload goes OCR → profile → products via a 3-level BullMQ flow
(`process-receipt` → `applyProfile` → `resolveProducts`) — and is also runnable
on demand. See [Products in `docs/API.md`](docs/API.md#products).

---

## Components

| Service  | What it is                          | Toolchain        |
|----------|-------------------------------------|------------------|
| `api`    | REST API + server-rendered web view | Node + Express   |
| `worker` | Pipeline (extract → enrich)         | Node + BullMQ    |
| `redis`  | Queue + enrichment cache            | Redis 7          |
| `bot`    | Telegram ingestion (optional)       | Node + Telegraf  |
| `cli`    | Lightweight client                  | **bash + curl**  |

The CLI is deliberately not Node — it's a single bash script that calls the REST
API with `curl` (and uses `jq` for pretty output if you have it). Nothing to
install.

---

## Prerequisites

- Docker + Docker Compose **or** Podman. With Podman, prefer **`podman-compose`**
  (the Python wrapper). Plain `podman compose` shells out to an external
  `docker-compose` provider that can't reach the rootless Podman socket in some
  setups (it fails with *"Cannot connect to the Docker daemon"*); `podman-compose`
  drives the Podman CLI directly and is the tested path here.
- That's it for running. For local (non-container) development you'd also want
  Node ≥ 18.

---

## Quick start

```bash
# 1. Configure (works fine with everything blank — see "Modes" below)
cp .env.example .env
#   then edit .env to add keys you have (TAVILY_API_KEY, ANTHROPIC_API_KEY, ...)

# 2. Build and start (pick your runtime). --no-cache forces a clean image
#    rebuild every run, so reused commands never serve stale layers.
docker compose build --no-cache && docker compose up -d
#   — or, with Podman (use the hyphenated wrapper; -p pins the project name,
#     see "Podman notes" for why) —
podman-compose -p receipt-enricher up --build --no-cache -d

# 3. Make the CLI handy
chmod +x cli/receipts
export PATH="$PWD/cli:$PATH"      # or: alias receipts="$PWD/cli/receipts"

# 4. Check health, then upload a receipt photo
receipts health
receipts upload ~/Pictures/costco-receipt.jpg --wait

# 5. (optional) Upload and apply a receipt profile after OCR.
#    "usGrocery1" is seeded on first boot; it canonicalizes the store/date and
#    folds per-item discounts into the discounted line.
receipts upload ~/Pictures/costco-receipt.jpg --wait --profile usGrocery1
```

`upload --wait` blocks until processing finishes and prints the record plus a
`view:` URL. Open it in a browser, or just visit <http://localhost:8080> to see
all receipts.

With `--profile`, the worker runs OCR **then** applies the profile, and the
command also prints a `profile view:` URL — the HTML receipt with the profile
applied (discounts folded into their line items). Run `receipts list` or visit
<http://localhost:8080> to confirm the receipt was processed.

---

## Modes (what works with which keys)

| You have…                         | Extraction        | Enrichment        |
|-----------------------------------|-------------------|-------------------|
| nothing                           | Tesseract OCR     | skipped           |
| `TAVILY_API_KEY`                  | Tesseract OCR     | ✅ images/metadata |
| `ANTHROPIC_API_KEY` (or OpenAI)   | ✅ vision model    | skipped           |
| both                              | ✅ vision model    | ✅ images/metadata |

For real receipts, a **vision model is strongly recommended** — raw Tesseract on
a crumpled phone photo is hit-or-miss, while a vision model reads the layout and
returns clean items. The default vision model is `claude-sonnet-4-6`; override
with `ANTHROPIC_MODEL`, or set `VISION_PROVIDER=openai` with `OPENAI_API_KEY`.

> Tesseract note: the English language data ships in the image
> (`tessdata/eng.traineddata`), so it runs fully offline — no CDN download. It
> can't read HEIC (convert iPhone photos to JPEG/PNG) and needs an upright,
> reasonably sharp image — a sideways photo reads as noise.

---

## Using it

### CLI

```bash
receipts upload <image> [--wait] [--profile <id|name>] [--tenant <t>] [--user <u>]
                                   # upload a photo; --wait blocks for results,
                                   # --profile applies a receipt profile after OCR,
                                   # --tenant/--user set the owning identity
receipts status <id>               # full JSON record (id is the composite id)
receipts list                      # recent receipts (for TENANT_ID/USER_ID)
receipts wait <id>                 # poll until done/failed
receipts view <id>                 # print + open the web view
receipts tenant create <id>        # provision a tenant account
receipts tenant list               # list provisioned tenants
receipts health                    # API + Redis status
```

Point it at a remote host with `API_URL`, and set the identity with
`TENANT_ID`/`USER_ID` (or `--tenant`/`--user` on `upload`):

```bash
API_URL=http://my-server:8080 receipts upload receipt.jpg --wait
# Multi-tenant: provision a tenant once, then upload under it.
API_URL=http://my-server:8080 receipts tenant create acme
TENANT_ID=acme USER_ID=alice API_URL=http://my-server:8080 receipts upload receipt.jpg --wait
```

See [Multi-tenancy](#multi-tenancy) for the identity model.

A companion CLI, **`products`**, manages the product layer — notably the shared
product cache (snapshot it to a file and restore it, e.g. to seed a known cache
before an acceptance run so SKU lookups are served from cache, not live calls):

```bash
products cache export cache.json           # snapshot the cache to a file
products cache import cache.json [--flush]  # restore it (--flush clears first)
products cache stats                        # how many entries are cached
products resolvers                          # list resolvers + the active one
```

### Telegram bot

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Put it in `.env` as `TELEGRAM_BOT_TOKEN=...`.
3. Start the optional `bot` service via its profile:
   ```bash
   docker compose --profile telegram up --build -d
   #   — or —
   podman-compose --profile telegram up --build -d
   ```
4. Send the bot a photo of a receipt. It replies with a link to the breakdown.

The link the bot sends is built from `PUBLIC_BASE_URL`, so set that to an address
Telegram-side you can actually open (not `localhost` if you're on your phone).

### Raw REST API

```bash
# Upload (field name: "receipt")
curl -F "receipt=@receipt.jpg" http://localhost:8080/api/receipts
# -> 202 { "id": "...", "status": "queued", "statusUrl": "...", "viewUrl": "..." }

# Upload and apply a receipt profile after OCR (add a "profileId" field)
curl -F "receipt=@receipt.jpg" -F "profileId=usGrocery1" http://localhost:8080/api/receipts
# -> 202 { "id": "...", "profileId": "rp_...", "profileResultUrl": "...", ... }

curl http://localhost:8080/api/receipts/<id>     # one record (JSON)
curl http://localhost:8080/api/receipts          # list
# Web view:           http://localhost:8080/receipts/<id>/view
# Profile-applied view: http://localhost:8080/receipts/<id>/profileResults/usGrocery1/view
# Original photo:     http://localhost:8080/receipts/<id>/image
```

---

## Multi-tenancy

Every resource is scoped to an identity — a **(tenant, user)** pair — and a
resource's public id is the composite `"<tenant>:<user>:<cacheId>"`. Out of the
box everything lands under **`main/main`**, so single-tenant use needs no extra
setup. For multi-tenant deployments:

- **Identity on a request** comes from the `X-Tenant-Id` / `X-User-Id` headers
  (or `tenantId`/`userId` form fields), defaulting to `DEFAULT_TENANT_ID` /
  `DEFAULT_USER_ID`. Set those **empty** to require explicit identity on every
  request (strict mode). The CLI takes `TENANT_ID`/`USER_ID` env vars or
  `--tenant`/`--user` on `upload`.
- **Tenants are accounts.** Provision one before its first upload —
  `receipts tenant create acme` (or `POST /api/tenants {"tenantId":"acme"}`); an
  upload for an unknown tenant is rejected. The default tenant is auto-created.
- **What's isolated vs shared:** receipts, profile results and product results
  are private per tenant+user (`DATA_DIR/<tenant>/<user>/…`); profile definitions
  and the enrichment cache are per tenant; the product (SKU→product) cache is
  global across tenants. Each tenant gets its own worker queue (`receipts-<tenant>`).

Full details: [`docs/API.md` → Identity & multi-tenancy](docs/API.md#identity--multi-tenancy).

---

## Podman & security notes

This stack is built to run rootless under Podman with no special flags:

- **Fully-qualified images** (`docker.io/library/...`) so Podman won't prompt you
  to choose a registry.
- **Non-root containers** — the app image runs as the built-in `node` user; no
  `privileged`, no host networking, no capabilities added.
- **Named volumes** for both Redis data and receipt data. On rootless Podman this
  avoids the usual bind-mount UID-mapping permission headaches — it just works.
- **Unprivileged port** — the API listens on `8080` (rootless can't bind <1024).
- A `Containerfile` symlink is included since Podman looks for that name by
  default, though `docker-compose.yml` points both runtimes at `Dockerfile`.
- **Always pass `-p receipt-enricher`** to `podman-compose`. It names the built
  images `<project>_<service>`, and a stray `RECEIPT_PROJECT` or
  `COMPOSE_PROJECT_NAME` exported in your shell can poison the project name —
  e.g. an invalid value yields `Error: tag …: invalid reference format` on
  build. The explicit `-p` flag overrides both env vars and the compose `name:`,
  so the build is deterministic regardless of your environment.

**Want the receipt files on your host filesystem** (to inspect the JSON/images)?
Swap the named volume for a bind mount on the `api` and `worker` services:

```yaml
    volumes:
      - ./data:/app/data:Z      # :Z applies an SELinux label (Fedora/RHEL)
```

Under **rootless Podman** you'll also likely want the container UID to match
yours so it can write there:

```bash
podman-compose -p receipt-enricher up   # then, if you hit permission errors on ./data:
# add to the api & worker services:   userns_mode: "keep-id"
```

(Docker users can use `./data:/app/data` with no `:Z` and no `userns`.)

---

## Configuration reference

All via `.env` (see `.env.example`). Highlights:

| Variable             | Default                  | Notes                                        |
|----------------------|--------------------------|----------------------------------------------|
| `PORT`               | `8080`                   | API port                                     |
| `PUBLIC_BASE_URL`    | `http://localhost:8080`  | Used to build shareable links                |
| `DEFAULT_TENANT_ID`  | `main`                   | Implicit tenant when a request omits one; set **empty** for strict multi-tenant (see Multi-tenancy) |
| `DEFAULT_USER_ID`    | `main`                   | Implicit user when a request omits one       |
| `TELEGRAM_TENANT_ID` | —                        | tenant the bot's uploads belong to (empty = server default; each TG user → `tg_<id>`) |
| `OCR_PROVIDER`       | `auto`                   | `auto` \| `vision` \| `tesseract` \| `paddle` \| `paddle-vl` (last two = optional sidecars, see PaddleOCR sidecars) |
| `OCR_PADDLE_URL`     | `http://ocr-paddle:8090` | base URL of the PP-OCRv6 sidecar (used only when `OCR_PROVIDER=paddle`) |
| `OCR_PADDLE_VL_URL`  | `http://ocr-paddle-vl:8090` | base URL of the PaddleOCR-VL sidecar (used only when `OCR_PROVIDER=paddle-vl`) |
| `OCR_REST_TIMEOUT_MS`| `600000`                 | per-request timeout (ms) for a REST OCR sidecar (PaddleOCR-VL is slow) |
| `VISION_PROVIDER`    | `anthropic`              | `anthropic` \| `openai`                      |
| `ANTHROPIC_API_KEY`  | —                        | enables vision extraction                    |
| `ANTHROPIC_MODEL`    | `claude-sonnet-4-6`      | any vision-capable Claude model              |
| `OPENAI_API_KEY`     | —                        | alternative vision provider                  |
| `TAVILY_API_KEY`     | —                        | enables item image/metadata enrichment       |
| `ENRICH_MAX_ITEMS`   | `40`                     | cap Tavily lookups per receipt               |
| `QUEUE_CONCURRENCY`  | `2`                      | parallel receipts in the worker              |
| `JOB_ATTEMPTS`       | `3`                      | retries with exponential backoff             |
| `PERSISTENCE`        | `sqlite`                 | durable record backend: `sqlite` \| `filesystem` \| `postgresql` (TODO). Image blobs always stay on the filesystem |
| `SQLITE_PATH`        | `<DATA_DIR>/receipt-enricher.db` | SQLite database file (only when `PERSISTENCE=sqlite`) |
| `DEFAULT_PROFILE_ID` | —                        | receipt profile (id or name) applied to uploads that omit one |
| `PRODUCTS_ENABLED`   | `true`                   | master switch for the product-resolution stage |
| `PRODUCT_RESOLVER`   | `anthropic`              | backend resolver/adapter (the only one shipped; `tavily` is a future drop-in) |
| `PRODUCT_ANTHROPIC_MODEL` | `claude-haiku-4-5`  | model the anthropic resolver calls (set `claude-sonnet-4-6` if Haiku can't use web tools) |
| `PRODUCT_ANTHROPIC_WEB_SEARCH` | `true`         | ground `productUrl` via Anthropic's server-side web search |
| `PRODUCT_MAX_ITEMS`  | `100`                    | cap line items resolved per receipt (one backend call each) |
| `PRODUCT_CONCURRENCY` | `5`                     | max per-item lookups run in parallel within one receipt |
| `PRODUCT_CACHE_ENABLED` | `true`                | shared Redis cache in front of lookups (key: resolver+store+sku+description) |
| `PRODUCT_CACHE_TTL_SECONDS` | `2592000`         | how long a cached product lookup lives (default 30 days) |
| `PRODUCT_EVENTS_MAX` | `500`                    | size of the per-lookup event buffer behind `/products/monitor` (0 disables) |
| `PRODUCT_RESOLVE_ON_UPLOAD` | `true`            | resolve products on upload whenever a profile is applied (opt out per-upload with `resolveProducts=0`) |
| `PRODUCT_EMOJI_ENABLED` | `true`                | map each product to a meaningful emoji (e.g. 🥚 for eggs) in the same lookup, shown in the product view's image placeholder; `0` disables it |
| `TELEGRAM_BOT_TOKEN` | —                        | enables the bot service                      |

Inside compose, `REDIS_URL` and `DATA_DIR` are set for you. The compose file also
reads a few **host-side** variables (with prod-safe defaults) so the same file
can run an isolated second stack: `RECEIPT_API_PORT` (published host port,
default `8080`), `RECEIPT_PROJECT` (compose project name), `OCR_PROVIDER`, and
`RECEIPT_SUITE` (a `io.receipt-enricher.suite` container label). Keep
`PUBLIC_BASE_URL` aligned with the published `host:port` so the API advertises
links that actually resolve. (The acceptance suite uses these — see Testing.)

---

## PaddleOCR sidecars (optional OCR engines)

Two heavier OCR engines run as **their own containers** rather than inside the
lean Node image — the worker talks to them over HTTP via the generic REST OCR
client (`src/ocr/rest.js`). They are **opt-in**: a plain `up` never builds or
starts them, and Tesseract stays the default.

| Engine (`OCR_PROVIDER`) | Compose profile / service | Models (baked into the image) | Speed |
|-------------------------|---------------------------|-------------------------------|-------|
| `paddle`    | `paddle` / `ocr-paddle`       | PP-OCRv6 small det+rec (~30 MB)        | fast |
| `paddle-vl` | `paddle-vl` / `ocr-paddle-vl` | PaddleOCR-VL 1.6 full pipeline (~2 GB) | ~120 s/receipt |

Each sidecar exposes `GET /health` and `POST /ocr` (`{id, mimeType, imageBase64}`
→ `{text, lineCount, confidence, runtimeMs, …}`); the model loads once at boot
and stays warm.

```bash
# 1. Stage the baked-in model blobs + internal CA certs into the build context
#    (gitignored; copied from the local receipt-lens-models bundle):
scripts/stage-paddle-models.sh
scripts/stage-paddle-certs.sh

# 2. Bring the stack up with the sidecar profile AND point the app at it:
OCR_PROVIDER=paddle    podman-compose -p receipt-enricher --profile paddle    up --build -d
OCR_PROVIDER=paddle-vl podman-compose -p receipt-enricher --profile paddle-vl up --build -d
curl -fsS localhost:8080/health | jq '{ocrProvider}'   # confirm the engine took
```

Notes:
- The sidecars pin `linux/amd64` (paddlepaddle's CPU wheels are x86-only), so on
  Apple Silicon they run **emulated** — slower, and memory-hungry. PaddleOCR-VL's
  full-pipeline generation needs well over 12 GiB; tune it down for constrained
  hosts with `PADDLEOCR_VL_MAX_NEW_TOKENS` / `PADDLEOCR_VL_MAX_PIXELS` (compose
  env on the `ocr-paddle-vl` service; defaults match the eval profile).
- **PaddleOCR-VL timing under emulation:** a complex receipt (e.g. Costco) takes
  ~8–14 min/receipt emulated, a simple one ~3 min. The default
  `OCR_REST_TIMEOUT_MS` (600000 = 10 min) is **too low** for complex receipts —
  raise it (e.g. `OCR_REST_TIMEOUT_MS=1200000`) or the worker aborts mid-inference.
  A full 15-receipt corpus completed 15/15 at ~12 GiB+ VM with a 20-min timeout
  (whole run ~2 h); on a native (non-emulated) x86 host it's far faster. On a
  16 GiB Mac, give the podman VM ≥12 GiB or VL OOMs on model load.
- Models are **baked in** (offline at runtime); only the build needs the staged
  blobs. PaddleOCR emits plain transcribed text — the heuristic parser turns it
  into line items, exactly like the Tesseract path.

---

## Local development (without containers)

```bash
npm install
# In separate terminals (needs a Redis on localhost:6379):
npm run server
npm run worker
# optional:
npm run bot
```

---

## Testing

- **Unit/integration (hermetic):** `npm test` — fast, no network, Redis, or keys.
  Details in `test/README.md`.
- **Live extraction checks:** `npm run test:live:vision` / `:tesseract` /
  `:stack` / `:samples` — hit real services and self-skip when prereqs are absent.
- **Acceptance (black-box, containerized):** `bash test/acceptance/run-all.sh`
  builds the stack in containers and drives it from the outside via the CLI and
  raw `curl` (upload → process → done, error cases, and receipt profiles), then
  tears it down. It
  runs **isolated from any live deployment** — its own project name
  (`test-receipt-enricher`) and host port (`18080`) — so it's safe to run on the
  same host as a running stack. Defaults to offline Tesseract; pass `--vision`
  for the Anthropic path. Steps under `cli/` and `rest/` are individually
  runnable. See `test/acceptance/README.md`.

---

## Troubleshooting

- **`receipts health` fails / API unreachable** — make sure the stack is up
  (`docker compose ps` / `podman-compose ps`) and that the API port is published.
- **Receipt stuck in `queued`** — the worker isn't running or can't reach Redis.
  Check `docker compose logs worker`.
- **Items but no images** — enrichment is off (no `TAVILY_API_KEY`) or Tavily had
  no image for that query. The record will still list the items and prices.
- **Garbled / missing items with Tesseract** — expected for messy photos; add a
  vision key for accurate extraction.
- **Permission errors writing `./data` on Podman** — you switched to a bind
  mount; add `userns_mode: "keep-id"` (see Podman notes) or keep the named volume.
- **`depends_on … condition` ignored** on older `podman-compose` — harmless; the
  app retries its Redis connection automatically, so startup order isn't fatal.
- **`podman compose` → "Cannot connect to the Docker daemon"** — that subcommand
  delegates to an external `docker-compose` provider that can't reach the
  rootless Podman socket. Use **`podman-compose`** (hyphenated) instead.
- **Links point at the wrong port** (e.g. `:8080` when you published `:18080`) —
  set `PUBLIC_BASE_URL` to the address you actually published; the API builds
  `statusUrl`/`viewUrl` from it.

---

## Project layout

```
receipt-enricher/
├─ docker-compose.yml      # api + worker + redis (+ optional bot profile)
├─ Dockerfile / Containerfile
├─ .env.example
├─ cli/receipts            # the bash CLI
├─ test/                   # node:test (hermetic + live) + acceptance/ (bash/curl)
└─ src/
   ├─ server.js            # Express API + web views
   ├─ worker.js            # BullMQ worker
   ├─ bot.js               # Telegram bot
   ├─ queue.js  redis.js   # queue + connections
   ├─ persistence/         # pluggable record backend (filesystem | sqlite | TODO postgresql)
   ├─ store.js             # durable receipt records (via persistence; image stays on fs)
   ├─ healthcheck.js  healthcheck-worker.js   # container healthchecks
   ├─ pipeline/            # extract → parse → enrich → summarize
   ├─ ocr/                 # vision + tesseract providers
   ├─ parse/               # structured/heuristic receipt parser
   ├─ enrich/              # Tavily client + cache
   ├─ receiptProfiles/     # profile engine, registry, stores, apply service, transformers/
   ├─ routes/              # REST + web view route modules
   └─ web/                 # server-rendered receipt views
```

---

## Notes & known limits

- The heuristic Tesseract parser is best-effort; the vision path is the quality
  path. Store detection covers common US chains and is easy to extend in
  `src/parse/receiptParser.js`.
- Records are stored as JSON files (durable, survive a Redis flush). For a
  multi-worker deployment, move the record store into Redis/a DB to avoid the
  read-modify-write race noted in `src/store.js`.
- No auth is included — run it on a trusted network or put it behind a reverse
  proxy if you expose it.
```
