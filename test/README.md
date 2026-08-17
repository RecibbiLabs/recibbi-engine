# Test suite

End-to-end coverage of the receipt pipeline, built on the **Node built-in test
runner** (`node --test`) — no extra dependencies, no test framework to install.

```bash
npm install      # one-time, installs the app deps the tests load
npm test         # runs everything in test/*.test.js
node --test test/pipeline.test.js    # run a single file
```

## What it proves

The suite drives the full flow against the **real sample receipt**
(`../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-original.jpg`, a Costco Boca Raton #345 ticket).
Ground truth for that receipt lives in `fixtures/costco-sample.js` in two forms
— the clean JSON a vision model returns, and a realistic raw-OCR dump — so both
extraction paths are tested against one source of truth.

| File | Layer | Highlights |
|------|-------|-----------|
| `parser.test.js`     | `parse/receiptParser` | line-item + price extraction, SKU pull-off, noise filtering, **TOTAL-vs-SUBTOTAL regression guard**, structured-vs-OCR agreement, store canonicalization, **`subtotalMatch` reconciliation (true/false/null)** |
| `store-aliases.test.js` | `parse` (config) | the **configurable store-alias JSON** (`STORE_ALIASES_PATH`): multi-word vision names + custom aliases resolve to their canonical chain; unknown names kept verbatim |
| `store.test.js`      | `store`               | persists the **actual sample JPEG** byte-for-byte, record CRUD, newest-first listing, mime→extension |
| `persistence.test.js` | `persistence/backends/*` | the generic backend **contract run against BOTH `filesystem` + `sqlite`**: get/put/delete/list, scope isolation, sub-keyed nesting, tenant-scoped + global kinds |
| `persistence-stores.test.js` | stores + `tenants` (on filesystem) | the four record stores + tenant registry driven through their public APIs with **`PERSISTENCE=filesystem`** pinned (SQLite is the default, so the rest of the suite already covers it); tenant list **survives a Redis recycle via `hydrate()`** |
| `enrich.test.js`     | `enrich` + Tavily     | graceful skip when disabled, Tavily image/metadata mapping, **Redis cache hit avoids re-spending credits**, `ENRICH_MAX_ITEMS` cap, per-item error isolation |
| `ocr-vision.test.js` | `ocr/vision`          | Anthropic + OpenAI request shapes, base64 image attach, ```json``` fence stripping, prose-wrapped JSON recovery, API-error surfacing |
| `ocr-index.test.js`  | `ocr` (dispatch)      | provider selection (`vision` vs `tesseract`) from config, record pass-through, **provider tag on the result** |
| `pipeline.test.js`   | `pipeline`            | **full extract → parse → enrich → summarize → `done`** on the sample image; tesseract+no-key degradation path; failure propagation |
| `routes.test.js`     | `app` + `routes` (HTTP) | drives the **real Express app over loopback**: upload validation (no file → 400, non-image → 400, oversize → **413**), `202` + enqueue + persisted record, alternate field names, list shape/`limit` clamp, `404`s, view/image/root HTML, `/health` |
| `config.test.js`     | `config`              | the README "which keys → which mode" matrix (nothing / Tavily / Anthropic / OpenAI / both / overrides) |
| `view.test.js`       | `web/view`            | HTML rendering of items/totals/enrichment images, list + empty states, **HTML-escaping against injection from receipt text**, subtotal reconciliation note (shortfall warning / overage / ✓ match) |

### Receipt Profiles ([docs/RECEIPT-PROFILES.md](../docs/RECEIPT-PROFILES.md))

| File | Layer | Highlights |
|------|-------|-----------|
| `profileEngine.test.js`        | `receiptProfiles/engine`   | runs a transform fn; **auto-diffed `changes`**, totals recompute, source immutability, return-new-draft, numeric diffs, ctx passthrough |
| `transformerRegistry.test.js`  | `receiptProfiles/registry` | loads the shipped `usGrocery.ts` via the runtime TS loader; `types` not registered; unknown id → null |
| `tesseractGroceryUs.test.js`   | transformer                | `tesseractGroceryUs` cleanup on real Tesseract-shaped items: strips junk + SKU code, Title-Cases, expands abbreviations, **infers Costco from KS items**, cleanup invariants |
| `profileValidate.test.js`      | `receiptProfiles/validate` | name/transformer/config validation |
| `profileStore.test.js`         | `receiptProfiles/profileStore` | CRUD + version bump + unknown-transformer rejection |
| `profileSeed.test.js` / `profileResultStore.test.js` | profile + result stores | first-boot seeding; result save/get/list keyed by profile id |
| `profileRoutes.test.js`        | `routes` (HTTP)            | full profile HTTP surface incl. `/api/transformers`, sync `applyProfile`, `?dryRun=1` |
| `applyService.test.js`         | `receiptProfiles/applyService` | shared apply service (sync route + worker): applies + persists, resolves by id/name, dryRun, **never mutates the source record**, `ApplyError` 404s |
| `workerDispatch.test.js`       | `worker`                   | pure `dispatch(job)` routes on `job.name` (`process-receipt` vs `applyProfile`) **without Redis**; unknown name throws |
| `uploadProfile.test.js`        | `routes` (HTTP)            | upload with `profileId` enqueues the **OCR→profile flow** (unknown profile → 400, `DEFAULT_PROFILE_ID` fallback); `applyProfile?async=1` → `202` |

### Products (line item → product; see the skill's "Products" section)

| File | Layer | Highlights |
|------|-------|-----------|
| `products-registry.test.js`            | `products/registry`            | loads resolver modules, active = `config.products.resolver`, unknown id → null |
| `products-resolver-anthropic.test.js`  | `products/resolvers/anthropic` | prompt build, web-tool **`allowed_callers:['direct']`**, JSON / `pause_turn` handling, field normalize |
| `products-service.test.js`             | `products/resolveService`      | one product per item, `PRODUCT_MAX_ITEMS` cap, dryRun, null→skip / error note, disabled degrade |
| `products-cache.test.js`               | `products/productCache` + service | repeat SKU **served from cache** (no 2nd backend call), price/qty don't bust the key, **bounded parallel pool** (peak concurrency), `cacheEnabled=false` bypass |
| `products-monitor.test.js`             | `products/productEvents` + routes | per-lookup hit/miss events, `/api/products/events` summary stats, `/products/monitor` + **`/observe/cache/products` alias** shell |
| `products-cache-io.test.js`            | `products/productCache` + routes  | export **excludes the event log**, import flush/skip rules, export→import round-trip, the cache REST endpoints |
| `products-routes.test.js`              | `routes` (HTTP)                | resolver listing, sync/`dryRun`/`async` resolve, `404`/`409`, persisted read-back, cross-receipt listing |

## Hermetic by design

Tests run **offline with no API keys and no Redis**:

- **Network** (`fetch`) is stubbed per-test, so vision (Anthropic/OpenAI) and
  Tavily calls return canned responses — request shape is asserted, nothing
  leaves the machine.
- **Redis** is replaced with an in-memory fake injected into the require cache,
  so the enrichment cache and queue connections need no running server. The fake
  also implements the list/counter/scan ops (`lpush`/`lrange`/`ltrim`/`incr`/
  `scan`/`ttl`/`del`) the product **event log** and **cache export/import** use.
- **Data dir** is redirected to a fresh `os.tmpdir()` folder per file and
  cleaned up afterward — nothing is written under `data/`.

See `helpers/harness.js` for these utilities. The HTTP test (`routes.test.js`)
additionally binds the real Express app to an ephemeral **loopback** port and
hits it with the real global `fetch` (so request parsing, multer, and the error
handler are exercised end-to-end) — still offline. It stubs `src/queue` in the
require cache so requiring the routes never opens a BullMQ/Redis connection.

## Bug this suite caught

`src/ocr/vision.js` imported `./config` / `./logger` (which don't exist in
`src/ocr/`) instead of `../config` / `../logger`. The entire vision-extraction
path — the README's recommended mode — threw `MODULE_NOT_FOUND` the moment an
API key was set. Fixed, with `ocr-vision.test.js` and `pipeline.test.js`
guarding against regressions.

## Live tests (one per extraction option)

Real, runnable tests under `test/live/` — each reads the sample receipt and
prints its contents, and each self-skips when its prerequisites are missing
(so they never break `npm test`, which is scoped to `test/*.test.js`).

| Option | Command | Needs |
|--------|---------|-------|
| 1. Vision model | `ANTHROPIC_API_KEY=sk-... npm run test:live:vision` | a vision API key |
| 2. Offline Tesseract | `npm run test:live:tesseract` | reachable CDN for first-run data |
| 3. Full stack | `npm run test:live:stack` | a running stack (`podman-compose -p receipt-enricher up -d`, or `docker compose up -d`) |
| 4. Sample corpus | `ANTHROPIC_API_KEY=sk-... npm run test:live:samples` | a vision API key |
| all of them | `npm run test:live` | — |

**Sample corpus (`samples.live.test.js`)** runs the vision model over *every*
photo in `samples/costco/` (skipping `rotated_` duplicates), prints a one-line
summary per receipt, and asserts the invariants a good extraction must meet —
Costco recognized, ≥1 item, numeric prices, and totals captured on most. It's a
smoke test against real (non-deterministic) model output, so it surfaces quality
regressions without being brittle, and self-skips with no key. Each entry also
reports `subtotalMatch` (do the items reconcile with the printed subtotal?) and
flags a **shortfall** — items summing under the subtotal, a likely missed line.

### TLS-intercepting proxy gotcha (important on managed networks)

**Node has its own CA bundle, independent of the macOS keychain / `curl`.** On a
network that does TLS inspection (e.g. a TLS-intercepting proxy), Node can't validate
the intercepted certificate and outbound HTTPS fails with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` — even though `curl` and the browser work.

On the network this was developed on, the interception was **selective**:

| Host | Node fetch | Affected feature |
|------|-----------|------------------|
| `api.anthropic.com` | ✅ trusted | vision extraction works |
| `cdn.jsdelivr.net`  | ❌ blocked | Tesseract first-run data download |
| `api.tavily.com`    | ❌ blocked | item enrichment (images/metadata) |

So the **vision path (Option 1) is the reliable way to read a receipt here**;
Tesseract and Tavily need Node to trust the internal root CA:

```bash
# Point Node at your internal root CA (proper fix — applies to all the above):
NODE_EXTRA_CA_CERTS=/path/to/internal-root-ca.pem npm run test:live:tesseract

# Quick, INSECURE dev-only escape hatch (disables TLS verification):
NODE_TLS_REJECT_UNAUTHORIZED=0 npm run test:live:tesseract
```

The Tesseract test does a fast TLS preflight and **skips in <1s** (rather than
hanging on a wedged download) when the CDN is unreachable from Node.

### Making the offline Tesseract path work without CDN access

Fetch the language data from a clean network (e.g. Google Colab) and drop it in
`tessdata/`. The code points Tesseract at that folder (`config.tessdataDir`,
override via `TESSDATA_PATH`), so it loads from disk and never calls the CDN.

Run this in a **Google Colab** cell, then download `eng.traineddata`:

```python
import requests, gzip
url = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/eng.traineddata"
raw = requests.get(url, timeout=60).content
data = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw   # normalize to uncompressed
open("eng.traineddata", "wb").write(data)
print("eng.traineddata:", len(data), "bytes")
assert len(data) > 1_000_000, "download looks wrong (too small)"
from google.colab import files
files.download("eng.traineddata")
```

Then on this machine:

```bash
mv ~/Downloads/eng.traineddata receipt-enricher/tessdata/
npm run test:live:tesseract     # now OCRs the sample instead of skipping
```

**Orientation matters for Tesseract.** The bundled sample is shot rotated 90°,
and Tesseract reads sideways text as noise (vision models don't care). Rotate the
photo upright first, then point the live test at it with `SAMPLE_IMAGE`:

```bash
# any orientation reads cleanly (OCR auto-corrects): 12 items, ~$121 sum, fully offline
SAMPLE_IMAGE=../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-rotated.jpg npm run test:live:tesseract
```

`SAMPLE_IMAGE` works for any live test (vision/stack too). Quality is still
best-effort on a crumpled photo — expect a little noise in descriptions and the
occasional digit slip; the vision path is the clean path.

## Acceptance suite (bash/curl, containerized)

For black-box coverage against a **real running stack**, see
**`test/acceptance/`** (`bash test/acceptance/run-all.sh`). It brings the stack
up in containers (Podman by default), drives it from the outside via the CLI and
raw `curl` — upload → process → `done`, list, image, view, and the error paths —
then tears it down. It runs **isolated from any live deployment** (its own
compose project `test-receipt-enricher`, host port `18080`, `suite=test` label,
separate volumes; teardown refuses to touch the prod project), so it's safe to
run alongside a running stack. Defaults to offline Tesseract; `--vision` uses
the Anthropic path. Steps under `cli/` and `rest/` are individually runnable.
Full docs in `test/acceptance/README.md`.

> This suite hits **real Redis**, so it catches integration bugs the hermetic
> fake-Redis suite can't — e.g. a BullMQ job id containing `:` (rejected with
> "Custom Id cannot contain :"), which had made every upload return HTTP 400.

## Optional: live end-to-end (manual)

The hermetic tests deliberately mock external services. To smoke-test the real
stack by hand, follow the README quick start (`podman-compose -p receipt-enricher
up --build -d`, or `docker compose up --build -d`) and upload the sample with the CLI:

```bash
./cli/receipts upload ../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-original.jpg --wait
```
