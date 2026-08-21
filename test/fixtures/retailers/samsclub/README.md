# Sam's Club adapter fixtures

Ten real Sam's Club payloads, **scrubbed of personal data**, one per structurally
distinct case in [`docs/samsclub-receipt-schema.md`](../../../../docs/samsclub-receipt-schema.md).
They are what makes `test/retailers-samsclub.test.js` hermetic: the corpus they
came from (`../codex-receipt-retailer-ground-truth/samsclub.com`, 248 payloads) is
gitignored and does not travel with this repo.

| fixture | what it is there to prove |
|---|---|
| `scan-and-go.json` | the ordinary club ticket; one line sold by the pound, so `unitPrice` must come from the payload and not from `price / qty` (trap 3) |
| `savings.json` | `priceDetails.savings` — a **positive** number that is subtracted (trap 8) |
| `fuel.json` | one line, gallons in `quantityString`, a 3-decimal unit price, and a `detail.itemCount` of 13 for a single line (trap 2) |
| `tire-addons.json` | an `addOns[]` line charged separately and counted in `subTotal`; a `Product fee`; no `paymentMethods` at all |
| `delivery-glass.json` | the `GLASS` channel: no club, a `Shipping` fee, catalogue `usItemId` SKUs instead of receipt-tape `offerId`s (trap 10) |
| `electronic-voided.json` | voided zero-quantity membership rows that are real lines costing nothing |
| `two-groups.json` | the one order in the corpus that splits across two fulfillment groups |
| `returned.json` | a `RETURNED` category whose line still carries its original positive price |
| `items-check-fails.json` | lines sum to $147.21 against a $141.97 subtotal — a voided line still on the tape |
| `total-check-fails.json` | a $2.00 counter fee in no `fees[]` row: the total check fails while the items check passes |

## What was changed

Money, quantities, SKUs, order ids, dates, store/club addresses and structure are
**byte-for-byte the originals** — those are exactly what the adapter is tested on,
and a fixture with invented numbers would prove nothing.

Replaced: the member's name, email, phone, delivery address, membership customer
id, the vehicle on the tire order, and card last-4 digits (`*4149` → `*0000`,
shape preserved). Club addresses are public business addresses and are kept real.

## Regenerating

```bash
node test/fixtures/retailers/samsclub/regenerate.js [rawDir]
```

The script re-derives every fixture, then **verifies** the scrub by collecting
every personal value out of the *original* payload and asserting none of them
survived — rather than trusting its own key list, which has been incomplete
before. It exits non-zero if anything leaks.
