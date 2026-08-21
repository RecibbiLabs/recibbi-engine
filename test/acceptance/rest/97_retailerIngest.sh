#!/usr/bin/env bash
# REST: retailer JSON receipt ingest against the real containerized stack
# (real Redis, real BullMQ worker, real persistence backend).
#
# These receipts arrive as the retailer's OWN order JSON and skip OCR entirely —
# a per-retailer adapter normalizes the payload into the same canonical shape the
# photo path produces (see docs/RETAILER-INGEST.md). What only a live stack can
# prove, and the hermetic suite cannot:
#   1. A JSON receipt rides the SAME `process-receipt` job on the SAME per-tenant
#      queue as a photo, and actually reaches `done` through a real worker.
#   2. The worker reads the payload blob back off the shared volume — the API and
#      the worker are separate containers, so the upload and the normalize happen
#      in different processes.
#   3. Dedupe survives a round trip through real Redis.
#   4. The engine really does no OCR for these: `extraction.provider` is the
#      adapter, and the step passes under `--ocr tesseract` with no model work.
#
# ADDING A RETAILER: append a row to RETAILER_CASES below and drop a scrubbed
# fixture at test/fixtures/retailers/<fixtureDir>/<fixtureFile>. Nothing else
# here is Sam's-Club-specific. The step also cross-checks the table against
# GET /api/retailers and warns about any registered retailer it does not cover.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: retailer JSON ingest (adapter path, no OCR)"

# retailerId | fixtureDir | fixtureFile | orderId | items | total | storeName
#
# `orderId` is also how the real ground-truth payload is located when the
# corpus repo is present (<corpus>/<retailerId>/<orderId>.json); the committed
# fixture is the fallback, and both carry identical money and structure.
RETAILER_CASES="
samsclub.com|samsclub|scan-and-go.json|00769925960064747015|4|39.66|Sam's Club
samsclub.com|samsclub|fuel.json|05320328058895178882|1|48.75|Sam's Club
"

body="$(mktemp)"
payload="$(mktemp)"
tmp_variant="$(mktemp)"
cleanup() { rm -f "$body" "$payload" "$tmp_variant"; }
trap cleanup EXIT

# Resolve a payload: prefer the real ground-truth corpus, fall back to the
# committed scrubbed fixture so this step runs on any checkout.
resolve_payload() {   # retailerId fixtureDir fixtureFile orderId -> path on stdout
  local truth="$RE_TEST_RETAILER_CORPUS_DIR/$1/$4.json"
  local fixture="$PROJECT_DIR/test/fixtures/retailers/$2/$3"
  if [ -f "$truth" ]; then printf '%s' "$truth"; return 0; fi
  if [ -f "$fixture" ]; then printf '%s' "$fixture"; return 0; fi
  return 1
}

post_json() {         # retailerId file [querystring] -> http code, body in $body
  curl -sS -o "$body" -w '%{http_code}' -X POST \
    "$RE_TEST_BASE/api/retailer:$1/receipts${3:-}" \
    -H 'content-type: application/json' --data-binary "@$2"
}

# --- 0. discovery: what can this deployment read? ---------------------------
curl -fsS "$RE_TEST_BASE/api/retailers" > "$body"
registered="$(jq -r '[.[].id] | join(",")' "$body")"
assert_num_gt   "GET /api/retailers returns adapters" "$(jq -r 'length' "$body")" "0"
assert_nonempty "registered retailers" "$registered"

curl -fsS "$RE_TEST_BASE/health" > "$body"
assert_num_gt "/health advertises the retailers" "$(jq -r '.retailers | length' "$body")" "0"

# The table and the engine must agree. Every retailer this step covers has to be
# registered...
covered="$(printf '%s\n' "$RETAILER_CASES" | awk -F'|' 'NF>1{print $1}' | sort -u)"
missing=""
for rid in $covered; do
  case ",$registered," in
    *",$rid,"*) : ;;
    *) missing="$missing $rid" ;;
  esac
done
if [ -n "$missing" ]; then
  fail "every covered retailer is registered (missing:$missing)"
else
  pass "every covered retailer is registered"
fi

# ...and a retailer the engine ships without a case here is worth knowing about.
# A warning, not a failure: adding an adapter shouldn't break the suite, but it
# should nag until this step covers it too.
for rid in $(printf '%s' "$registered" | tr ',' ' '); do
  case " $(printf '%s' "$covered" | tr '\n' ' ') " in
    *" $rid "*) : ;;
    *) warn "retailer '$rid' is registered but has no case in RETAILER_CASES — add one" ;;
  esac
done

# --- 1. per-retailer ingest battery -----------------------------------------
# bash 3.2: no associative arrays, and a piped `while` would run in a subshell
# (losing the assertion counters), so drive the loop from a here-string.
first_retailer=""
while IFS='|' read -r rid fdir ffile oid want_items want_total want_store; do
  [ -n "${rid:-}" ] || continue
  [ -n "$first_retailer" ] || first_retailer="$rid"

  src="$(resolve_payload "$rid" "$fdir" "$ffile" "$oid")" || {
    fail "$rid/$ffile: no payload found (corpus or fixture)"
    continue
  }
  info "$rid: $(basename "$src")  [$( [ "${src#$RE_TEST_RETAILER_CORPUS_DIR}" != "$src" ] && echo ground-truth || echo fixture )]"

  # dedupe=0: the corpus order id is fixed, so a rerun against a kept stack must
  # still create a receipt. Dedupe gets its own deterministic test below.
  code="$(post_json "$rid" "$src" '?dedupe=0&source=acceptance')"
  assert_http "$rid: POST JSON body -> 202" "202" "$code"
  id="$(jq -r '.id' "$body")"
  assert_nonempty "$rid: returns a receipt id" "$id"
  assert_eq "$rid: echoes the canonical retailer id" "$rid" "$(jq -r '.retailer' "$body")"
  assert_eq "$rid: extracts the order id at upload" "$oid" "$(jq -r '.orderId' "$body")"
  assert_eq "$rid: queued" "queued" "$(jq -r '.status' "$body")"
  assert_eq "$rid: enrichment off by default" "false" "$(jq -r '.enrich' "$body")"
  assert_contains "$rid: statusUrl points at the shared receipt API" "$(jq -r '.statusUrl' "$body")" "/api/receipts/$id"

  # 2. a real worker, in another container, picks the job up off the tenant queue
  status="$(wait_for_receipt "$id")"
  assert_eq "$rid: processes to done on the real queue" "done" "$status"

  curl -fsS "$RE_TEST_BASE/api/receipts/$id" > "$body"
  assert_eq "$rid: record kind" "json" "$(jq -r '.kind' "$body")"
  assert_eq "$rid: record retailer" "$rid" "$(jq -r '.retailer' "$body")"
  assert_eq "$rid: extracted by the adapter, not an OCR engine" "retailer:$rid" \
    "$(jq -r '.extraction.provider' "$body")"
  assert_eq "$rid: no OCR text on this path" "null" "$(jq -r '.extraction.rawText' "$body")"
  assert_eq "$rid: canonical store name" "$want_store" "$(jq -r '.store.name' "$body")"
  assert_eq "$rid: line items" "$want_items" "$(jq -r '.items | length' "$body")"
  assert_eq "$rid: totals.itemCount is counted" "$want_items" "$(jq -r '.totals.itemCount' "$body")"
  assert_eq "$rid: receipt total" "$want_total" "$(jq -r '.totals.total' "$body")"
  assert_eq "$rid: line items reconcile with the subtotal" "true" "$(jq -r '.totals.subtotalMatch' "$body")"
  assert_nonempty "$rid: summary written" "$(jq -r '.summary' "$body")"
  assert_eq "$rid: every item carries the canonical fields" "0" \
    "$(jq -r '[.items[] | select((has("description") and has("price") and has("sku") and has("qty")) | not)] | length' "$body")"

  # 3. the worker read the payload blob back off the shared volume, and the API
  #    can serve the original bytes.
  code="$(curl -sS -o "$payload" -w '%{http_code}' "$RE_TEST_BASE/receipts/$id/payload")"
  assert_http "$rid: GET /receipts/:id/payload -> 200" "200" "$code"
  assert_eq "$rid: stored payload round-trips" "$oid" \
    "$(jq -r '.summary.orderId // .detail.id' "$payload")"

  # 4. it renders in the shared web view, linking to the payload not a photo
  code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/receipts/$id/view")"
  assert_http     "$rid: HTML view -> 200" "200" "$code"
  assert_contains "$rid: view links to the payload" "$(cat "$body")" "/receipts/$id/payload"

  # 5. and lists alongside photographed receipts
  curl -fsS "$RE_TEST_BASE/api/receipts" > "$body"
  assert_eq "$rid: appears in the receipt list" "1" \
    "$(jq -r --arg id "$id" '[.[] | select(.id == $id)] | length' "$body")"
done <<< "$RETAILER_CASES"

[ -n "$first_retailer" ] || die "RETAILER_CASES is empty"

# --- 6. multipart upload, the same shape a photo upload uses ------------------
# Re-resolve the first case's payload for the remaining, retailer-agnostic checks.
set -- $(printf '%s\n' "$RETAILER_CASES" | awk -F'|' 'NF>1{print $1" "$2" "$3" "$4; exit}')
RID="$1"; FDIR="$2"; FFILE="$3"; OID="$4"
SRC="$(resolve_payload "$RID" "$FDIR" "$FFILE" "$OID")" || die "no payload for $RID"

code="$(curl -sS -o "$body" -w '%{http_code}' -X POST \
        "$RE_TEST_BASE/api/retailer:$RID/receipts?dedupe=0" \
        -F "receipt=@$SRC;type=application/json" -F "source=acceptance-multipart")"
assert_http "multipart .json upload -> 202" "202" "$code"
assert_eq   "multipart upload records its source" "acceptance-multipart" \
  "$(curl -fsS "$RE_TEST_BASE/api/receipts/$(jq -r '.id' "$body")" | jq -r '.source')"

# --- 7. enrichment is opt-in for these ---------------------------------------
code="$(post_json "$RID" "$SRC" '?dedupe=0&enrich=1')"
assert_http "enrich=1 -> 202" "202" "$code"
assert_eq   "enrich=1 is recorded on the receipt" "true" \
  "$(curl -fsS "$RE_TEST_BASE/api/receipts/$(jq -r '.id' "$body")" | jq -r '.options.enrich')"

# --- 8. dedupe through real Redis --------------------------------------------
# A unique order id per run, so this is deterministic even against a stack kept
# up with --no-teardown.
UNIQUE="acc$$$(date +%s)"
jq --arg oid "$UNIQUE" \
   '.summary.orderId = $oid | .summary.purchaseOrderId = $oid | .detail.id = $oid' \
   "$SRC" > "$tmp_variant"

code="$(post_json "$RID" "$tmp_variant")"
assert_http "first ingest of a new order -> 202" "202" "$code"
first_id="$(jq -r '.id' "$body")"
assert_eq "first ingest reports the new order id" "$UNIQUE" "$(jq -r '.orderId' "$body")"

code="$(post_json "$RID" "$tmp_variant")"
assert_http "re-posting the same order -> 200" "200" "$code"
assert_eq   "returns the receipt already ingested" "$first_id" "$(jq -r '.id' "$body")"
assert_eq   "and says which one it duplicates" "$first_id" "$(jq -r '.duplicateOf' "$body")"

code="$(post_json "$RID" "$tmp_variant" '?dedupe=0')"
assert_http "dedupe=0 forces a fresh ingest -> 202" "202" "$code"
[ "$(jq -r '.id' "$body")" != "$first_id" ] \
  && pass "dedupe=0 created a different receipt" \
  || fail "dedupe=0 created a different receipt (got $first_id again)"

# --- 9. rejections ------------------------------------------------------------
code="$(post_json "no-such-retailer.example" "$SRC")"
assert_http     "unknown retailer -> 400" "400" "$code"
assert_contains "unknown-retailer error names what IS registered" "$(cat "$body")" "$RID"

printf '%s' '{"orderId":"1","store":"Costco","items":[{"name":"milk","price":3.5}]}' > "$tmp_variant"
code="$(post_json "$RID" "$tmp_variant")"
assert_http     "a payload for the wrong retailer -> 400" "400" "$code"
assert_contains "wrong-payload error names the retailer" "$(cat "$body")" "$RID"

printf '%s' 'not json at all' > "$tmp_variant"
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$RE_TEST_BASE/api/retailer:$RID/receipts" \
        -H 'content-type: application/json' --data-binary "@$tmp_variant")"
assert_http "malformed JSON -> 400" "400" "$code"

code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$RE_TEST_BASE/api/retailer:$RID/receipts" \
        -F "receipt=@$RE_TEST_SAMPLE" -F "source=acceptance")"
assert_http     "an image posted to the JSON endpoint -> 400" "400" "$code"
assert_contains "image rejection explains the endpoint" "$(cat "$body")" "JSON"

code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$RE_TEST_BASE/api/retailer:$RID/receipts" \
        -H 'content-type: application/json' -H "X-Tenant-Id: ghost$$" --data-binary "@$SRC")"
assert_http     "unknown tenant -> 400" "400" "$code"
assert_contains "unknown-tenant error names the tenant" "$(cat "$body")" "ghost$$"

# A photographed receipt has no payload to serve.
photo_id="$(ensure_receipt)"
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/receipts/$photo_id/payload")"
assert_http "payload endpoint on a photo receipt -> 404" "404" "$code"

report
