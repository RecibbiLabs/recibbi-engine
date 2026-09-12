'use strict';

const express = require('express');
const multer = require('multer');
const config = require('../config');
const store = require('../store');
const receiptQuery = require('../receiptQuery');
const accept = require('../ingest/acceptService');
const identity = require('../identity');
const view = require('../web/view');
const logger = require('../logger');

const router = express.Router();

// Identity resolution, tenant + profile checks, flow selection and the 202 body
// are shared with retailer JSON ingest — see src/ingest/acceptService.js. This
// route only decides what a *photo* upload is.
const { links } = accept;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image uploads are accepted'));
  },
});

// --- REST API ---

// Upload a receipt image. Field name: "receipt" (also accepts "file"/"image").
router.post(
  '/api/receipts',
  (req, res, next) =>
    upload.fields([
      { name: 'receipt', maxCount: 1 },
      { name: 'file', maxCount: 1 },
      { name: 'image', maxCount: 1 },
    ])(req, res, next),
  async (req, res, next) => {
    try {
      const f =
        (req.files?.receipt && req.files.receipt[0]) ||
        (req.files?.file && req.files.file[0]) ||
        (req.files?.image && req.files.image[0]);
      if (!f) return res.status(400).json({ error: 'No image uploaded. Use field "receipt".' });

      // Identity, tenant check, optional profile, flow depth (shared with the
      // retailer JSON path). A photographed receipt enriches by default — that
      // lookup is where its product images come from.
      const ctx = await accept.resolveContext(req, { enrichByDefault: true });

      const record = await store.createReceipt({
        buffer: f.buffer,
        mimeType: f.mimetype,
        originalName: f.originalname,
        source: ctx.source,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        options: { enrich: ctx.enrich },
      });

      await accept.enqueueFor(record, ctx);
      logger.info(
        {
          id: record.id,
          source: record.source,
          profileId: ctx.profile ? ctx.profile.id : null,
          products: ctx.wantsProducts,
        },
        'receipt accepted and queued'
      );

      res.status(202).json(accept.acceptedBody(record, ctx));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * The summary row: what a list has always returned.
 *
 * `itemCount` is NULL, not 0, for a receipt nobody has read yet. It used to be
 * 0, and 0 is a claim -- "this basket is empty" -- about a receipt whose items
 * have not been extracted. A caller cannot tell that zero from a genuinely
 * empty one, and the difference is the whole reason `status` exists. Null is
 * the honest answer and renders as an em dash.
 */
function summaryRow(r) {
  return {
    id: r.id,
    status: r.status,
    store: r.store,
    itemCount: receiptQuery.itemCount(r),
    createdAt: r.createdAt,
    ...links(r.id),
  };
}

/**
 * The row a LIST CARD is drawn from.
 *
 * Everything the summary carries, plus the four things a list has to show and
 * could not: where the receipt came in (`source`), what it came to (`totals`),
 * what was in it (`items`, which is the enriched basket) and whether it
 * balanced. Without them a caller has to fetch every row's full record one at a
 * time to draw a list -- which is exactly what recibbi-ux-main was doing, six
 * at a time, and what its own comment said belonged here instead.
 *
 * WHAT IS LEFT OUT IS LEFT OUT ON PURPOSE. `extraction.rawText` is the entire
 * OCR dump and can be larger than everything else combined; the blob descriptor
 * is an internal filename; `timings` is operational. A list of 24 should not
 * carry a megabyte of text nobody is going to render. `image` survives as a
 * boolean, because whether a receipt HAS a photograph decides whether a card
 * offers one -- the filename does not.
 */
function cardRow(r) {
  return {
    ...summaryRow(r),
    kind: r.kind,
    source: r.source,
    image: Boolean(r.image),
    retailer: r.retailer || null,
    orderId: r.orderId || null,
    items: r.items || [],
    totals: r.totals || null,
    summary: r.summary || null,
    reconciled: r.reconciled === undefined ? null : r.reconciled,
    error: r.error || null,
    extraction: { provider: (r.extraction && r.extraction.provider) || null },
    updatedAt: r.updatedAt,
  };
}

/**
 * GET /api/receipts -- a page of the member's receipts, newest first.
 *
 * TWO SHAPES, AND THE OLD ONE IS UNTOUCHED. Without `envelope=1` this answers
 * with the bare array it always has, so the CLI and anything else pointed at it
 * keep working. With it, the answer is an object carrying the page AND the two
 * numbers that say what it is a page of:
 *
 *   { records, total, matched, limit, offset, more, facets }
 *
 * `total` is the books; `matched` is what the filters leave; neither is
 * `records.length`, which is a fact about how far the caller has paged. A list
 * heading that counts the rows it was handed tells a member with 1,284 receipts
 * that 1,260 of them have gone missing.
 *
 * THE FILTERS APPLY TO BOTH SHAPES, because a narrowed array is still a useful
 * array; only the counts and the facets need the envelope to have anywhere to
 * go. See src/receiptQuery.js for the predicate and the two traps in it.
 */
router.get('/api/receipts', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const envelope = req.query.envelope === '1' || req.query.envelope === 'true';
    const filters = receiptQuery.parse(req.query);

    // List only the requesting identity's receipts (header/default scope).
    const { tenantId, userId } = identity.resolveIdentity(req);
    const page = await store.query({
      tenantId,
      userId,
      filter: (r) => receiptQuery.matches(r, filters),
      limit,
      offset,
    });

    if (!envelope) return res.json(page.records.map(summaryRow));

    res.json({
      records: page.records.map(cardRow),
      total: page.total,
      matched: page.matched,
      limit,
      offset,
      more: offset + page.records.length < page.matched,
      facets: receiptQuery.facets(page.all, filters),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/api/receipts/:id', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ ...record, ...links(record.id) });
  } catch (err) {
    next(err);
  }
});

// --- Web views ---

router.get('/receipts/:id/image', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).send('not found');
    res.type(record.image.mimeType || 'application/octet-stream');
    res.sendFile(store.imagePathFor(record));
  } catch (err) {
    next(err);
  }
});

router.get('/receipts/:id/view', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).send('Receipt not found');
    res.type('html').send(view.renderReceipt(record));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const records = await store.list({ limit: 100 });
    res.type('html').send(view.renderList(records));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
