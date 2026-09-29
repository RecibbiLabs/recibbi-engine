# The product catalogue

Every product a member has bought, once each, persisted and kept current as
receipts finish. The data behind ux-main's **Products** screen, designed in
`../recibbi-ux-design-atlas/flows/products.html`. The ingestion-side design
(where in the pipeline this happens and what it writes) is drawn in
`recibbi-engine-ingestion-atlas`, section 10.

Code: `src/catalogue/` (`project.js` the projection, `query.js` the filters and
order, `index.js` persistence and services, `cli.js` the backfill and verifier),
`src/routes/catalogue.js`.

## What a product is

**A store and a `productKey()`**: the SKU where the line has one, the register's
own string where it does not. The design atlas settled this
(`pages/products.js` → `catalogue()`, `recibbi.js` → `productKey()`), and the
engine uses the atlas's rule exactly, because the card a member sees and the
receipt it links to must agree about what the product is.

The store is half of it because a SKU is a retailer's number, not a product's:
30669 at Costco and 30669 at Sam's Club share a till code by accident. The
store half is the retailer id for a synced receipt (`samsclub.com` →
`samsclub`), the catalogued retailer a printed name starts with
(`COSTCO WHOLESALE #1024` → `costco`), or the printed name with the punctuation
out.

A product's **id** is `p` + 24 hex characters of the SHA-1 of its key. It is the
same from an empty database, so the backfill and the incremental index agree
on ids without talking to each other, and it is URL-safe where the key (a till
string) is not.

## Why it is persisted now

The atlas drew Products as "a query over the books, not a product table":
merge every done receipt into products on every request. That is correct and
O(receipts × lines) per page: 1,473 lines re-merged to draw 24 cards, and again
on every filter tick. So the merge is persisted, one row per (product, receipt),
written when a receipt finishes.

**The rows are a projection, not a second source of truth.** A product's name
still lives on the receipt lines (`item.enrichment`). Every catalogue row can be
deleted and rebuilt from the receipts, and the verifier's definition of
"correct" is exactly that rebuild.

## Three document kinds

| kind | key | written by | holds |
|---|---|---|---|
| `purchases` | tenant, user, **id** productId, **sub** receipt cacheId | indexing *that receipt* | that receipt's lines for that product, merged: qty, spent, day, store, the lines in the atlas's shape |
| `purchaseIndex` | tenant, user, **id** receipt cacheId | indexing *that receipt* | which products the receipt contributed to, so re-indexing can delete rows it no longer implies |
| `catalogue` | tenant, user, **id** productId | naming (API process) | what the **member** said about a product, so the next receipt it arrives on is named the same way |

**A product itself is not stored.** It is its purchase rows, grouped at read
time (`project.assemble()`). That is one indexed list per request, and there is
no aggregate document for two writers to race on: the worker finishing two
receipts with the same eggs on them is two independent row writes, not two
read-modify-writes of one "eggs" document. Neither backend offers a
cross-process lock or a multi-document transaction through the persistence
interface, so the model is shaped so that it needs neither.

## When it is written

```
processReceipt(id)
  1-3  extract, canonicalize, enrich            (unchanged)
  4    applyRememberedNames(record)             NEW: a product the member named
                                                before is named on this receipt too
       status = done; save
  5    indexReceiptSafely(record)               NEW: write this receipt's purchase
                                                rows; delete the ones it no longer implies
  6    discard the raw payload                  (unchanged)

resolveProducts(id, profile)
       save product result
       reindex(id)                              NEW: the resolver's brand, category,
                                                confidence reach the rows
```

Indexing is **best-effort** in both places: a receipt that read perfectly is not
failed because its products could not be filed. A miss is drift, not loss; the
verifier names it and the backfill repairs it.

## What a line carries

Each purchase row keeps its lines with `enrichment` in the shape the atlas's
builders read. Three sources, merged in one place (`project.enrichmentView()`):

1. **The member**: `named: 'member'`. Taken as said, never refilled by anything
   else. A cleared brand stays cleared; no confidence, because a confidence
   describes a guess.
2. **The pipeline's enrichment**: web search or the retailer's own page.
   Its `url` is read as the atlas's `page`.
3. **The product resolver**: fills what the pipeline left empty, matched to
   the line by SKU, then description.

## Naming a product

`PATCH /api/catalogue/:id { title, brand, category }` writes the answer onto
every line of that product on every receipt it was on, sets `named: 'member'`,
clears `confidence`, and takes the review flag off. This is the atlas's stub
`nameProduct()` contract. The receipts are written one after another; if one
write fails, the ones already written are restored, and the refusal says nothing
changed. The answer is then remembered in `catalogue`, and the receipts are
re-indexed.

## The one-off backfill, and the check that ingest stays correct

```bash
podman exec receipt-enricher_api_1 node src/catalogue/cli.js backfill
podman exec receipt-enricher_api_1 node src/catalogue/cli.js verify
```

`backfill` rebuilds every member's catalogue from their receipts, then verifies
its own work and says so. It is idempotent: a rebuild of a correct catalogue
writes the same rows and removes nothing. That makes it both the first fill and
the repair.

`verify` recomputes every row from the receipts, in memory, and compares:
`missing` (implied, not stored), `stale` (both, different), `extra` (stored, not
implied), and per-receipt index mismatches. It writes nothing and exits `1` on
any drift. **This is the test that ingest is correct:** after any number of
receipts arrive through the pipeline, with no backfill in between, it must
still pass. `test/catalogue-ingest.test.js` does exactly that over the Sam's
Club fixtures, checking after every receipt, and fails when the pipeline's
indexing call is removed.

Both also exist per member over HTTP: `GET /api/catalogue/verify`,
`POST /api/catalogue/rebuild`.

## Known limits

- **A re-index racing a name.** The worker re-indexes a receipt; the API names
  a product on it at the same moment. Each writes a correct projection of one
  of the two states of the receipt, and the last writer wins. `verify` names
  the result and `backfill` fixes it. Naming is serialized per product within
  the API process.
- **Reads list the member's whole catalogue.** Filters, facets and order run in
  memory over the member's purchase rows, as `GET /api/receipts` does over
  receipts. When the sqlite backend grows columns for WHERE and COUNT, both
  push down together.
- **No tags yet.** The `tag` filter is wired and answers nothing until tags
  exist (design atlas `docs/proposals.md` § 2).
- **No bulk picture fetch.** The Products screen's "Find pictures" offer has no
  engine route behind it yet, so ux-main does not draw it.
