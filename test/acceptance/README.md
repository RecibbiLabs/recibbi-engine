# Acceptance suite (bash + curl)

Black-box acceptance tests that bring up the app as a **containerized stack** and
exercise it from the outside — through the bundled CLI (`cli/receipts`) and the
raw REST API. Distinct from the in-process `node:test` suites (`npm test` is
hermetic; `test/live/*` are node-driven live tests).

```
test/acceptance/
├─ run-all.sh        # up → cli/ steps → rest/ steps → teardown
├─ lib/
│  ├─ common.sh      # config, logging, assertions, shared helpers (sourced)
│  └─ compose.sh     # engine-aware up / wait-healthy / down (sourced)
├─ lifecycle/
│  ├─ 00_up.sh       # build + start the isolated test stack, wait until healthy
│  └─ 99_down.sh     # tear down (removes volumes by default)
├─ cli/              # driven through ./cli/receipts and ./cli/products
│  ├─ 10_health.sh  20_upload.sh  30_list.sh  40_view.sh
│  └─ 50_productsCacheIo.sh   # `products` CLI cache export/import round-trip (offline)
└─ rest/             # driven through raw curl
   ├─ 10_health.sh  20_upload.sh  30_list.sh  40_image.sh  50_view.sh  60_errors.sh
   ├─ 70_applyProfile.sh        # apply a profile to a processed receipt (sync)
   ├─ 80_uploadWithProfile.sh   # upload with profileId → OCR-then-profile BullMQ flow
   ├─ 81_tesseractProfile.sh    # tesseractGroceryUs cleanup profile (Tesseract mode only)
   ├─ 90_resolveProducts.sh     # resolve products from a profile result (sync/async/dryRun)
   ├─ 95_multitenancy.sh        # dynamic tenant onboarding, per-tenant queues, cross-tenant/user isolation
   ├─ 96_persistence.sh         # active backend (filesystem|sqlite) + record survives an api/worker restart
   └─ 97_retailerIngest.sh      # retailer JSON ingest (POST /api/retailer:<id>/receipts) — table-driven per retailer
```

Steps auto-discover: `run-all.sh` runs every `cli/*.sh`, then `rest/*.sh`, then
`corpus/*.sh` in name order. The profile-content assertions in `70`/`80` only run
under `--vision` (under Tesseract the store name is unreadable, so `usGrocery` is
a near no-op); `81` is the reverse — it exercises the `tesseractGroceryUs` cleanup
profile and **runs only under `--ocr tesseract`** (skips for vision and the
PaddleOCR engines, whose text shape differs). The `corpus/` step is the optional
PaddleOCR chunked-corpus run — it **self-skips unless `--paddle`/`--paddle-vl`**.

### Retailer JSON ingest (`97_retailerIngest.sh`)

Covers the second way into the pipeline: a receipt posted as the retailer's own
order JSON, which skips OCR entirely (see
[docs/RETAILER-INGEST.md](../../docs/RETAILER-INGEST.md)). It asserts the things
only a live stack can show — that a JSON receipt rides the **same
`process-receipt` job on the same per-tenant queue** and reaches `done` through a
real worker, that the worker reads the payload blob back off the shared volume
(the API and worker are separate containers), and that **dedupe survives a round
trip through real Redis**. It runs under plain `--ocr tesseract` and does no
model work: `extraction.provider` is the adapter, not an OCR engine.

Payloads come from the ground-truth corpus when it is present
(`$RE_TEST_RETAILER_CORPUS_DIR/<retailer>/<orderId>.json`, default
`../codex-receipt-retailer-ground-truth`), otherwise from the committed scrubbed
fixtures under `test/fixtures/retailers/`. Money and structure are identical
either way, so the step **always runs** rather than skipping on a fresh checkout.

**Adding a retailer** is one row in `RETAILER_CASES` at the top of the step:

```
# retailerId | fixtureDir | fixtureFile | orderId | items | total | storeName
samsclub.com|samsclub|scan-and-go.json|00769925960064747015|4|39.66|Sam's Club
```

plus a scrubbed fixture at `test/fixtures/retailers/<fixtureDir>/<fixtureFile>`.
Nothing else in the step is retailer-specific. It cross-checks the table against
`GET /api/retailers` — a covered retailer that is not registered **fails**, and a
registered retailer with no case **warns**, so shipping an adapter nags for
coverage without breaking the suite.

## Isolation from production (run it on a host that already runs the app)

The suite **never touches a production stack**. Three layers:

| Mechanism | Production | Test suite |
|-----------|-----------|------------|
| compose project | `receipt-enricher` | `test-receipt-enricher` (`test-` prefix → obvious in `podman ps`) |
| container label | `io.receipt-enricher.suite=prod` | `io.receipt-enricher.suite=test` |
| host port | `8080` | `18080` |
| volumes | `receipt-enricher_*` | `test-receipt-enricher_*` |

`lifecycle/99_down.sh` (and `run-all.sh` teardown) is scoped strictly to the test
project **and refuses to run if the project name equals `receipt-enricher`**, so a
misconfiguration can't wipe prod data.

## Usage

```bash
cd receipt-enricher

# Whole suite: up → all steps → teardown (volumes removed)
bash test/acceptance/run-all.sh

# Keep the stack up afterward to poke at it, or keep its data:
bash test/acceptance/run-all.sh --no-teardown
bash test/acceptance/run-all.sh --keep-volumes

# Use the Anthropic vision path instead of offline Tesseract:
bash test/acceptance/run-all.sh --vision        # (or --ocr vision)

# Optional PaddleOCR engines (their own sidecar containers; off by default).
# Stage model blobs + certs and build first (see ../../README.md PaddleOCR sidecars):
bash test/acceptance/run-all.sh --paddle         # PP-OCRv6 small sidecar + chunked corpus
bash test/acceptance/run-all.sh --paddle-vl      # PaddleOCR-VL 1.6 sidecar (slow, ~120s/receipt)

# Exercise the SQLite persistence backend instead of the filesystem default:
bash test/acceptance/run-all.sh --sqlite         # (or --persistence sqlite)

# Run individual steps (stack must be up first):
bash test/acceptance/lifecycle/00_up.sh
bash test/acceptance/rest/20_upload.sh
bash test/acceptance/cli/30_list.sh
bash test/acceptance/lifecycle/99_down.sh
```

Each step is self-contained: steps that need a processed receipt reuse a cached
id (`.state/receipt_id`) or create one on demand, and fail fast with a clear
message if the stack isn't up.

## OCR modes

- **`tesseract` (default)** — fully offline (local `tessdata` + bundled
  `tesseract.js-core`); no API key or network needed. Extraction is best-effort,
  so steps only assert pipeline completion (`status==done`) and structure, not
  item counts.
- **`vision`** — uses `ANTHROPIC_API_KEY` from `.env` with `claude-sonnet-4-6`.
  Costs a few API calls per run; adds stricter assertions (items > 0, store
  detected, totals sum > 0).
- **`paddle` / `paddle-vl`** (opt-in) — activate the matching compose profile +
  sidecar container (PP-OCRv6 small / PaddleOCR-VL 1.6), wait for the sidecar's
  model to warm (`/health` `ready=true`), then run the `corpus/` step: the whole
  ground-truth corpus pushed through in exponential **1,2,4,8** chunks (mirrors
  the eval harness). Assertions are structural (every receipt reaches `done` with
  `provider==<engine>`); OCR quality is reported, not asserted. Prereq: stage +
  build the sidecar images first (see the repo README's PaddleOCR sidecars).
  PaddleOCR-VL is amd64-emulated on Apple Silicon — slow and RAM-hungry; full
  generation may need a larger podman VM (the OOM fix) and/or lower
  `PADDLEOCR_VL_MAX_NEW_TOKENS`/`PADDLEOCR_VL_MAX_PIXELS`.

## Configuration (env vars, all defaulted)

| Var | Default | Meaning |
|-----|---------|---------|
| `RE_TEST_ENGINE` | `podman` | `podman` (uses `podman-compose`) or `docker` (`docker compose`) |
| `RE_TEST_PROJECT` | `test-receipt-enricher` | compose project name (isolation) |
| `RE_TEST_API_PORT` | `18080` | host port for the test API |
| `RE_TEST_BASE` | `http://localhost:$RE_TEST_API_PORT` | base URL the steps hit |
| `RE_TEST_OCR` | `tesseract` | `tesseract` \| `vision` \| `paddle` \| `paddle-vl` |
| `RE_TEST_PERSISTENCE` | `filesystem` | durable record backend: `filesystem` or `sqlite` (`fs` accepted) |
| `RE_TEST_SAMPLE` | upright costco sample | receipt image to upload |
| `RE_TEST_CORPUS_DIR` | ground-truth `samples/` | corpus dir for the chunked PaddleOCR step |
| `RE_TEST_CORPUS_LIMIT` | — | cap the corpus to N images for a quicker paddle run |
| `RE_TEST_BATCH_SIZES` | `1 2 4 8` | chunk sizes for the corpus step (last size repeats) |
| `RE_TEST_KEEP_VOLUMES` | `0` | `1` keeps volumes on teardown |
| `RE_TEST_NO_TEARDOWN` | `0` | `1` leaves the stack running after `run-all.sh` |
| `RE_TEST_POLL_TIMEOUT` | `240` (`600` paddle, `1800` paddle-vl) | seconds to wait for health / per-receipt processing |
| `RE_TEST_POLL_INTERVAL` | `3` | poll interval seconds |

## Requirements

`curl` and `jq` on the host; `podman` + `podman-compose` (default) or Docker.
On this host `podman` is under `/opt/podman/bin` — the suite adds it to `PATH`
automatically. Note: plain `podman compose` is **not** used (its external
docker-compose provider can't reach the podman socket here); `podman-compose` is.
