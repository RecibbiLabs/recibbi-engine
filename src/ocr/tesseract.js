'use strict';

const fs = require('fs');
const path = require('path');
const { UnrecoverableError } = require('bullmq');
const { createWorker } = require('tesseract.js');
const config = require('../config');
const logger = require('./../logger');
const { imagePathFor } = require('../store');

/**
 * Returns raw OCR text only. The heuristic parser turns this into line items.
 *
 * Pipeline: detect page orientation with Tesseract OSD, then recognize with the
 * orientation corrected. A phone photo shot sideways or upside-down therefore
 * reads correctly without manual pre-rotation.
 *
 * The English (and OSD) trained-data is loaded from the local tessdata dir (see
 * config.tessdataDir), so this runs fully offline — no jsdelivr CDN download.
 * HEIC images are not supported by tesseract; convert to JPEG/PNG before
 * sending if you use this provider.
 *
 * @returns {Promise<{ rawText: string|null, structured: object|null }>}
 */
async function extract(record) {
  const imgPath = imagePathFor(record);

  // Local tessdata dir doubles as cache and offline lang-path. We ship the
  // *uncompressed* eng.traineddata (and osd.traineddata), so gzip:false makes
  // both the cache read and the langPath fallback target the uncompressed files;
  // the default gzip:true would look for `*.traineddata.gz` (which we do NOT
  // ship) and fail with ENOENT. The dir must exist for the cache write-back.
  const tessdataDir = config.tessdataDir;
  try {
    fs.mkdirSync(tessdataDir, { recursive: true });
  } catch {
    /* non-fatal: the check below names the missing file */
  }

  // FAIL FAST WHEN THE LANGUAGE DATA IS NOT THERE. tesseract.js does not reject
  // on a missing traineddata: with an errorHandler set, the load failure leaves
  // its startup promise unsettled, so the call sat out the whole
  // TESSERACT_TIMEOUT_MS and then the queue retried it -- three attempts, about
  // six minutes of "processing" -- for a file that was never going to appear.
  // It is a deployment fault, not a transient one, so it is UNRECOVERABLE: the
  // queue fails the job on this attempt and src/worker.js marks the receipt
  // failed with this message, which says what to do about it.
  if (!hasData(tessdataDir, 'eng')) {
    throw new UnrecoverableError(
      `tesseract OCR cannot run: ${path.join(tessdataDir, 'eng.traineddata')} is missing. ` +
        'Fetch it with scripts/fetch-tessdata.sh and rebuild, or give the engine a vision model key (VISION_PROVIDER).' +
        visionWhy()
    );
  }

  // Without an errorHandler, tesseract.js does `throw Error(...)` inside its
  // worker's message handler on any load/recognize failure. That throw is an
  // UNCAUGHT exception: it bypasses try/catch and kills the whole worker process
  // (every in-flight job dies; BullMQ flow parents then cascade as "child
  // failed"). Supplying one keeps the failure inside the promise chain.
  const workerOpts = {
    langPath: tessdataDir,
    cachePath: tessdataDir,
    gzip: false,
    errorHandler: (err) => {
      logger.error({ id: record.id, err: String(err) }, 'tesseract worker error');
    },
    logger: () => {},
  };

  let result;
  try {
    result = await withTimeout(runOcr(record, imgPath, workerOpts), config.tesseractTimeoutMs);
  } catch (err) {
    // Surface as a normal rejection so the pipeline marks the job failed and the
    // worker stays alive to process other receipts.
    throw new Error(`tesseract OCR failed: ${err && err.message ? err.message : err}`);
  }

  return { rawText: result, structured: null };
}

/**
 * Detect orientation (best-effort), then recognize with it corrected.
 */
async function runOcr(record, imgPath, workerOpts) {
  let rotateRadians = 0;
  // OSD is optional: without osd.traineddata the worker would hang exactly as
  // above, so it is skipped rather than attempted, and recognition falls back
  // to skew-only auto-rotation.
  if (config.tesseractOsd && !hasData(config.tessdataDir, 'osd')) {
    logger.info({ id: record.id }, 'tesseract: no osd.traineddata -- skipping orientation detection');
  } else if (config.tesseractOsd) {
    const orient = await detectOrientation(record, imgPath, workerOpts);
    if (orient && orient.degrees && orient.confidence >= config.tesseractOsdMinConfidence) {
      rotateRadians = (orient.degrees * Math.PI) / 180;
    }
  }

  // Recognize with the LSTM-only model (oem 1 -> the lighter, cleaner core).
  // rotateRadians corrects the OSD-detected quadrant; when there's nothing to
  // correct, rotateAuto fixes residual skew instead (the two are mutually
  // exclusive in tesseract.js). NB: recognition options must go to
  // worker.recognize() — the Tesseract.recognize() convenience drops them.
  const worker = await createWorker('eng', 1, workerOpts);
  try {
    const recOpts = rotateRadians ? { rotateRadians } : { rotateAuto: true };
    const { data } = await worker.recognize(imgPath, recOpts);
    logger.debug({ id: record.id, rotateRadians }, 'tesseract: recognition complete');
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

/**
 * Run Tesseract OSD to find the page rotation in 90° steps. Uses the legacy/OSD
 * core (oem 0) + osd.traineddata; recognition stays on the LSTM core because the
 * OSD core produces noisier text. Best-effort: returns null (skip orientation
 * correction) if osd.traineddata is missing or detection throws.
 *
 * @returns {Promise<{ degrees: number, confidence: number }|null>}
 */
async function detectOrientation(record, imgPath, workerOpts) {
  let worker;
  try {
    worker = await createWorker('osd', 0, workerOpts);
    const { data } = await worker.detect(imgPath);
    // Snap to the nearest quadrant and normalize to [0, 360).
    const degrees = (((Math.round((data.orientation_degrees || 0) / 90) * 90) % 360) + 360) % 360;
    const confidence = data.orientation_confidence ?? 0;
    logger.debug({ id: record.id, degrees, confidence }, 'tesseract: OSD orientation');
    return { degrees, confidence };
  } catch (err) {
    logger.warn(
      { id: record.id, err: String(err && err.message ? err.message : err) },
      'tesseract: OSD unavailable — skipping orientation correction'
    );
    return null;
  } finally {
    if (worker) await worker.terminate();
  }
}

/**
 * Why no vision reader took this photo instead, when that is why Tesseract has
 * it (OCR_PROVIDER=auto found none usable). The two failures are one story, and
 * an operator reading only the first half would go looking for tessdata.
 */
function visionWhy() {
  try {
    const providerOrder = require('../settings/providerOrder');
    const p = providerOrder.pick('vision');
    return p.chosen ? '' : ` (No vision reader could take it: ${providerOrder.explain(p.skipped)}.)`;
  } catch {
    return '';
  }
}

/** Is `<lang>.traineddata` in the tessdata dir, uncompressed and non-empty (gzip:false above)? */
function hasData(dir, lang) {
  try {
    return fs.statSync(path.join(dir, `${lang}.traineddata`)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Reject if `promise` doesn't settle within `ms`. tesseract.js has no internal
 * timeout, and with an errorHandler set a *language-load* failure leaves its
 * startup promise unsettled (the library swallows that rejection), so a call
 * would otherwise hang forever. This bounds it.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { extract };
