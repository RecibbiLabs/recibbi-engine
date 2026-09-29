'use strict';

// The trash, over HTTP. See src/trash/index.js for what each operation does and
// why only one of them destroys anything.
//
//   GET  /api/trash                  this identity's trash, and the settings
//   GET  /api/trash/settings         the settings alone
//   POST /api/receipts/:id/trash     out of the books      { by?: member|recibbi }
//   POST /api/receipts/:id/restore   back into them
//   POST /api/receipts/:id/purge     GONE -- refused unless already in the trash
//
// THE PURGE IS A POST TO A PATH THAT SAYS SO, not a DELETE on the receipt. A
// `DELETE /api/receipts/:id` reads as the ordinary way to remove something,
// and a client ported from somewhere that meant "move to the trash" by it would
// destroy receipts. Nothing is named so it can be reached by accident.
//
// A trashed receipt is still answered by GET /api/receipts/:id -- with
// `deletedAt`, `deletedBy` and a derived `purgeAt` -- because the trash page
// opens it and the receipt page says it is in the trash rather than 404ing on
// something the member can still put back.

const express = require('express');
const identity = require('../identity');
const trash = require('../trash');

const router = express.Router();

function fail(res, next, err) {
  if (err instanceof trash.TrashError) return res.status(err.status).json({ error: err.message });
  next(err);
}

router.get('/api/trash', async (req, res, next) => {
  try {
    const { tenantId, userId } = identity.resolveIdentity(req);
    res.json({ records: await trash.list({ tenantId, userId }), ...trash.settings() });
  } catch (err) {
    fail(res, next, err);
  }
});

// The settings alone -- how long, and when the next sweep is -- for a page that
// draws one receipt and has no reason to read the whole trash to say "30 days".
// Deployment-wide, so it takes no identity.
router.get('/api/trash/settings', (req, res) => {
  res.json(trash.settings());
});

router.post('/api/receipts/:id/trash', async (req, res, next) => {
  try {
    const by = (req.body && req.body.by) || 'member';
    res.json(trash.row(await trash.trash(req.params.id, { by })));
  } catch (err) {
    fail(res, next, err);
  }
});

router.post('/api/receipts/:id/restore', async (req, res, next) => {
  try {
    const record = await trash.restore(req.params.id);
    res.json({ id: record.id, restored: true });
  } catch (err) {
    fail(res, next, err);
  }
});

router.post('/api/receipts/:id/purge', async (req, res, next) => {
  try {
    res.json(await trash.purge(req.params.id));
  } catch (err) {
    fail(res, next, err);
  }
});

module.exports = router;
