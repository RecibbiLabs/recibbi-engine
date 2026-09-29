'use strict';

// The product catalogue over HTTP: a member's products, one card per product,
// narrowed, ordered and paged here -- the Products screen's data.
//
// SCOPED BY THE REQUESTING IDENTITY, like GET /api/receipts: the tenant and user
// come from X-Tenant-Id / X-User-Id (identity.resolveIdentity), never from a
// product id. A product id is a hash of a store and a till string, so it names
// nobody; what makes it somebody's is the scope it is looked up under. A
// stranger's id resolves to rows that do not exist under the asking scope and
// is a 404, the same answer an id that never existed gets.
//
// NOT /api/products, which is already taken, and by something different: the
// product RESOLVER's per-receipt result documents (src/routes/products.js).
// Those are one resolver run's answer about one receipt's lines; this is every
// product the member has bought, across the books. Two things, two paths.
//
// ux-main is the only caller in a deployment, and it is the one that enforces
// who may ask: the engine has no authentication and is reachable only on the
// compose network (see recibbi-ux-main/src/engine.js).

const express = require('express');
const identity = require('../identity');
const catalogue = require('../catalogue');
const query = require('../catalogue/query');

const router = express.Router();

/* The page size is the caller's -- ux-main pages by 24 -- and the ceiling is
   the receipts list's, for the receipts list's reason: `?more=40` is a URL a
   caller has to survive, and a thousand cards is not a page. */
const MAX_LIMIT = 500;

function refuse(res, err, next) {
  if (err && (err.name === 'CatalogueError' || err.name === 'IdentityError')) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  return next(err);
}

/**
 * GET /api/catalogue -- a page of the member's products, and what it is a page OF.
 *
 *   ?category= &store= &named= &tag=   repeated, OR within a group, AND across
 *   ?times_min= &times_max=            on how many receipts, inclusive
 *   ?sort=                             recent (default) | earliest | most_often |
 *                                      least_often | most_spent | least_spent |
 *                                      name_az | name_za
 *   ?limit= &offset=                   the slice, AFTER the filter and the order
 *
 * Answers { records, total, matched, receipts, limit, offset, more, facets,
 * unpictured } -- the books' envelope, counted in products. See
 * src/catalogue/query.js page().
 */
router.get('/api/catalogue', async (req, res, next) => {
  try {
    const scope = identity.resolveIdentity(req);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 24), MAX_LIMIT);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const body = await catalogue.page(scope, {
      filters: query.parse(req.query),
      sort: query.sortOrDefault(req.query.sort),
      limit,
      offset,
    });
    res.json(body);
  } catch (err) {
    refuse(res, err, next);
  }
});

/**
 * Rebuild the requesting member's catalogue from their receipts. The one-off
 * backfill, per member -- scripts/catalogue.js runs it over every member.
 * Registered before /:id so "rebuild" is never read as a product id.
 */
router.post('/api/catalogue/rebuild', async (req, res, next) => {
  try {
    res.json(await catalogue.rebuild(identity.resolveIdentity(req)));
  } catch (err) {
    refuse(res, err, next);
  }
});

/** Does the stored catalogue say what the receipts say? Writes nothing. */
router.get('/api/catalogue/verify', async (req, res, next) => {
  try {
    res.json(await catalogue.verify(identity.resolveIdentity(req)));
  } catch (err) {
    refuse(res, err, next);
  }
});

router.get('/api/catalogue/:id', async (req, res, next) => {
  try {
    const prod = await catalogue.get(identity.resolveIdentity(req), req.params.id);
    if (!prod) return res.status(404).json({ error: 'not found' });
    res.json(prod);
  } catch (err) {
    refuse(res, err, next);
  }
});

/**
 * PATCH /api/catalogue/:id { title?, brand?, category? } -- the member naming a
 * product. Written onto every line of it on every receipt it was on, all or
 * none, and remembered for the next receipt it turns up on. Answers the product
 * as it now stands. See catalogue.nameProduct().
 */
router.patch('/api/catalogue/:id', async (req, res, next) => {
  try {
    res.json(await catalogue.nameProduct(identity.resolveIdentity(req), req.params.id, req.body));
  } catch (err) {
    refuse(res, err, next);
  }
});

module.exports = router;
