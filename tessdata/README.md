# tessdata — offline Tesseract language data

Drop the English language data here so the offline OCR path works **without**
downloading from the jsdelivr CDN (which a TLS-intercepting proxy may block).

Place the **uncompressed** `eng.traineddata` in this directory. It must not be
gzipped: `src/ocr/tesseract.js` passes `gzip: false`, so both the cache read and
the langPath fallback look for the plain file. A `.gz` here is not picked up.

The blob this project pins (and checksums in `scripts/SHA256SUMS.txt`) is the
full `tessdata_best` English LSTM model, served uncompressed:

    curl -fL https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/eng.traineddata -o eng.traineddata

`scripts/fetch-tessdata.sh` does exactly this and verifies the checksum. Note
that jsdelivr's `@tesseract.js-data/eng` `4.0.0_best_int` asset is a *different*
(int8-quantized, 5.2 MB) build and will fail that check.

## Orientation data (recommended) — `osd.traineddata`

The OCR path runs Tesseract's OSD (orientation & script detection) so a sideways
or upside-down phone photo is auto-rotated before recognition. That needs
`osd.traineddata` in this directory (uncompressed, ~10 MB). Without it the code
still runs — it just logs a warning and skips orientation correction (set
`TESSERACT_OSD=0` to skip it deliberately). Fetch it from the official Tesseract
data repo:

    curl -fL https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/osd.traineddata -o osd.traineddata

Both `*.traineddata` files are gitignored (they're large binaries), so each
build environment must place them here before `docker build` / `podman build`
copies them into the image.

See `../test/README.md` ("TLS-intercepting proxy gotcha") for the Colab snippet and
the full story. Once the file is here:

    npm run test:live:tesseract     # should now OCR the sample instead of skipping

The code points Tesseract at this folder via `config.tessdataDir`
(override with the `TESSDATA_PATH` env var, e.g. a mounted volume in Docker).
