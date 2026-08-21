# The Sam's Club receipt payload

What `data/<connectionId>/raw/<orderId>.json` actually contains, derived from **248 real
payloads** — the full history behind `data/cn_8917fa01`, imported 19 Aug 2026 and spanning
`2021-09-07` → `2026-08-19`.

`data/` is gitignored, so the corpus does not travel with this repo. This file is what
survives it: every count below was re-derived from those 248 files, and nothing here is
inferred from Sam's Club documentation, because there isn't any.

Read it alongside [`store.js`](store.js) (which writes these files) and
`../recibbi-ux-chromium-extension/dev/normalize.js` (which reads them). Where the two
disagree with each other, this file says so rather than picking a side.

---

## 1. Provenance — the envelope is ours, the halves are theirs

`{ summary, detail }` is **not** a shape Sam's Club returns. It is assembled by the
collector (`extension/content/samsclub.collect.main.js`) from two persisted GraphQL
operations against `www.samsclub.com/orchestra/cph/graphql/`:

| half | operation | what it is |
|---|---|---|
| `summary` | `PurchaseHistoryV2` | one element of the order-list page — how the order looks in a list |
| `detail` | `getOrder` | the order detail page — line items, prices, payment, store |

Two consequences worth holding onto:

- **A payload can be half-present.** The collector emits `{ summary, detail, detailError }`
  when the detail call fails; such a receipt has names and quantities but no prices, which
  is the `incomplete` state the index and the job dialog carry. All 248 files in this
  corpus have both halves and none carries `detailError` — this is a repaired history, not
  a representative one.
- **The payload is scrubbed, not raw-raw.** Keys matching
  `/^(authorization|cookie|set-cookie|x-o-|wm_|tenant-id|_px|x-apollo)/i` are stripped at
  collection. No such key appears in any of the 248 files, and none is expected to; the
  order body never carried one.

**`groups_2101` is a versioned field name.** The `_2101` suffix belongs to the schema
version the pinned persisted-query hash speaks. When Sam's Club redeploys and the hash goes
stale, this key is one of the things that can move. Anything reading it should treat a
missing `groups_2101` as "detail unavailable", not as "order with no items".

### PII

The detail half carries the member's **name, delivery address, phone number, email,
customer id, and payment-card last-4**. Every field is listed in §4 so nothing is a
surprise; treat a raw payload as personal data even though the receipt itself is boring.

---

## 2. The corpus these claims rest on

| | |
|---|---|
| receipts | 248 (`raw/` files, one per order) |
| line items | 1,435 in `detail`, plus 3 add-on lines = **1,438** as recibbi counts them |
| date range | 2021-09-07 → 2026-08-19 |
| by year | 2021 · 2 · 2022 · 25 · 2023 · 70 · 2024 · 59 · 2025 · 59 · 2026 · 33 |
| size | 12.4 MiB total · 51 KB mean · 20.6 KB min · 138.7 KB max |
| distinct JSON paths | 856 |
| paths that are `null` in **every** payload | 384 (45%) |
| paths that are a constant `''`/`false` everywhere | 98 |
| paths that ever carry information | **374** |

That last row is the headline. Nine tenths of this schema is an order-management system
talking to itself — substitutions, tipping, driver tracking, protection plans, pharmacy,
`isPetRx`. A receipt reader needs roughly thirty of these fields.

Fulfillment mix, which is what actually varies:

| `summary.fulfillmentType` | n | `detail.type` | `derivedFulfillmentType` | `deliveryMessage` |
|---|---|---|---|---|
| `SCAN_AND_GO` | 101 | `IN_STORE` | `IN_STORE` | Scan & Go |
| `IN_STORE` | 72 | `IN_STORE` | `IN_STORE` | In club |
| `FUEL` | 57 | `IN_STORE` | `IN_STORE` | Fuel |
| `DELIVERY` | 11 | `GLASS` | `FC_DELIVERY` | Shipping |
| `ELECTRONIC` | 4 | `IN_STORE` ×3, `GLASS` ×1 | `ELECTRONIC` | Digital delivery |
| `ACC_TIRE` | 3 | `GLASS` | `SC_PICKUP` | Installation at Tire & Battery Center |

`IN_STORE` vs `GLASS` is the real fault line: `GLASS` is the online order platform, and it
identifies products completely differently (§5).

---

## 3. Envelope skeleton

Only the fields that carry information, at their real nesting:

```jsonc
{
  "summary": {                       // PurchaseHistoryV2 — the list-page projection
    "orderId": "00769925960064747015",
    "purchaseOrderId": "…",          // always == orderId
    "displayId": "0076 9925 9600 6474 7015",
    "groupId": "e7d9a450c8653ea7bad9ad508c95ffcf",
    "type": "IN_STORE" | "GLASS",
    "fulfillmentType": "SCAN_AND_GO",
    "derivedFulfillmentType": "IN_STORE",
    "deliveryMessage": "Scan & Go",
    "itemCount": 4,                  // display figure — see trap 2
    "isActive": true,
    "groupRank": 11,
    "status": { "statusType": "PREPARING", "message": { "parts": [ … ] }, "statusTracker": null },
    "items": [ { "id", "uniqueId", "name", "quantity", "imageInfo", "statusCode", "addOns" } ],
    "shipment": null | { … }
  },
  "detail": {                        // getOrder — the receipt itself
    "id": "00769925960064747015",
    "displayId": "0076 9925 9600 6474 7015",
    "version": 1,
    "type": "IN_STORE" | "GLASS",
    "orderDate": "2025-10-05T08:44:06-07:00",
    "timezone": "America/Los_Angeles",
    "title": "Oct 5, 2025",
    "shortTitle": "Oct 5, 2025",
    "itemCount": 4,
    "isFuelPurchase": false,
    "isExchange": false,
    "martId": "",
    "idBarcodeImageUrl": "https://receipts-query.edge.walmart.com/barcode?…",
    "customer": { "id", "firstName", "lastName", "email", "isGuest", "isEmailRegistered" },
    "priceDetails": { "subTotal", "taxTotal", "grandTotal", "grandTotalWithTips",
                      "fees": [], "savings": null, "refund": null,
                      "discounts": [], "donations": [], "minimumThreshold" },
    "paymentMethods": [ { "cardType", "paymentType", "description", "displayValues", "message" } ],
    "actions": { "return": false, "startReturn": null, … },
    "groups_2101": [ {                             // fulfillment groups, normally 1
      "fulfillmentType": "IN_STORE",
      "detailedGroupType": "SCAN_AND_GO",
      "deliveryMessage": "Scan & Go",
      "deliveryDate": "",
      "pickedBy": "CUSTOMER",
      "status": { "statusType", "statusTracker" },
      "store": { "id", "name", "address": { … } } | null,
      "subtotal": { "value": 0, "displayValue": "$0" },   // always zero — trap 4
      "deliveryAddress": null | { … },
      "shipment": null | { "id", "trackingNumber", "purchaseOrderId" },
      "digitalDelivery": null | { "name", "instructions" },
      "tireInfo": null | { … },  "vehicleInfo": null | { … },  "reservations": null | [ … ],
      "items": [ … ],                              // 18-key projection — trap 1
      "categories": [ { "type": "REGULAR" | "RETURNED", "name": null, "items": [ … ] } ]
    } ]
  }
}
```

---

## 4. Order-level fields

### Identity

| path | notes |
|---|---|
| `detail.id` = `summary.orderId` = `summary.purchaseOrderId` = filename | 248/248 identical in all four places |
| `detail.displayId` = `summary.displayId` | the same digits chunked in 4s: `10143302015` → `1014 3302 015`. 248/248 |
| `summary.groupId` | 32-hex, distinct per order; the collector passes it back as `clickThroughGroupId` when fetching detail |
| `detail.idBarcodeImageUrl` | `…/barcode?…&data=<orderId>` — carries no information the id doesn't |

Order-id **shape follows the channel**, and it is the cheapest available channel test:

| `type` | id length | n |
|---|---|---|
| `IN_STORE` | 18–21 digits | 233 |
| `GLASS` | 10–11 digits | 15 |

### Time

| path | what it is |
|---|---|
| `detail.orderDate` | ISO-8601 **with offset** — the only real timestamp in the payload. `2025-10-05T08:44:06-07:00` |
| `detail.timezone` | `America/Los_Angeles` ×233, `America/New_York` ×15 |
| `detail.title` / `shortTitle` | `orderDate` formatted `%b %-d, %Y`. Matched in 248/248 — decorative, never parse it |
| `summary.status.message.parts[].text` | `"Purchased on Sun, Oct 5"` — no year, so useless as a date |
| `groups_2101[].deliveryDate` | `""` on every in-club order; an ISO timestamp only on shipped ones |

**The offset is the account's, not the club's.** Every purchase in this corpus happened in
Florida, yet 233 payloads report `America/Los_Angeles` and offsets of `-07:00`/`-08:00`.
The instant is correct; the wall-clock time is not the member's. It does not change any
receipt's *date* here (0 of 248 shift when re-expressed as US-Eastern) but a purchase near
local midnight would land on the wrong day for anyone who formats `orderDate` naively.

### Money — `detail.priceDetails`

Every money row is the same wrapper: `{ label, value, displayValue, info, subText,
strikeValue, strikeThroughValue, labelStyle, labelType, rowInfo }`. Only `label`, `value`
and `displayValue` are ever populated. `value` is a JSON number in dollars, `displayValue`
the formatted string.

| field | presence | notes |
|---|---|---|
| `subTotal` | 248/248 | label `Subtotal`. **The authority on what the lines should add to** |
| `taxTotal` | 248/248 | label `Sales tax`; `0` on 138 receipts |
| `grandTotal` | 248/248 | label `Total` |
| `grandTotalWithTips` | 248/248 | byte-identical to `grandTotal` in all 248 — no tipped orders here |
| `fees[]` | 14 receipts, 15 rows | labels seen: `Shipping` ×11, `Product fee` ×3, `Pickup fee` ×1. Value `0` with `displayValue: "Free"` on 5 |
| `savings` | 39 receipts | a **single positive** row, label `Savings`, `displayValue` `-$5.00`. It is *subtracted* |
| `refund[]` | 1 receipt | `{ label: "Refund to *4149", value: 976.83, displayValue: "-$976.83" }` — again positive, again subtracted in presentation |
| `discounts[]` | 0 receipts | **always empty, even on the 39 receipts that have savings.** Do not read discounts |
| `donations[]`, `summaryDescription[]` | 0 | always empty |
| `minimumThreshold` | 248/248 | always `$0` |
| `allSavings`, `rewards`, `driverTip`, `belowMinimumFee`, `monthlyPayment`, `strikethroughSubTotal` | — | `null` in all 248 |

### Payment — `detail.paymentMethods[]`

226 receipts carry one tender, 21 carry two, **1 carries none** (an `ACC_TIRE` order).
`displayValues[]` sums to `grandTotal` on all 247 receipts that have any tender.

| field | values seen |
|---|---|
| `paymentType` | `CREDITCARD` ×224, `EBT` ×23, `OTHER` ×21 |
| `cardType` | `SAMS_CONSUMER_CREDIT` ×72, `MASTERCARD` ×70, `Amex` ×55, `EBT_FOODSTAMPS` ×23, `SAMS CASH` ×21, `Visa` ×17, `Debit Card` ×6, `AMEX` ×3, `VISA` ×1 |
| `description` | `*4149` — card last-4. On EBT: `*3536 (Food)`. On Sam's Cash: `Sam's Cash` |
| `displayValues[]` | always exactly one formatted amount: `["$39.66"]` |
| `message` | 23 receipts (all EBT): rich-text parts carrying the **EBT ending balance** and the timestamp it was read |
| `title`, `detailedDisplayValues`, `paymentBanner` | `null` in all 248 |

`cardType` is free-form and **case-inconsistent** — `Amex`/`AMEX`, `Visa`/`VISA` are the
same brand written by different eras of the same system. Normalize case before grouping.

### Customer — `detail.customer`

`id` (a 17-digit membership-scoped id, 3 distinct values across the 248 receipts), `firstName`/`lastName` (populated on the 15 `GLASS` orders, `null` on all 233
in-club ones), `email` (populated on the same 15, `""` otherwise), `isGuest` (always
`false`), `isEmailRegistered` (always `true`).

One `firstName` reads `SAMS|CLUB` — a system account, not a person. Names in this payload
are not a reliable identity.

---

## 5. Line items

### Trap 1 first: there are two copies of every item

Each group carries its items **twice**, at different fidelity:

- `groups_2101[].items[]` — an 18-key projection. `priceInfo` has **only** `linePrice`.
- `groups_2101[].categories[].items[]` — 68 keys, including `priceInfo.unitPrice`,
  `priceInfo.itemPrice`, `priceInfo.additionalLines`, `quantityString`, `quantityLabel`,
  `statusCode`, `returnId`, `discounts`.

Same items, same count (1,435 each), same ids, in the same order in 247 of 248 payloads —
the exception (`647034762218919246966.json`) has a returned line sorted last under
`categories` and in position under `items`. **`categories[].items[]` is the authoritative
list.** `normalize.js` currently reads `groups_2101[].items[]`, which is why it recomputes
`unitPrice` as `price / qty` and gets weighted items wrong (trap 3).

### The fields that matter

| path (under `categories[].items[]`) | notes |
|---|---|
| `id` | string, `"1"`, `"2"`… **Not dense** — gaps are normal where a line was voided or removed |
| `uniqueId` | int form of the same |
| `productInfo.name` | the description. 294 distinct across 1,435 lines |
| `productInfo.offerId` | the SKU — **but see the channel split below**. `null` on 2 lines |
| `productInfo.usItemId` | `""` on 1,419 lines; a catalogue item id on 16 (15 numeric, one reads `sku30004`) |
| `productInfo.imageInfo.thumbnailUrl` | present on 1,426/1,435; `scene7.samsclub.com/is/image/samsclub/<gtin>_A` |
| `productInfo.salesUnit` / `salesUnitType` | **`"EACH"` on all 1,435 lines, including the 191 sold by weight or volume.** Meaningless |
| `productInfo.canonicalUrl`, `categoryPathId`, `orderLimit` | populated only on `GLASS` lines |
| `quantity` | int. `1` ×1,329, `2` ×74, up to `19`. `0` on 4 informational rows |
| `quantityString` | the **real** measured quantity: `"1"`, `"1.66 lb"`, `"13.324 gal"` |
| `quantityLabel` | `Qty` ×1,281, `lb` ×134, `ea` ×16, `""` ×4 |
| `priceInfo.unitPrice.value` | price per unit — per **pound**, per **gallon**, or per each |
| `priceInfo.itemPrice.value` | equals `unitPrice` on 1,434 of 1,435 lines — the exception is a fuel line carrying the *line total* (`$39`, `displayValue: "$39 gal"`). Don't rely on it |
| `priceInfo.linePrice.value` | **what the member was charged for this line.** This is the one to sum |
| `priceInfo.additionalLines[]` | present on 4 lines, all `{ name: "Voided", value: "" }` |
| `statusCode` | `"2112"` on the **first item of every group, across 238 receipts** (239 lines) and nowhere else — a list-rendering artifact, not item state |
| `addOns[]` | 3 lines, all `TIRE_INSTALLATION` — see below |
| `discounts[]` | empty on all 1,435 |

### The channel split in product identity

| | `IN_STORE` (1,419 lines) | `GLASS` (16 lines) |
|---|---|---|
| `offerId` | a **receipt-tape SKU**: `BF STRIPLOIN`, `MINI CUCUMBE`, `GASOLINE` — 3–15 chars, usually ≤12, truncated, human-ish | a 32-char uppercase hex offer id |
| `usItemId` | `""` | populated (`7231029088`) |
| `canonicalUrl` | `""` | a real product URL |

So `sku = usItemId ?? offerId` (what `normalize.js` does) is right, but the resulting SKU
lives in **two different namespaces** and the in-store one is a truncated display string,
not a stable identifier: `MINI CUCUMBE` is what the register printed. It is good enough to
match a product against itself across visits and not good enough to join to a catalogue.

### Add-ons

`items[].addOns[]` are **separately charged lines nested under the item they attach to** —
here, tire installation packages at $39.98–$80.00. They are counted in `subTotal`, so a
reader that walks only `items[]` reports a receipt that does not add up. Shape:
`{ lineId, uniqueLineId, type: "TIRE_INSTALLATION", quantity, quantityString, productInfo: { name, offerId, usItemId }, priceInfo: { linePrice } }`.

3 lines across 3 receipts. `normalize.js` flattens them into the item list with
`addOnOf` set to the parent's SKU — that is why recibbi counts 1,438 line items where the
payload has 1,435 items.

### Informational rows

4 lines have `quantity: 0`, `linePrice.value: 0`, `displayValue: ""` and an
`additionalLines: [{ name: "Voided" }]` — membership renewals and a removed produce line.
They are real rows on the ticket that cost nothing. Keep them (recibbi flags them
`informational: true`); dropping them makes the ticket disagree with the paper one.

---

## 6. Groups, stores and the six receipt kinds

`detail.groups_2101[]` is an array because one order can split across fulfillments. **247
payloads have one group; one has two** (`9885842023.json`: a shipped item plus an
electronic membership renewal). `priceDetails` is order-level and covers all groups —
`groups_2101[].subtotal` is `{ value: 0, displayValue: "$0" }` on all 249 groups.

`groups_2101[].store` is populated on 236 groups and `null` on 13 (across 12 receipts —
shipped, delivered and one electronic group have no club). When present: `{ id, name, address: { addressLineOne, city, state,
postalCode, extendedPostalCode, country, latitude, longitude, addressString } }`. Seven
clubs appear, 207 of 248 receipts at club `8138` "Daytona Beach Sam's Club".

Everything else on the group — `driver`, `shopper`, `tipping`, `substitutionsBanner`,
`deliveryPreferences`, `pharmacyInfo`, and about seventy more — is `null` in every payload.

### What each kind actually looks like

**`SCAN_AND_GO` (101) and `IN_STORE` (72)** — the ordinary club ticket. Store present,
`pickedBy: "CUSTOMER"`, `status.statusType: "PREPARING"` (which means nothing; see trap 5),
tape SKUs, weighted lines carrying `quantityString` in pounds.

**`FUEL` (57)** — exactly one line, `productInfo.name: "UNLEAD GASOLINE"`, `offerId:
"GASOLINE"`, `quantity: 1`, `quantityString: "13.324 gal"`, `quantityLabel: "Qty"` (not
`gal`), `unitPrice: 3.659` — **three decimal places** on all 57, with `displayValue: "$3.659/gal"`. `linePrice` is
the pump total. `detail.isFuelPurchase` is `true` on exactly these 57 and false on the
other 191, so it is a reliable flag. `detail.itemCount` on a fuel receipt is a nonsense
number (7, 10, 13 — for one line).

**`DELIVERY` (11)** — `type: "GLASS"`, no store, `deliveryAddress` populated with the
member's full name, street address and phone. `shipment` carries `trackingNumber` and a
`purchaseOrderId` that is **not** the order id. `fees[]` carries `Shipping`.
`status.statusTracker[]` is a real 4-step progression here.

**`ELECTRONIC` (4)** — digital delivery. `digitalDelivery.name` reads `"Emailed to
kosipov@yahoo.com"` or, on 3 of them, literally `"Emailed to null"`. Membership renewals
show up here as voided zero-quantity rows.

**`ACC_TIRE` (3)** — Tire & Battery Center. The most structurally interesting kind:
`addOns[]` on the tire line, `reservations[]` with an appointment window and a
`vehicleInfo` (`"Toyota 4Runner SR5 2020"`), `tireInfo.instructions.instructions[]`
containing **raw HTML with a phone link**, and `fees[]` carrying `Product fee`. One of the
three has no `paymentMethods` at all.

### Returns

3 payloads carry a category with `type: "RETURNED"` and a `name` of `Return in club` /
`Return scheduled for pickup`. The returned item still sits in the category with its
**original positive `linePrice`** — the return is expressed by the category, the
`summary.status.statusType` (`RETURN_COMPLETED`, `RETURN_DROPPED_OFF`) and, on one
receipt, a `priceDetails.refund[]` row. Summing line prices on a returned order gives what
was originally paid, not what it cost in the end.

12 receipts have `detail.actions.return: true` with a `startReturn` action — that is
*eligibility*, not a return.

---

## 7. The money model, and where it fails

Two independent checks, both verified across all 248 payloads:

```
items:  Σ categories[].items[].linePrice + Σ addOns[].linePrice  ==  subTotal
total:  subTotal + Σ fees - savings + taxTotal                   ==  grandTotal
```

| check | passes |
|---|---|
| line sum (with add-ons) == `subTotal` | **247 / 248** |
| `subTotal + fees − savings + tax` == `grandTotal` | **246 / 248** |
| both (what recibbi calls *reconciled*) | **245 / 248** |

Those 245/3 are exactly the numbers `index.json` reports, re-derived here from the raw
payloads rather than read back from the ledger.

The three failures are real gaps in the payload, not extraction bugs:

| order | what fails | by | what it is |
|---|---|---|---|
| `976767076793172856129` | line sum ($147.21) > subtotal ($141.97) | $5.24 | 16 lines with a gap at id `4`; a line was voided at the register and the tape still lists it. The total check passes |
| `019102914021720042734` | $312.68 + $20.45 = $333.13 vs total $335.13 | $2.00 | a tire order — a state fee charged at the counter that appears in no `fees[]` row |
| `262699308958079789005` | $759.96 + $44.46 − $80.00 = $724.42 vs total $728.42 | $4.00 | the same, four tires' worth |

This is the tire-centre fee question the README mentions, and it is why `fees[]` exists in
the normalized shape. **Both halves of the total formula were established from these
receipts** — that fees are *added* after the subtotal and that savings are *subtracted*
despite arriving as a positive number.

Keeping the two checks apart matters: a failed **items** check means we are missing data; a
failed **total** check means there is a charge we are not modelling. Collapsing them into
one boolean tells you a receipt is wrong without telling you whose problem it is.

---

## 8. Traps

1. **Two copies of every item.** `groups_2101[].items[]` silently lacks `unitPrice`,
   `quantityString` and `statusCode`. Read `categories[].items[]`. (§5)
2. **`itemCount` is a display figure, not a count.** `detail.itemCount` matches neither the
   line count nor the summed quantity on **113 of 248** receipts, and `summary.itemCount`
   disagrees with `detail.itemCount` on **114**. A one-line fuel receipt reports
   `itemCount: 10`. Count the items yourself.
3. **`quantity` is not the quantity for anything sold by weight or volume.** 191 lines are
   priced per pound or per gallon with `quantity: 1`; the measure lives in
   `quantityString` and the rate in `priceInfo.unitPrice`. On **160 of 1,435** lines
   `unitPrice × quantity ≠ linePrice`, and 157 of those resolve exactly (to the half-cent)
   when you parse `quantityString` instead. (The remaining three are off by 5.6¢, 1.0¢ and
   0.6¢ — a salmon fillet at `2.30 lb` and two Gouda lines at `1.40 lb` and `1.51 lb` —
   because the displayed weight is itself rounded, so re-derive the *unit* price from the
   payload rather than the *line* price from the display. At a 1¢ tolerance only the salmon
   survives, which is why an earlier count of this said 159.) `salesUnitType` says `EACH`
   for all of them and is no help.
4. **`groups_2101[].subtotal` is always `$0`.** Group-level money is not populated. The
   only totals are order-level, in `priceDetails`.
5. **`status.statusType` is `PREPARING` on 233 completed in-club purchases.** A three-year-old
   Scan & Go ticket is "preparing". Order status carries no information for a
   receipt reader; `statusTracker` is `null` on 236 of 248 and only means anything on
   shipped and tire orders.
6. **`statusCode: "2112"`** appears on the first item of 238 receipts and nowhere else —
   239 lines, because the one two-group payload carries it on the first item of each group.
   It is a rendering marker, not item state.
7. **`discounts[]` is always empty**, at both order and line level, including on the 39
   receipts that do have savings. Savings live in `priceDetails.savings` only.
8. **`priceDetails.savings` and `refund[]` are positive numbers that get subtracted.**
9. **`grandTotalWithTips` duplicates `grandTotal`** byte for byte here. Don't treat it as
   independent confirmation of anything.
10. **`type: "GLASS"` changes product identity, not just fulfillment.** SKU namespace,
    `usItemId`, `canonicalUrl` and the presence of a store all flip. (§5)
11. **Item ids have gaps**, and a gap is often the trace of a line that was voided or
    removed — as in the one receipt whose items overshoot its subtotal.
12. **`timezone` is the account's, not the club's.** (§4)
13. **`groups_2101` is version-suffixed** and moves with the persisted-query hash. (§1)

---

## 9. Mapping onto recibbi's receipt

What `normalize.js` keeps, for reading the two files side by side:

| recibbi | from |
|---|---|
| `source.orderId` | `summary.orderId ?? detail.id` |
| `source.displayId` | `detail.displayId ?? summary.displayId` |
| `source.channel` | `summary.type` (`IN_STORE` / `GLASS`) |
| `source.fulfillment` | `summary.fulfillmentType ?? summary.derivedFulfillmentType` |
| `store.date` | `detail.orderDate` |
| `store.name` | hardcoded `"Sam's Club"` — **not** `groups_2101[].store.name`, which is available on 236 groups and names the actual club |
| `items[].description` | `productInfo.name` |
| `items[].sku` / `skuKind` | `usItemId ?? offerId`, tagged with which |
| `items[].qty` | `quantity` |
| `items[].price` | `priceInfo.linePrice.value` |
| `items[].unitPrice` | **recomputed** as `price / qty` — wrong for the 191 measured lines, where `priceInfo.unitPrice` is sitting in the payload one projection away |
| `items[].salesUnit` | `productInfo.salesUnitType` — always `EACH`, so always uninformative |
| `items[].informational` | `qty === 0 && !price` |
| `items[].addOnOf` / `addOnType` | flattened `addOns[]` |
| `totals.*` | `priceDetails.{subTotal,taxTotal,grandTotal,savings}`, `fees[]` itemized |
| `totals.itemCount` | `detail.itemCount ?? summary.itemCount ?? items.length` — inherits trap 2 |

Three things in the payload that nothing currently reads and that a receipt page would
want: **the club** (`groups_2101[].store.name` + address), **the measured quantity**
(`quantityString`, so a receipt can say `1.66 lb @ $14.98/lb` the way the paper one does),
and **the tender** (`paymentMethods[].cardType` + `description`, so a synced receipt can
say `MASTERCARD *7375` like a photographed one).

---

## 10. Re-deriving this

Every count here came from walking `data/cn_8917fa01/raw/*.json` — no engine, no ledger.
The shape of that walk, for whoever needs to check a claim or re-run it against a fresh
import:

```bash
python3 - <<'PY'
import json, os, collections
RAW = 'data/cn_8917fa01/raw'
paths = collections.defaultdict(collections.Counter)
def walk(p, v):
    paths[p][type(v).__name__] += 1
    if isinstance(v, dict):
        for k, vv in v.items(): walk(f'{p}.{k}', vv)
    elif isinstance(v, list):
        for it in v: walk(f'{p}[]', it)
for f in sorted(os.listdir(RAW)):
    walk('$', json.load(open(os.path.join(RAW, f))))
for p in sorted(paths):
    print(p, dict(paths[p]))
PY
```

Anything in this file that a later import contradicts should be corrected here rather than
worked around at the call site — the payload is the subject, and this is where what we know
about it lives.
