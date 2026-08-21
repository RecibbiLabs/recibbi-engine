'use strict';

const express = require('express');
const multer = require('multer');
const config = require('../config');
const store = require('../store');
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

router.get('/api/receipts', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    // List only the requesting identity's receipts (header/default scope).
    const { tenantId, userId } = identity.resolveIdentity(req);
    const records = await store.list({ tenantId, userId, limit });
    res.json(
      records.map((r) => ({
        id: r.id,
        status: r.status,
        store: r.store,
        itemCount: r.totals ? r.totals.itemCount : 0,
        createdAt: r.createdAt,
        ...links(r.id),
      }))
    );
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
