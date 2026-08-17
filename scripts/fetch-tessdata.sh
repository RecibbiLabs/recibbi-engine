#!/usr/bin/env bash
# Fetch the offline Tesseract language data this repo needs at runtime:
#   tessdata/eng.traineddata   English LSTM model  (tessdata_best, uncompressed)
#   tessdata/osd.traineddata   orientation & script detection (auto-rotate)
#
# Both are gitignored large binaries, so a fresh clone/worktree lacks them and
# Dockerfile's `COPY . .` would bake an EMPTY tessdata into the image (OCR then
# fails at runtime with a cryptic "tesseract worker error"). Run this first.
#
# Usage:
#   scripts/fetch-tessdata.sh [--auto|--local|--network]
#
# Source selection (SOURCE_MODE, default auto):
#   --local    copy from the known-good sibling checkout ($SOURCE_REPO/tessdata)
#   --network  download from the CDN / Tesseract data repo
#   --auto     local if present, else network  (default)
#
# Every byte is verified against scripts/SHA256SUMS.txt before it is accepted.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

parse_source_flag "${1:-}" || die "unknown flag '$1' (use --auto|--local|--network)"

# Network sources (used only when copying from the local sibling isn't possible).
# NOTE: jsdelivr is frequently TLS-blocked on this network — the local/auto path
# is the reliable one. The blob pinned in SHA256SUMS.txt is the full LSTM
# tessdata_best English model (15.4 MB), served uncompressed from the Tesseract
# data repo. (jsdelivr's @tesseract.js-data/eng 4.0.0_best_int asset is a
# DIFFERENT, int8-quantized 5.2 MB build and fails the checksum.)
ENG_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/eng.traineddata"
OSD_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/osd.traineddata"

log "fetching Tesseract data (mode=$SOURCE_MODE, source repo=$SOURCE_REPO)"

# Both blobs are served uncompressed, so the generic local-or-network helper
# handles them (it verifies against SHA256SUMS.txt either way).
obtain_blob "tessdata/eng.traineddata" "$ENG_URL"
obtain_blob "tessdata/osd.traineddata" "$OSD_URL"

ok "Tesseract data ready in $REPO_ROOT/tessdata"
log "next: npm run test:live:tesseract   (should OCR instead of skipping)"
