# Receipt Enricher — HTTP API

The backend exposes a small REST API plus server-rendered web views. The same
endpoints back both ingestion paths (the bash CLI and the Telegram bot) and the
browser views.

- **Base URL:** `http://localhost:8080` (override with `PUBLIC_BASE_URL`; the
  examples below use a `BASE` shell variable). The `statusUrl`/`viewUrl` the API
  returns are built from `PUBLIC_BASE_URL`, so set it to the address you actually
  publish — e.g. when the container's `8080` is mapped to a different host port
  (the acceptance suite publishes `18080`), point `PUBLIC_BASE_URL` there or the
  returned links won't resolve.
- **Auth:** none. Run it on a trusted network or behind a reverse proxy.
- **Identity:** every resource is scoped to a **(tenant, user)** pair — see
  [Identity & multi-tenancy](#identity--multi-tenancy) below.
- **Content types:** JSON for the API, `multipart/form-data` for uploads,
  `text/html` for the views.

```bash
BASE=http://localhost:8080      # or: API_URL for the CLI / a remote host
```

---

## Identity & multi-tenancy

Every resource is owned by an identity: a **(tenantId, userId)** pair. A
resource's public id is the **composite id** `"<tenant>:<user>:<cacheId>"`
(e.g. `main:main:1b70d95bbd9f462f`) — self-describing, so once you have an id you
can read it back with no extra headers. Segments are a flexible string
(`[A-Za-z0-9_-]{1,64}`: UUIDs, `main`, etc.).

- **Where identity comes from.** On **upload** (and on collection endpoints like
  `GET /api/receipts`), identity is taken from the `X-Tenant-Id` / `X-User-Id`
  request headers (or `tenantId`/`userId` form fields), falling back to the
  server defaults `DEFAULT_TENANT_ID` / `DEFAULT_USER_ID` (default `main`/`main`).
  Set those env vars **empty** to run strict multi-tenant — then every request
  must send the headers, and one that doesn't gets `400`.
- **Tenants are accounts.** An upload for a tenant that hasn't been provisioned
  is rejected (`400 unknown tenant "x"`). Create one with
  [`POST /api/tenants`](#tenant-accounts) first; the default tenant is
  auto-provisioned at boot.
- **Isolation.** Receipts, profile results and product results are stored per
  tenant **and** user (`DATA_DIR/<tenant>/<user>/…`); profile *definitions* are
  per tenant (`DATA_DIR/<tenant>/receiptProfiles`). The enrichment cache is
  per-tenant; the product (SKU→product) cache and its monitor are **global**
  (shared across tenants — a SKU's product identity is the same for everyone).
- **Scope follows the id.** Receipt-scoped routes (`…/receipts/:id/…`) derive the
  tenant/user from the composite `:id`, so they need no headers.

```bash
# Provision a tenant, then upload under it for a specific user:
curl -fsS -X POST "$BASE/api/tenants" -H 'content-type: application/json' -d '{"tenantId":"acme"}'
curl -fsS -H 'X-Tenant-Id: acme' -H 'X-User-Id: alice' -F "receipt=@r.jpg" "$BASE/api/receipts"
# -> id like "acme:alice:1b70d95bbd9f462f"
```

---

## Receipt lifecycle

A receipt moves through these `status` values:

```
queued  ──►  processing  ──►  done
                   └────────►  failed
```

- `queued` — accepted, image saved, job enqueued.
- `processing` — the worker is running extract → parse → enrich → summarize.
- `done` — finished; items, totals and summary are populated.
- `failed` — all retries exhausted; `error` holds the reason.

> Uploading enqueues a job on Redis/BullMQ, so the **upload path needs the full
> stack running** (`docker compose up` / `podman-compose -p receipt-enricher up` — see the README).
> The read endpoints (`GET …`) and the web views only read records from disk and
> work without Redis.

---

## Endpoints

| Method | Path | Purpose | Returns |
|--------|------|---------|---------|
| `GET`  | `/health` | Liveness + Redis/config status | JSON |
| `GET`  | `/api/tenants` | List provisioned tenants (+ the default) | JSON |
| `POST` | `/api/tenants` | Provision a tenant account (idempotent) | `201`/`200` JSON |
| `POST` | `/api/receipts` | Upload a receipt image (enqueues processing; `X-Tenant-Id`/`X-User-Id` set the owner; optional `profileId` applies a profile after OCR, then resolves products by default — `resolveProducts=0` opts out) | `202` JSON |
| `GET`  | `/api/retailers` | List the retailer JSON adapters this build ships | JSON array |
| `POST` | `/api/retailer:<id>/receipts` | Ingest a retailer's own receipt JSON (skips OCR; same options as `/api/receipts` plus `enrich`/`dedupe`) | `202` / `200` JSON |
| `GET`  | `/receipts/:id/payload` | The original retailer payload for a JSON receipt | JSON |
| `GET`  | `/api/receipts` | List the identity's receipts, newest first. Filters, `?offset=`, `?limit=` (max 500). `?envelope=1` adds the counts and the facets | JSON array (object with `envelope=1`) |
| `GET`  | `/api/receipts/:id` | Full record for one receipt | JSON |
| `GET`  | `/receipts/:id/view` | Human-readable HTML view | HTML |
| `GET`  | `/receipts/:id/image` | The original uploaded photo | image bytes |
| `GET`  | `/` | HTML list of all receipts | HTML |
| `GET`  | `/api/transformers` | List available transformers | JSON array |
| `GET`  | `/api/receiptProfiles` | List receipt profiles | JSON array |
| `POST` | `/api/receiptProfiles` | Create a profile | `201` JSON |
| `GET`  | `/api/receiptProfiles/:id` | One profile (id or name) | JSON |
| `PUT`  | `/api/receiptProfiles/:id` | Replace a profile | JSON |
| `DELETE` | `/api/receiptProfiles/:id` | Delete a profile | `204` |
| `POST` | `/api/receipts/:id/applyProfile/:profileId` | Apply a profile to a receipt (`?dryRun=1`, `?async=1`) | JSON / `202` |
| `GET`  | `/api/receipts/:id/profileResults` | List profile results for a receipt | JSON array |
| `GET`  | `/api/receipts/:id/profileResults/:profileId` | One profile result | JSON |
| `GET`  | `/receipts/:id/profileResults/:profileId/view` | HTML view of the receipt with the profile applied | HTML |
| `GET`  | `/api/profileResults` | List **all** profile results across every receipt | JSON array |
| `GET`  | `/api/profileResults/:profileId` | All results for one profile (id or name), across every receipt | JSON array |
| `GET`  | `/profileResults` | HTML list of all profile results | HTML |
| `GET`  | `/profileResults/:profileId` | HTML list of results for one profile (id or name) | HTML |
| `GET`  | `/api/productResolvers` | List available product resolvers + the active one | JSON |
| `POST` | `/api/receipts/:id/profileResults/:profileId/resolveProducts` | Resolve products from a profile result (`?dryRun=1`, `?async=1`) | JSON / `202` |
| `GET`  | `/api/receipts/:id/products` | List product results for a receipt | JSON array |
| `GET`  | `/api/receipts/:id/products/:profileId` | Products for one source profile (id or name) | JSON |
| `GET`  | `/receipts/:id/products/:profileId/view` | HTML view of resolved products | HTML |
| `GET`  | `/api/products` | List **all** product results across every receipt | JSON array |
| `GET`  | `/api/products/events` | Recent per-lookup events (cache hit/miss/empty/error) + summary stats (`?limit=`) | JSON |
| `GET`  | `/api/products/cache/stats` | Count of entries in the shared product cache | JSON |
| `GET`  | `/api/products/cache/export` | Export the product cache as a portable JSON document | JSON |
| `POST` | `/api/products/cache/import` | Import a cache export (or bare entries array); `?flush=1` clears first | JSON |
| `GET`  | `/products` | HTML list of all product results | HTML |
| `GET`  | `/products/monitor` | Live, auto-refreshing technical console for lookups & cache hits (`?interval=<sec>`) | HTML |
| `GET`  | `/observe/cache/products` | Alias for `/products/monitor` (same page; `?interval=<sec>`, trailing `s` ok) | HTML |

The profile endpoints are documented in **[Receipt Profiles](#receipt-profiles)** below;
the product endpoints in **[Products](#products)**.

### `GET /health`

```bash
curl -fsS "$BASE/health" | jq .
```
```json
{
  "status": "ok",
  "redis": "up",
  "persistence": "sqlite",
  "ocrProvider": "vision",
  "enrichment": "disabled",
  "tenants": 1,
  "defaultTenant": "main",
  "receiptProfiles": 1,
  "products": { "enabled": true, "resolver": "anthropic" },
  "time": "2026-06-03T20:00:00.000Z"
}
```
Returns `200` when Redis is reachable, `503` (`status: "degraded"`) otherwise.
`receiptProfiles` counts the **default tenant's** profiles. `persistence` reports
the active durable-record backend (`filesystem` \| `sqlite` \| `postgresql`).

### Tenant accounts

Tenants are explicitly provisioned (an upload for an unknown tenant is rejected).
Provisioning also seeds the tenant's example profiles and makes the worker start
consuming its queue. The default tenant is auto-provisioned at boot.

```bash
curl -fsS "$BASE/api/tenants" | jq .
# { "default": "main", "tenants": ["acme", "main"] }

curl -fsS -X POST "$BASE/api/tenants" -H 'content-type: application/json' -d '{"tenantId":"acme"}'
# 201 { "tenantId": "acme", "created": true, "seededProfiles": 2 }   (200/created:false if it already existed)
```

A `tenantId` must match `[A-Za-z0-9_-]{1,64}` or the call returns `400`. The CLI
wraps this: `receipts tenant create acme` / `receipts tenant list`.

### `POST /api/receipts`

Multipart upload. The file field may be named **`receipt`** (preferred),
`file`, or `image`. Optional text field `source` tags the origin (`api`, `cli`,
`telegram`, …). Max size: `MAX_UPLOAD_MB` (default 15 MB). Only `image/*` types
are accepted.

The owning identity comes from the `X-Tenant-Id` / `X-User-Id` headers (or
`tenantId`/`userId` form fields), defaulting to `DEFAULT_TENANT_ID`/
`DEFAULT_USER_ID`. The returned `id` is the **composite** id
`"<tenant>:<user>:<cacheId>"`. An unknown (unprovisioned) tenant returns `400`.

Optional text field **`profileId`** (a profile id or name) applies a
[Receipt Profile](#receipt-profiles) right after OCR — the worker runs the
pipeline first, then the profile, wired with a BullMQ flow (`process-receipt`
child → `applyProfile` parent). An unknown profile returns `400`. A server-wide
default can be set with `DEFAULT_PROFILE_ID`; it applies when `profileId` is
omitted.

When a profile is applied, **[Products](#products)** are resolved by default as a
third pipeline stage (OCR → profile → products), wired as a 3-level BullMQ flow
(`process-receipt` → `applyProfile` → `resolveProducts`). Opt out per-upload with
text field **`resolveProducts=0`**. Products require a profile, so an upload with
no `profileId` (and no `DEFAULT_PROFILE_ID`) is OCR-only and resolves nothing.

```bash
curl -fsS \
  -F "receipt=@/path/to/receipt.jpg" \
  -F "source=curl" \
  -F "profileId=usGrocery1" \
  "$BASE/api/receipts"
```
```json
{
  "id": "main:main:1b70d95bbd9f462f",
  "status": "queued",
  "profileId": "rp_9f3c1a2b4d5e6f70",
  "profileResultUrl": "http://localhost:8080/api/receipts/main:main:1b70d95bbd9f462f/profileResults/rp_9f3c1a2b4d5e6f70",
  "productsUrl": "http://localhost:8080/api/receipts/main:main:1b70d95bbd9f462f/products/rp_9f3c1a2b4d5e6f70",
  "statusUrl": "http://localhost:8080/api/receipts/main:main:1b70d95bbd9f462f",
  "viewUrl": "http://localhost:8080/receipts/main:main:1b70d95bbd9f462f/view"
}
```
Responds `202 Accepted` immediately; processing happens asynchronously. Without
a `profileId`, `profileId`/`profileResultUrl`/`productsUrl` are `null`; with one
but `resolveProducts=0`, `productsUrl` is `null`. Poll `statusUrl` until `status`
is `done`, then read `profileResultUrl` for the canonicalized result and
`productsUrl` for the resolved products.
Errors: `400` (no/invalid image, or unknown profile), `413` (too large).

### `GET /api/receipts/:id`

```bash
curl -fsS "$BASE/api/receipts/1b70d95bbd9f462f" | jq .
```
```json
{
  "id": "1b70d95bbd9f462f",
  "status": "done",
  "source": "seed",
  "store": { "name": "Costco Wholesale", "date": "2026-05-26" },
  "items": [
    { "description": "KS WATER GAL", "sku": "931484", "qty": 1,
      "unitPrice": 4.99, "price": 4.99, "enrichment": null },
    { "description": "US WAGYU BEEF", "sku": "1455728", "qty": 1,
      "unitPrice": 19.99, "price": 19.99, "enrichment": null }
  ],
  "totals": { "subtotal": null, "tax": null, "total": null,
              "itemCount": 14, "sumOfItems": 120.11 },
  "summary": "Costco Wholesale: 14 item(s), total $120.11 (summed from items). 0 item(s) matched with images/metadata.",
  "extraction": { "provider": "vision" },
  "statusUrl": "http://localhost:8080/api/receipts/1b70d95bbd9f462f",
  "viewUrl": "http://localhost:8080/receipts/1b70d95bbd9f462f/view"
}
```
Returns `404` if the id is unknown. When `enrichment` ran, each item also carries
`{ imageUrl, title, snippet, url, ... }`.

### `GET /api/receipts` — a page of the books

Newest first, by the day **on** the receipt rather than the day it was read (see
`byRecency` in `src/store.js`). `?limit=` caps at 500 and defaults to 50.

```bash
curl -fsS "$BASE/api/receipts?limit=20" \
  | jq '.[] | {id, status, store: .store.name, itemCount, createdAt}'
```

`itemCount` is **`null`**, not `0`, for a receipt nobody has read yet. Zero is a
claim about a basket — *there was nothing in it* — and nothing has opened this
one; a caller handed `0` cannot tell the two apart.

#### Narrowing it

Repeated keys for the multiple-choice groups, because that is what a GET form of
checkboxes submits; a bare pair per range.

| parameter | what it narrows to |
|---|---|
| `store=` (repeatable) | `store.name`, exactly |
| `source=` (repeatable) | how it arrived — `telegram`, `sync`, `api`, `cli`, `seed` |
| `status=` (repeatable) | `queued` · `processing` · `done` · `failed` |
| `from=` / `to=` | `YYYY-MM-DD`, inclusive, against the **same day the sort uses** |
| `amt_min=` / `amt_max=` | the printed total, or the items summed when none was printed |
| `items_min=` / `items_max=` | how many line items |
| `offset=` | how many matching receipts to skip |

```bash
# Everything from Aldi over $50, second page of 24
curl -fsS "$BASE/api/receipts?store=Aldi&amt_min=50&limit=24&offset=24" | jq length
```

Two rules a caller must not re-implement differently, both of them recorded in
`../recibbi-ux-design-atlas/docs/porting.md` after they were real bugs:

1. **A range that is not set is not a range.** `amt_min=0` with no max is *not*
   "everything" — a range tests a number, and a receipt still being read has
   none, so applying one drops every in-flight receipt. Send neither end rather
   than both ends at their bounds.
2. **An unreadable filter is ignored, not rejected.** `amt_min=banana` is no
   filter and a `200`. 400-ing a member out of their own receipts over a
   malformed parameter would be the wrong trade.

#### `?envelope=1` — the page, and what it is a page **of**

```bash
curl -fsS "$BASE/api/receipts?envelope=1&limit=24&store=Aldi" | jq '{total, matched, more}'
```
```json
{
  "records": [ /* card rows — see below */ ],
  "total": 1284,
  "matched": 127,
  "limit": 24,
  "offset": 0,
  "more": true,
  "facets": {
    "counts":  { "store": { "Aldi": 127, "Costco Wholesale": 287 },
                 "source": { "telegram": 744, "sync": 540 },
                 "status": { "done": 1273, "failed": 9 } },
    "options": { "store": ["Aldi", "Costco Wholesale"],
                 "source": ["sync", "telegram"],
                 "status": ["done", "processing", "queued", "failed"] },
    "bounds":  { "amount": { "lo": 0, "hi": 290 }, "items": { "lo": 0, "hi": 17 } },
    "days":    { "from": "2021-06-17", "to": "2026-09-11" },
    "pending": 11
  }
}
```

**`total` and `matched` are the point of it, and neither is `records.length`.**
`total` is the books, `matched` is what the filters leave, and the length of the
array is how far the caller has paged. A list heading that counts the rows it
was handed tells a member with 1,284 receipts that 1,260 of them have gone
missing, and then changes its mind as they scroll.

**The facets describe the books, not the page.** Every count is taken with the
*other* groups applied and its own ignored — count `store` with the store filter
applied to itself and every unticked box reads `0`, which says nothing about
what ticking it would do. `options` is a `DISTINCT` per group, so a member who
has never used Telegram is never offered a Telegram box. `pending` counts the
receipts carrying no numbers yet, which is how a caller explains a range that
returned nothing.

**The row is fatter under `envelope=1`.** The bare array keeps its summary shape
(`id`, `status`, `store`, `itemCount`, `createdAt`, links); the envelope's rows
add what a list card actually draws — `source`, `kind`, `items` with their
enrichment, `totals`, `reconciled`, `retailer`, `orderId`, `summary`, `error`,
`extraction.provider`, and `image` as a **boolean** (whether there *is* a photo,
which decides whether a card offers one; the filename is internal). It leaves
out `extraction.rawText`, the blob descriptor and `timings` — a page of 24
should not carry a megabyte of OCR text nobody will render.

> **Why the envelope is opt-in.** The bare array is what the CLI and
> `recibbi-ux-main` are pointed at, and it is unchanged. Without `envelope=1`
> the filters and `offset` still apply — a narrowed array is still an array —
> but the counts and facets have nowhere to go.

> **What this costs today.** Both persistence backends store receipts as opaque
> JSON documents, so there is nothing to filter, order or count on but the
> records themselves: every call reads all of the identity's receipts, sorts,
> filters and counts in memory. That is honest at a few thousand and is the
> reason `limit` is capped. The fix when it is needed is indexed columns beside
> the JSON — see `TODO(index)` on `store.query()`.

### `GET /receipts/:id/view` and `/receipts/:id/image`

`/view` returns the styled HTML page (open it in a browser). `/image` streams
the original photo with its stored content type.

### `POST /api/retailer:<retailerId>/receipts`

Ingest a receipt the retailer already has — the JSON its own order API returns —
instead of a photo. These **skip OCR entirely**: a per-retailer adapter
normalizes the payload into the same canonical shape the photo path produces, so
profiles, products, the views and the queue are all shared. Full design:
**[docs/RETAILER-INGEST.md](RETAILER-INGEST.md)**.

The retailer id is in the path because it selects the *schema the body is read
against*. `GET /api/retailers` lists the ids a deployment accepts (aliases work:
`samsclub`, `Sam's Club`, `samsclub.com`).

Two body encodings:

```bash
# the payload as the request body
curl -X POST "$BASE/api/retailer:samsclub.com/receipts" \
  -H 'content-type: application/json' \
  --data-binary @00769925960064747015.json

# or as a multipart .json file, like a photo upload
curl -X POST "$BASE/api/retailer:samsclub.com/receipts?enrich=1" \
  -F 'receipt=@00769925960064747015.json;type=application/json' \
  -F 'source=sync'
```

Options (query params or form fields): `profileId`, `resolveProducts`, `source`,
`tenantId`, `userId` — same as `/api/receipts` — plus:

| option | default | meaning |
|--------|---------|---------|
| `enrich` | `0` (`RETAILER_ENRICH_DEFAULT`) | Tavily image/metadata lookup. Off because a retailer payload already carries product names and its own thumbnails |
| `dedupe` | `1` (`RETAILER_DEDUPE`) | re-posting an order id already ingested returns the existing receipt instead of a duplicate |

```jsonc
// 202 Accepted
{
  "id": "main:main:9f2c…",
  "status": "queued",
  "retailer": "samsclub.com",
  "orderId": "00769925960064747015",
  "displayId": "0076 9925 9600 6474 7015",
  "enrich": false,
  "profileId": null,
  "statusUrl": "http://localhost:8080/api/receipts/main:main:9f2c…",
  "viewUrl": "http://localhost:8080/receipts/main:main:9f2c…/view"
}
```

| status | when |
|--------|------|
| `202` | accepted and queued |
| `200` | this order was already ingested — body carries `duplicateOf` |
| `400` | unknown retailer, payload not recognized for that retailer, invalid JSON, unknown tenant/profile |
| `413` | payload over `RETAILER_MAX_PAYLOAD_MB` |

The record it creates is an ordinary receipt with three extra fields — `kind:
"json"`, `retailer`, and `document` (the payload blob, the counterpart of
`image`) — so `GET /api/receipts/:id`, the list, the views, profiles and products
all work unchanged. The stored payload is served at `/receipts/:id/payload`.

---

## End-to-end walkthrough (curl)

Process a receipt, open the page, then pull the other representations.

```bash
BASE=http://localhost:8080
IMG=../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-original.jpg   # any receipt photo (JPEG/PNG)

# 1. Is the API up?
curl -fsS "$BASE/health" | jq .

# 2. Upload — capture the new id from the 202 response
ID=$(curl -fsS -F "receipt=@$IMG" -F "source=curl" "$BASE/api/receipts" | jq -r .id)
echo "receipt id: $ID"

# 3. Poll until processing finishes (done or failed)
until s=$(curl -fsS "$BASE/api/receipts/$ID" | jq -r .status); \
      [ "$s" = "done" ] || [ "$s" = "failed" ]; do
  printf '  status: %s\r' "$s"; sleep 2;
done
echo "final status: $s"

# 4. Open the human-readable view in your browser
open    "$BASE/receipts/$ID/view"   # macOS
# xdg-open "$BASE/receipts/$ID/view" # Linux

# 5. Fetch the structured JSON
curl -fsS "$BASE/api/receipts/$ID" | jq '{store: .store.name, items: (.items|length), summary}'

# 6. Save the original photo
curl -fsS "$BASE/receipts/$ID/image" -o "receipt-$ID.jpg"
echo "saved receipt-$ID.jpg"

# 7. See it in the list
curl -fsS "$BASE/api/receipts" | jq '.[] | {id, status, store: .store.name, itemCount}'
```

If you only want to **view an already-processed receipt** (no upload), skip to
steps 4–6 with a known `ID` — those work even when Redis isn't running.

---

## CLI shortcut

The bundled bash CLI wraps these calls (no Node required — just `curl`, plus
`jq` for pretty output):

```bash
./cli/receipts health
./cli/receipts upload "$IMG" --wait     # upload + poll, prints the view URL
./cli/receipts status <id>              # full JSON record
./cli/receipts list                     # recent receipts
./cli/receipts view <id>                # print + open the web view
```

Point it at another host with `API_URL=http://my-host:8080 ./cli/receipts …`.

---

## Receipt Profiles

A **receipt profile** canonicalizes a parsed receipt — normalizing store names,
date formats, and item descriptions, and folding per-item discount lines into the
item they apply to — by running a **transformer** (a small TypeScript/JavaScript
module shipped with the app). You apply a profile to an
already-processed receipt; the original record is never modified, and the result
(plus an auto-derived change log) is stored separately. Design details:
[`docs/RECEIPT-PROFILES.md`](RECEIPT-PROFILES.md).

- A **profile** is metadata: `{ name, description, transformer, config }`. It
  binds a name to a transformer id and an optional `config` object.
- A **transformer** is code under `src/receiptProfiles/transformers/`, referenced
  by id (filename without extension). Transformers are **not** uploaded via the
  API — there is no remote code execution.

### Transformers

```bash
curl -fsS "$BASE/api/transformers" | jq .
```
```json
[ { "id": "usGrocery", "name": "usGrocery", "version": 1,
    "description": "Normalize common US grocery receipts …" },
  { "id": "tesseractGroceryUs", "name": "tesseractGroceryUs", "version": 1,
    "description": "Clean up noisy Tesseract OCR output for US grocery receipts …" } ]
```

`usGrocery` also **folds per-item discounts** into the item they apply to, so the
net price shows on one row instead of a separate negative line. Association is
store-specific: at **Costco** the discount line sits next to its item and
references the item's SKU (e.g. `Discount 975416`); at **Sam's Club** a single
`Instant Savings` line is printed at the bottom and names the item
(`Dog Chow (Inst Sv)`). The folded amount is recorded on the item's `discount`
field and surfaced in the HTML view; a discount that can't be matched is left as
its own line rather than guessed onto the wrong item.

`tesseractGroceryUs` is a derivative of `usGrocery` tuned for the offline
**Tesseract** pipeline: it strips OCR junk + the embedded SKU code, Title-Cases
item names, expands common abbreviations, and infers the store from Kirkland
items. Use it when receipts are processed with `OCR_PROVIDER=tesseract`.

### Profile CRUD

```bash
# Create — body is the profile metadata (transformer must be a known id)
curl -fsS -X POST "$BASE/api/receiptProfiles" -H 'content-type: application/json' -d '{
  "name": "usGrocery1",
  "description": "Normalize US grocery receipts",
  "transformer": "usGrocery",
  "config": {}
}'
```
```json
{
  "id": "rp_9f3c1a2b4d5e6f70",
  "name": "usGrocery1",
  "description": "Normalize US grocery receipts",
  "version": 1,
  "transformer": "usGrocery",
  "config": {},
  "createdAt": "2026-06-04T18:20:00.000Z",
  "updatedAt": "2026-06-04T18:20:00.000Z"
}
```

Other operations (`:id` accepts the profile **id or name**):

```bash
curl -fsS "$BASE/api/receiptProfiles"                 # list (summaries)
curl -fsS "$BASE/api/receiptProfiles/usGrocery1"      # one (id or name)
curl -fsS -X PUT "$BASE/api/receiptProfiles/usGrocery1" \
  -H 'content-type: application/json' -d @profile.json # replace (bumps version)
curl -fsS -X DELETE "$BASE/api/receiptProfiles/usGrocery1"   # -> 204
```

A shipped example profile (`usGrocery1` → the `usGrocery` transformer) is seeded
on first boot. Validation errors return `400` with a `details` array:

```json
{ "error": "profile validation failed",
  "details": ["unknown transformer \"foo\"; available: usGrocery"] }
```

### Apply a profile

```bash
# Apply to an already-processed receipt; persists the result.
curl -fsS -X POST "$BASE/api/receipts/$ID/applyProfile/usGrocery1" | jq .
```
```json
{
  "receiptId": "1b70d95bbd9f462f",
  "profileId": "rp_9f3c1a2b4d5e6f70",
  "profileName": "usGrocery1",
  "profileVersion": 1,
  "transformer": "usGrocery",
  "appliedAt": "2026-06-04T18:20:05.000Z",
  "dryRun": false,
  "store":  { "name": "Costco", "date": "05-26-2026" },
  "items":  [ { "description": "Water 5 Liter", "price": 4.99, … }, … ],
  "totals": { "itemCount": 14, "sumOfItems": 125.11, "subtotalMatch": null, … },
  "changes": [
    { "field": "store.name", "from": "Costco Wholesale", "to": "Costco" },
    { "field": "item.description", "itemIndex": 0, "from": "KS Water Gal", "to": "Water 5 Liter" }
  ]
}
```

Add `?dryRun=1` to run the transform and return the result **without** persisting
it (handy for trying a profile). Errors: `404` (unknown receipt or profile),
`422` (the profile's transformer is no longer available).

Add `?async=1` to apply the profile **in the background** via a BullMQ
`applyProfile` job instead of inline. It validates the receipt/profile, returns
`202` with `{ receiptId, profileId, status: "queued", profileResultUrl }`, and
the result appears at `profileResultUrl` once the worker finishes:

```bash
curl -fsS -X POST "$BASE/api/receipts/$ID/applyProfile/usGrocery1?async=1" | jq .
```
```json
{
  "receiptId": "1b70d95bbd9f462f",
  "profileId": "rp_9f3c1a2b4d5e6f70",
  "status": "queued",
  "profileResultUrl": "http://localhost:8080/api/receipts/1b70d95bbd9f462f/profileResults/rp_9f3c1a2b4d5e6f70"
}
```

### Read results

```bash
curl -fsS "$BASE/api/receipts/$ID/profileResults"               # all results
curl -fsS "$BASE/api/receipts/$ID/profileResults/usGrocery1"    # one (id or name)
open "$BASE/receipts/$ID/profileResults/usGrocery1/view"        # HTML, discounts folded in
```

The `…/view` endpoint renders the profile-applied receipt as HTML — discounts
fold into their line item (with the pre-discount price struck through). It shows
the stored result when present, otherwise computes it on the fly (no persistence).

### Browse results across receipts

The endpoints above are scoped to one receipt. To see results **across all
receipts** — e.g. every receipt cleaned by a given transformer profile — use the
cross-receipt endpoints (results are sorted newest-first by `appliedAt`):

```bash
curl -fsS "$BASE/api/profileResults"                  # every result, all receipts
curl -fsS "$BASE/api/profileResults/usGrocery1"       # only this profile (id or name)
open "$BASE/profileResults"                            # HTML list of all results
open "$BASE/profileResults/usGrocery1"                 # HTML list filtered to one profile
```

The `:profileId` accepts a profile **id or name** (a name is resolved to its id,
which is how results are keyed). An **unknown profile returns an empty array**
(`200`), not `404`, so results from a since-deleted profile stay reachable by
their raw `rp_…` id. The HTML list at `/profileResults` links each row to its
per-result `…/view`; the profile badge on each row links to that profile's
filtered list.

> Profile definitions are durable JSON per tenant under
> `DATA_DIR/<tenant>/receiptProfiles/`; results are per tenant/user under
> `DATA_DIR/<tenant>/<user>/profileResults/<cacheId>/`. Applying a profile is **synchronous by
> default** (the transform is pure and fast); pass `?async=1` to run it on the
> worker, or set a `profileId` at upload time to chain it after OCR via a flow.

---

## Products

The final pipeline stage maps each cleaned line item from a **profile result**
to product information (a product title, description, and the top web link that
substantiates it). The backend is a configurable **resolver** (an adapter)
chosen by `PRODUCT_RESOLVER` — like `OCR_PROVIDER` picks the OCR engine, not a
per-receipt record. The shipped resolver, `anthropic`, calls a low-end Anthropic
model (`claude-haiku-4-5` by default) and — when `PRODUCT_ANTHROPIC_WEB_SEARCH`
is on (default) — grounds the link with Anthropic's server-side web search.

Resolution always runs **after a receipt profile has been applied** (it reads
the profile result's items) and is keyed by the source `receiptProfileId`.

### Available resolvers

```bash
curl -fsS "$BASE/api/productResolvers" | jq .
# { "active": "anthropic", "resolvers": [ { "id": "anthropic", "name": "..." } ] }
```

### Resolve products

```bash
# Sync (default). ?dryRun=1 resolves without persisting; ?async=1 queues it (202).
curl -fsS -X POST "$BASE/api/receipts/$ID/profileResults/usGrocery1/resolveProducts" | jq .
```
```json
{
  "receiptId": "1b70d95bbd9f462f",
  "receiptProfileId": "rp_9f3c1a2b4d5e6f70",
  "receiptProfileName": "usGrocery1",
  "resolver": "anthropic",
  "model": "claude-haiku-4-5",
  "resolvedAt": "2026-06-06T20:00:00.000Z",
  "store": { "name": "Costco", "date": "2026-05-26" },
  "products": [
    {
      "lineItem": { "description": "KS SPARK WAT", "sku": "1234567", "qty": 1, "unitPrice": 4.99, "price": 4.99 },
      "productTitle": "Kirkland Signature Sparkling Water",
      "productDescription": "Costco house-brand sparkling water, ...",
      "productUrl": "https://www.costco.com/...",
      "brand": "Kirkland Signature",
      "category": "Beverages",
      "emoji": "🥤",
      "confidence": 0.82,
      "error": null
    }
  ],
  "stats": { "resolved": 1, "skipped": 0, "cached": 0, "errors": 0 }
}
```

Errors: `404` (unknown receipt/profile), `409` (the profile has not been applied
to this receipt yet — apply it first). When products are disabled or the resolver
isn't configured (no API key), resolution degrades gracefully: items list with
null product fields and `stats.skipped`.

Per-item lookups run in a bounded parallel pool (`PRODUCT_CONCURRENCY`) and are
fronted by a shared, Redis-backed cache keyed by resolver + store + sku +
description (`PRODUCT_CACHE_ENABLED`, `PRODUCT_CACHE_TTL_SECONDS`). The cache is
shared across all worker/server processes, so a product seen on an earlier
receipt (or in another session) is served without a backend call. `stats.cached`
is a sub-count of `stats.resolved` reporting how many came from the cache
(`resolved + skipped + errors` still equals the item count).

Each resolved product also carries an `emoji` — a single emoji depicting the
product (e.g. `🥚` for Kirkland eggs), requested in the same lookup call and
rendered in the product view's image placeholder. It's on by default and
optional: set `PRODUCT_EMOJI_ENABLED=0` and the resolver neither asks for nor
stores an emoji (`emoji` is then `null`).

### Read products

```bash
curl -fsS "$BASE/api/receipts/$ID/products"               # all product results for a receipt
curl -fsS "$BASE/api/receipts/$ID/products/usGrocery1"    # one (source profile id or name)
open  "$BASE/receipts/$ID/products/usGrocery1/view"        # HTML
curl -fsS "$BASE/api/products"                             # every product result, all receipts
open  "$BASE/products"                                      # HTML list of all product results
```

> Product results are durable JSON under `DATA_DIR/<tenant>/<user>/products/<cacheId>/`. Unlike
> the profile view, the HTML product view renders only a **stored** result (it
> won't resolve fresh on a miss, since resolution makes live backend calls).
> Configure with `PRODUCT_RESOLVER`, `PRODUCT_ANTHROPIC_MODEL`,
> `PRODUCT_ANTHROPIC_WEB_SEARCH`, `PRODUCT_MAX_ITEMS`, `PRODUCT_CONCURRENCY`,
> `PRODUCT_CACHE_ENABLED`, `PRODUCT_CACHE_TTL_SECONDS`, `PRODUCT_RESOLVE_ON_UPLOAD`,
> `PRODUCT_EMOJI_ENABLED`, `PRODUCTS_ENABLED` (see the README Configuration reference).

### Live lookup monitor

`GET /products/monitor` is a self-contained, dark technical console that tails
product lookups in near real time. It polls `GET /api/products/events` on an
interval (`?interval=<sec>`, default 5) and streams each lookup as a row,
autoscrolling like a log tail. **Cache hits are made obvious**: a green-tinted
row, a `⚡ CACHE HIT` badge, a sub-millisecond latency cell, and a live
**hit-rate** / **backend-calls-avoided** readout in the header.

```bash
open "$BASE/products/monitor"            # the console
curl -fsS "$BASE/api/products/events?limit=50" | jq '.stats'
# { "total": 12, "hits": 7, "misses": 5, "empty": 0, "errors": 0,
#   "hitRate": 0.58, "avgMissLatencyMs": 840, "estSavedMs": 5880 }
```

Each event is `{ seq, ts, outcome: "hit"|"miss"|"empty"|"error", latencyMs,
store, sku, description, productTitle, confidence, cacheKey, receiptId, model,
dryRun }`. The feed is a Redis-backed ring buffer (`PRODUCT_EVENTS_MAX` entries,
default 500) shared across worker/server processes — so the worker's resolutions
show up on the server-rendered page. Set `PRODUCT_EVENTS_MAX=0` to disable
instrumentation.

### Products cache (export / import)

The per-SKU product cache is shared Redis state. These endpoints snapshot it to
a portable JSON document and restore it — useful to **seed a known cache before
an acceptance run** so SKU lookups are served from cache instead of live
Anthropic calls (a parallel, offline path to the resolver). The monitor's event
log is never included. Driven by the **`products` CLI** (`cli/products`):

```bash
products cache export cache.json          # GET  /api/products/cache/export -> file
products cache import cache.json [--flush] # POST /api/products/cache/import (?flush=1)
products cache stats                       # GET  /api/products/cache/stats
```

The export document is `{ type: "receipt-enricher/products-cache", version: 1,
exportedAt, resolver, count, entries: [ { key, value, ttlSeconds } ] }`. Import
accepts that document **or** a bare `entries` array; entries whose key isn't a
`products:` cache key (and the reserved `products:events*` keys) are skipped, and
a missing `ttlSeconds` falls back to `PRODUCT_CACHE_TTL_SECONDS`. Response:
`{ imported, skipped, flushed, total }`.

---

## Notes

- **Enrichment** (per-item images/metadata via Tavily) only runs when
  `TAVILY_API_KEY` is set; otherwise items list cleanly with no `imageUrl`.
- **Extraction quality**: a vision model (`ANTHROPIC_API_KEY` /
  `VISION_PROVIDER=openai`) reads layout and returns clean items; with no key it
  falls back to offline Tesseract OCR (best on an upright, sharp photo).
- **No HEIC**: convert iPhone HEIC photos to JPEG/PNG before uploading.
- The id is the composite `"<tenant>:<user>:<cacheId>"` (the `cacheId` is a
  16-char hex token); records are durable JSON files under
  `DATA_DIR/<tenant>/<user>/`.
