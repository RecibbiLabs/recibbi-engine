# Retailer JSON ingest

A second way into the same pipeline. Instead of a photo of a receipt, the engine
accepts the **receipt a retailer already has** — the JSON its own order API
returns, collected by a sync tool and posted verbatim.

```
POST /api/retailer:samsclub.com/receipts
```

Structured input is not a shortcut past the pipeline; it replaces exactly one
stage of it. Everything after extraction — enrichment, summary, receipt
profiles, product resolution, the queue, multi-tenancy, the web views — is the
code that was already there.

---

## 1. The one structural change

The pipeline's first stage used to be "OCR the bytes, then parse the text". It is
now **extraction**, with two implementations chosen by the receipt's `kind`:

```
                      ┌─────────────────────────────────────────┐
  kind: 'image'       │ ① EXTRACT                               │
  ─────────────────►  │   ocr.extract(record)   [vision|tesseract│
  a photo             │        │                 |paddle sidecar]│
                      │        ▼                                │
                      │   parse.parseText / normalizeStructured  │
                      │        │                                │
  kind: 'json'        │        │   retailers/ingestService       │
  ─────────────────►  │        │     └► adapters/<retailer>.js   │
  a retailer payload  │        │           .normalize(payload)   │
                      │        ▼           ▼                    │
                      │   { store, items, totals }  ◄── canonical│
                      └────────────────┬────────────────────────┘
                                       │
                      ┌────────────────▼────────────────────────┐
                      │ ② persist  ③ enrich (optional)  ④ summarize
                      │ ⑤ profiles ⑥ products      — all shared │
                      └─────────────────────────────────────────┘
```

Both branches produce the same `{ store, items, totals }`, built through the same
`finalize()` in [`src/parse/receiptParser.js`](../src/parse/receiptParser.js), so
`itemCount`, `sumOfItems` and `subtotalMatch` mean the same thing however the
receipt arrived. Nothing downstream of stage ① knows which branch ran.

**The queue is untouched.** A JSON receipt is enqueued as the same
`process-receipt` job, on the same per-tenant queue, in the same three flow
shapes (extraction alone / + profile / + profile + products). The worker's
dispatcher did not change at all — the pipeline picks its branch from the record.

---

## 2. Why the retailer is in the path

```
/api/retailer:samsclub.com/receipts
```

The retailer id selects the **schema the body is read against**. `samsclub.com`
and `costco.com` post structurally unrelated documents to the same verb, so this
is closer to a content type than to a filter, and a client should not be able to
mismatch them silently. Putting it in the path also makes a mis-routed payload a
`400` at the door rather than a job that fails three times with the answer.

The id is resolved through a `Map` in
[`src/retailers/registry.js`](../src/retailers/registry.js). It never becomes a
module path or a filesystem path, and nothing evals request input — the same
posture as the transformer and product-resolver registries it mirrors.

Ids resolve case- and punctuation-insensitively, so `samsclub.com`, `SamsClub`,
`sams-club` and `Sam's Club` all reach one adapter. `GET /api/retailers` lists
what a deployment can read.

---

## 3. The adapter contract

An adapter is a code module shipped with the app under
`src/retailers/adapters/`, exporting:

| export | when it runs | what it must do |
|---|---|---|
| `id`, `aliases`, `meta` | load | identify itself |
| `detect(payload)` | **at upload**, synchronously | cheap "is this plausibly ours?" — permissive about missing halves, strict about markers unique to the retailer |
| `normalize(payload, ctx)` | **in the worker** | full extraction into the canonical shape; must not throw on a partial payload — degrade and warn |

`normalize` returns `{ store, items, totals, source, warnings }`:

- **`store.name` is the canonical chain** (`"Sam's Club"`), matching
  [`store-aliases.json`](../src/parse/store-aliases.json), so a synced receipt
  groups with a photographed one from the same chain. The specific branch goes on
  `store.branch`.
- **`items`** carry the five canonical fields every consumer relies on
  (`description`, `sku`, `qty`, `unitPrice`, `price`, `enrichment: null`) plus any
  number of additive retailer fields (`skuKind`, `measuredQty`, `unit`,
  `informational`, `returned`, `addOnOf`, …). Additive fields are safe: the
  profile engine diffs them, the views ignore what they do not know.
- **`warnings`** are how an adapter says what the payload lacked — a half-present
  order, an unmodelled charge, a returned line. They land on
  `record.extraction.warnings` rather than failing the job, because a receipt
  that does not add up is a **finding**, not an error.
- **`source`** is provenance: order id, channel, tender, `externalId`. Adapters
  do not copy personal data out of the payload.

The full contract, with commentary, is in
[`src/retailers/adapters/types.js`](../src/retailers/adapters/types.js).

### Adding a retailer

1. Write `src/retailers/adapters/<domain>.js` against the contract.
2. Write down what the payload actually is, the way
   [`samsclub-receipt-schema.md`](samsclub-receipt-schema.md) does — the adapter is
   only as good as that document.
3. Add scrubbed fixtures under `test/fixtures/retailers/<name>/` and a test file
   that asserts one documented claim per test.

No registration step: the registry scans the directory.

---

## 4. What the Sam's Club adapter has to get right

Every one of these is a real trap documented in
[`samsclub-receipt-schema.md`](samsclub-receipt-schema.md) and covered by a test
in `test/retailers-samsclub.test.js`:

| trap | what a naive reader does | what the adapter does |
|---|---|---|
| items appear **twice** | reads `groups_2101[].items[]` | reads `categories[].items[]`, the only copy with unit prices |
| `quantity` is 1 on weighed lines | computes `unitPrice = price / qty` | takes `priceInfo.unitPrice` from the payload; parses `"1.66 lb"` for the measure |
| add-ons are nested | walks items only | flattens them — they are counted in `subTotal`, so the receipt would not add up |
| `itemCount` is a display figure | trusts it | counts the items; keeps theirs as `reportedItemCount` |
| `savings` is positive | adds it | subtracts it |
| `groups_2101` is version-suffixed | reads the literal key | matches `groups_<n>`; a missing key means *detail unavailable*, not *no items* |
| voided zero-cost rows | drops them | keeps them, flagged `informational` |
| returned lines | treats the price as refunded | keeps the original price, flags the line, warns |

It reports the payload's **two independent money checks separately**, because
collapsing them tells you a receipt is wrong without telling you whose problem it
is:

```
items:  Σ line prices (add-ons included)   ==  subTotal   →  totals.subtotalMatch
total:  subTotal + fees − savings + tax    ==  grandTotal →  totals.totalMatch
```

A failed **items** check means the engine is missing data. A failed **total**
check means the payload is.

---

## 5. Enrichment is optional here

A photographed receipt is enriched because that lookup is where its product
images come from. A retailer payload already carries clean product names and its
own thumbnails, so the same lookup mostly re-buys what was given for free.

Enrichment is therefore **per receipt**, decided at upload and stored on the
record as `options.enrich`:

| path | default | override |
|---|---|---|
| `POST /api/receipts` (photo) | on | `enrich=0` |
| `POST /api/retailer:<id>/receipts` | **off** (`RETAILER_ENRICH_DEFAULT`) | `?enrich=1` |

A record with no `options` block — every receipt written before this existed —
enriches, exactly as it always did.

---

## 6. Storage and provenance

A JSON receipt's payload is its blob, the way a photo is a photo receipt's blob:
written to `<dataDir>/<tenant>/<user>/uploads/<cacheId>.json` at upload, read by
the worker, served back at `/receipts/:id/payload`.

Keeping it means a receipt can be **re-normalized** when its adapter improves,
without re-fetching from the retailer. It also means personal data sits on disk:
Sam's Club payloads carry the member's name, address, phone, email and card
last-4, none of which the normalized receipt copies. `RETAILER_STORE_RAW_PAYLOAD=0`
deletes the payload once the receipt is `done`, leaving the normalized record and
a `document.discarded` marker.

The record grows three fields; the rest is the receipt record that was already
there.

| field | |
|---|---|
| `kind` | `'image'` \| `'json'` — which extraction branch runs. Absent means `'image'` |
| `retailer` | the adapter id |
| `document` | the payload blob descriptor, the counterpart of `image` |
| `origin` | `{ orderId, displayId, externalId }`, peeked at upload |

---

## 7. Idempotency

A sync tool replays its history; the same order arrives more than once. A
photographed receipt has no stable external identity, but a retailer payload does
— its order id — so re-posting one returns **`200` with the receipt that already
exists** instead of `202` and a duplicate.

The index (`<tenant>:<user>:ingest:ext:<retailer>:<orderId>` → receipt id) lives
in Redis, not in the durable store, because it is an optimization rather than a
constraint: an eviction degrades to the old behavior — a second record — instead
of losing data or blocking an upload. It is scoped per tenant **and** user, so
two members who bought the same order id keep their own receipts.

`?dedupe=0` forces a fresh ingest.

---

## 8. Request shapes

Both encodings accept the same options as query params or form fields:
`profileId`, `resolveProducts`, `enrich`, `dedupe`, `source`, `tenantId`, `userId`.
Identity also travels as `X-Tenant-Id` / `X-User-Id`.

```bash
curl -X POST http://localhost:8080/api/retailer:samsclub.com/receipts \
  -H 'content-type: application/json' \
  --data-binary @00769925960064747015.json
```

```bash
curl -X POST 'http://localhost:8080/api/retailer:samsclub.com/receipts?enrich=1' \
  -F 'receipt=@00769925960064747015.json;type=application/json' \
  -F 'source=sync'
```

Responses are the photo endpoint's body plus retailer context:

```json
{
  "id": "main:main:9f2c…",
  "status": "queued",
  "retailer": "samsclub.com",
  "orderId": "00769925960064747015",
  "displayId": "0076 9925 9600 6474 7015",
  "enrich": false,
  "profileId": null,
  "statusUrl": "http://localhost:8080/api/receipts/main:main:9f2c…",
  "viewUrl":   "http://localhost:8080/receipts/main:main:9f2c…/view"
}
```

| status | when |
|---|---|
| `202` | accepted and queued |
| `200` | already ingested — body carries `duplicateOf` |
| `400` | unknown retailer, unrecognized payload, invalid JSON, unknown tenant/profile |
| `413` | payload over `RETAILER_MAX_PAYLOAD_MB` |

---

## 9. Tests

| file | what it covers |
|---|---|
| `test/retailers-registry.test.js` | adapter discovery, alias resolution, unknown ids |
| `test/retailers-samsclub.test.js` | the adapter against 10 real scrubbed payloads — one test per documented trap |
| `test/retailer-ingest-routes.test.js` | the HTTP surface over a real loopback Express app: both encodings, every rejection, flow selection, identity scoping, dedupe, payload read-back, views |
| `test/retailer-pipeline.test.js` | the real pipeline end to end, with a `fetch` that throws — which is itself the proof that no OCR backend and no Tavily were reached |
| `test/live/samsclub-corpus.live.test.js` | *optional*: the whole 248-payload corpus, re-deriving the schema doc's counts. Self-skips when the corpus is absent |

The fixtures are real payloads with personal data replaced; the generator
verifies its own scrub by asserting that no personal value from the original
survived. See [`test/fixtures/retailers/samsclub/README.md`](../test/fixtures/retailers/samsclub/README.md).

---

## 10. Not built

- **Batch ingest.** A sync tool with 248 orders posts 248 times. A
  `POST …/receipts/batch` taking an array would be a natural next step; the
  accept path is already factored to support it (`src/ingest/acceptService.js`).
- **A Sam's Club receipt profile.** The generic `usGrocery` transformer applies,
  but a profile that understands `measuredQty`/`unit` would render
  `1.66 lb @ $14.98/lb` the way the paper receipt does.
- **Re-normalize endpoint.** The payload is kept precisely so a receipt can be
  re-normalized after an adapter improves; nothing exposes that yet beyond
  re-running the job.
- **`costco.com`.** The registry is ready; the payload is not documented.
