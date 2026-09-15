'use strict';

// Retailer JSON ingest — the structured counterpart of the photo upload in
// routes/receipts.js. See docs/RETAILER-INGEST.md.
//
//   POST /api/retailer:<retailerId>/receipts
//   GET  /api/retailers
//
// The retailer id is part of the path rather than a field because it selects
// the SCHEMA the body is read against: `samsclub.com` and `costco.com` post
// entirely different documents to the same verb, and a client should not be
// able to mismatch them silently. It is resolved through the adapter registry
// (a Map lookup) and never used as a module or filesystem path.
//
// Two body encodings, both accepted:
//   Content-Type: application/json      the payload itself; options via query
//   multipart/form-data                 a .json file under `receipt` (or
//                                       `file`/`payload`), options as fields
// The multipart form mirrors the photo upload, so the CLI and any existing
// uploader keep one shape for both kinds.

const express = require('express');
const multer = require('multer');
const config = require('../config');
const store = require('../store');
const registry = require('../retailers/registry');
const retailerIngest = require('../retailers/ingestService');
const accept = require('../ingest/acceptService');
const externalIndex = require('../ingest/externalIndex');
const logger = require('../logger');

const router = express.Router();

// Payload uploads are JSON documents, not images, so this needs its own multer
// instance: a different size cap (payloads are tens of KB, photos are MBs) and
// a filter that accepts JSON instead of image/*.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.retailers.maxPayloadBytes },
  fileFilter: (req, file, cb) => {
    if (/^application\/(json|octet-stream)$/.test(file.mimetype) || /\.json$/i.test(file.originalname || '')) {
      return cb(null, true);
    }
    cb(new Error('Only JSON receipt payloads are accepted on this endpoint'));
  },
});

// Registered adapters, so a client can discover which retailers this deployment
// can read before it posts anything.
router.get('/api/retailers', (req, res) => {
  res.json(registry.list());
});

/**
 * Pull the payload out of whichever encoding was used, returning the raw bytes
 * alongside the parsed object. The BYTES are what gets stored — re-serializing
 * would quietly rewrite the provenance we are keeping.
 */
function payloadFrom(req) {
  const file =
    (req.files?.receipt && req.files.receipt[0]) ||
    (req.files?.file && req.files.file[0]) ||
    (req.files?.payload && req.files.payload[0]);

  if (file) {
    let parsed;
    try {
      parsed = JSON.parse(file.buffer.toString('utf8'));
    } catch (err) {
      throw new accept.AcceptError(400, `uploaded file is not valid JSON: ${err.message}`);
    }
    return { bytes: file.buffer, parsed, originalName: file.originalname || null };
  }

  // JSON body (parsed by express.json in app.js).
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
    throw new accept.AcceptError(
      400,
      'No receipt payload. POST the retailer JSON as the request body (Content-Type: application/json), or upload it as a "receipt" file.'
    );
  }
  return { bytes: Buffer.from(JSON.stringify(body)), parsed: body, originalName: null };
}

router.post(
  '/api/retailer::retailerId/receipts',
  (req, res, next) => {
    // Only run multer on a multipart body; a JSON body is already parsed.
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();
    upload.fields([
      { name: 'receipt', maxCount: 1 },
      { name: 'file', maxCount: 1 },
      { name: 'payload', maxCount: 1 },
    ])(req, res, next);
  },
  async (req, res, next) => {
    try {
      const retailerId = req.params.retailerId;
      const { bytes, parsed, originalName } = payloadFrom(req);
      if (bytes.length > config.retailers.maxPayloadBytes) {
        throw new accept.AcceptError(413, `payload exceeds ${config.retailers.maxPayloadBytes} bytes`);
      }

      // Reject an unknown retailer or a mis-routed payload NOW, synchronously,
      // rather than queueing a job that fails three times with the answer.
      const { adapter, origin } = retailerIngest.acceptPayload(retailerId, parsed);

      // `retailerId` is what lets the member's own "Enrich with retailer
      // product page" setting apply to this import. Passed as the ADAPTER's id
      // rather than the URL's spelling, so `sams-club` and `samsclub.com` reach
      // one row of settings instead of two.
      const ctx = await accept.resolveContext(req, {
        enrichByDefault: config.retailers.enrichByDefault,
        retailerId: adapter.id,
      });
      const scope = { tenantId: ctx.tenantId, userId: ctx.userId };

      // A sync tool replaying its history posts the same order more than once.
      // Return what already exists instead of a second copy of it.
      if (accept.requestFlag(req, 'dedupe', config.retailers.dedupe)) {
        const existing = await externalIndex.get(scope, origin.externalId);
        if (existing) {
          const record = await store.get(existing);
          if (record) {
            logger.info({ id: record.id, retailer: adapter.id, orderId: origin.orderId }, 'retailer receipt already ingested; returning existing');
            return res.status(200).json({
              ...accept.acceptedBody(record, ctx),
              status: record.status,
              duplicateOf: record.id,
              orderId: origin.orderId,
            });
          }
        }
      }

      const record = await store.createRetailerReceipt({
        payload: bytes,
        retailer: adapter.id,
        originalName: originalName || (origin.orderId ? `${origin.orderId}.json` : null),
        source: ctx.source,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        origin,
        options: { enrich: ctx.enrich, enrichSource: ctx.enrichSource },
      });

      await externalIndex.put(scope, origin.externalId, record.id);
      await accept.enqueueFor(record, ctx);
      logger.info(
        {
          id: record.id,
          retailer: adapter.id,
          orderId: origin.orderId,
          source: record.source,
          profileId: ctx.profile ? ctx.profile.id : null,
          enrich: ctx.enrich,
        },
        'retailer receipt accepted and queued'
      );

      res.status(202).json({
        ...accept.acceptedBody(record, ctx),
        retailer: adapter.id,
        orderId: origin.orderId,
        displayId: origin.displayId,
        enrich: ctx.enrich,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Serve a JSON receipt's stored payload — the provenance link on the receipt
// view, and how a client re-reads what it sent. Only `kind: 'json'` receipts
// have one; a photo lives at /receipts/:id/image.
router.get('/receipts/:id/payload', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    if (record.kind !== 'json' || !record.document) {
      return res.status(404).json({ error: 'this receipt has no JSON payload (it was uploaded as an image)' });
    }
    if (record.document.discarded) {
      return res.status(410).json({ error: 'payload was discarded after processing (RETAILER_STORE_RAW_PAYLOAD=0)' });
    }
    res.type('application/json').sendFile(store.documentPathFor(record));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
