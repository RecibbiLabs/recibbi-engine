# Costco receipt schema

What `src/retailers/adapters/costco.com.js` reads, and the measurements behind it.

## Where the payload comes from

One receipt, exactly as Costco's order API returns it:

```
POST https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql
  receiptsWithCounts(barcode, documentType: "all").receipts[0]     per barcode
  receipts(startDate, endDate)[i]                                   in bulk
```

It is collected **in the member's own browser** by the Recibbi Link add-on
(`../recibbi-ux-chromium-extension`, `content/costco.collect.js`) and relayed by
`recibbi-ux-main` to `POST /api/retailer:costco/receipts`. Costco's session key never
leaves the member's tab. The field set is the one `../recibbi-serverside-integration-costco`
verified against a live membership. Both queries ask for the same fields, so the
engine sees one shape.

## Measured over 216 real receipts (138 in-warehouse, 78 gas, Apr 2024 – Aug 2026)

| claim | count |
|---|---|
| `sum(itemArray[].amount) == subTotal` | 216 / 216 |
| `subTotal + taxes == total` | 216 / 216 |
| instant-savings lines whose `"/<n>"` names an item on the same receipt | 86 / 86 |
| `unit * itemUnitPriceAmount == amount` on positive in-warehouse lines | 975 / 1044 |
| gas receipts with exactly one line | 78 / 78 |
| `transactionType: "Refund"` | 1 |
| receipts with no lines at all (a $0 transaction) | 1 |

The adapter normalizes all 216 with `reconciled: true`.

## The traps

1. **`instantSavings` is a summary, not an adjustment.** The discounts are already
   item lines, so the total is `subTotal + taxes`. Subtracting `instantSavings`
   counts every coupon twice.
2. **Coupons are lines.** Each has a negative `amount`, `unit: -1`, a description
   starting with `/` (`"/ BABYBEL"`, `"/1792368"`), and `frenchItemDescription1` set
   to `"/<parent itemNumber>"`. The adapter folds each coupon into its parent:
   `price` is what was paid, and `grossPrice`, `savings` and `couponNumber` are
   kept. That gives one line per product for the catalogue, and enrichment never
   looks up a coupon. A coupon that names no item on the receipt stays as its own
   line (`discount: true`, `sku: null`) with a warning, so the receipt still adds up.
3. **`itemUnitPriceAmount` is the shelf rate.** On weighed lines it is per pound
   (`BEEF FLANK`: 9.99, amount 27.77, unit 1), which is where the 69 mismatches
   above come from. It is taken as given and never recomputed.
4. **Fuel is one line.** Gallons are in `fuelUnitQuantity`, the $/gal rate in
   `itemUnitPriceAmount`, and the grade in `fuelGradeDescription`. The `fuel*`
   fields are sometimes populated on non-fuel lines (a membership fee carried
   `fuelUnitQuantity: 10`). A line counts as fuel only when it also has a
   `fuelGradeCode`.
5. **A return is its own transaction.** It has negative money throughout. Every
   line is negative, so negativity alone does not identify a coupon on a refund.
6. **`transactionBarcode` is the identity.** Every public Costco tool keys on it,
   and it is `source.orderId` here, so a re-sync dedupes.
7. **The bulk `receipts` call omits gas receipts**, silently (116 in-warehouse
   receipts returned, 0 of 78 gas). It is a collector concern, but it is why a
   Costco import that looks complete must be checked against `receiptsWithCounts`.

## Not copied out

`membershipNumber`, `displayAccountNumber`, `tenderAcctTxnNumber` and
`tenderAuthorizationCode` stay in the stored raw payload and are never lifted into
`source`.
