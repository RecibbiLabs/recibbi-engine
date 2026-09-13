'use strict';

const express = require('express');
const config = require('./config');
const logger = require('./logger');
const receipts = require('./routes/receipts');
const shares = require('./routes/shares');
const retailerReceipts = require('./routes/retailerReceipts');
const receiptProfiles = require('./routes/receiptProfiles');
const products = require('./routes/products');
const tenantsRoute = require('./routes/tenants');
const tenants = require('./tenants');
const profileStore = require('./receiptProfiles/profileStore');
const retailers = require('./retailers/registry');
const { cache } = require('./redis');

/**
 * Build the Express app: JSON parsing, health check, receipt routes, and the
 * shared error handler. Kept separate from server.js (which binds the port) so
 * the HTTP surface can be exercised in-process by the test suite.
 */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // 16mb so a product-cache import (POST /api/products/cache/import) of a large
  // exported cache fits; ordinary JSON bodies (applyProfile, etc.) are tiny.
  app.use(express.json({ limit: '16mb' }));

  // Health check (used by Docker/Podman healthcheck and the CLI).
  app.get('/health', async (req, res) => {
    let redis = 'down';
    try {
      redis = (await cache().ping()) === 'PONG' ? 'up' : 'unknown';
    } catch {
      redis = 'down';
    }
    const ok = redis === 'up';
    let receiptProfileCount = 0;
    try {
      receiptProfileCount = await profileStore.count(); // default tenant's profiles
    } catch {
      /* a profile-store read error shouldn't fail the health check */
    }
    let tenantCount = 0;
    try {
      tenantCount = (await tenants.list()).length;
    } catch {
      /* a registry read error shouldn't fail the health check */
    }
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      redis,
      persistence: config.persistence.backend,
      ocrProvider: config.ocrProvider,
      enrichment: config.enrich.enabled ? 'enabled' : 'disabled',
      tenants: tenantCount,
      defaultTenant: config.defaultTenantId || null,
      receiptProfiles: receiptProfileCount,
      retailers: retailers.list().map((r) => r.id),
      products: {
        enabled: config.products.enabled,
        resolver: config.products.resolver,
        emoji: config.products.emoji,
      },
      time: new Date().toISOString(),
    });
  });

  app.use(tenantsRoute);
  app.use(receipts);
  // Unlisted share links. Mounted after the receipt routes and before the
  // retailer ones for no reason other than reading order — its paths (/r/:token,
  // /api/shares/*, /api/receipts/:id/share) collide with nothing.
  app.use(shares);
  app.use(retailerReceipts);
  app.use(receiptProfiles);
  app.use(products);

  // Error handler (multer + identity + unexpected). An error carrying an
  // explicit numeric `status` (e.g. IdentityError) wins; otherwise size errors
  // map to 413 and everything else to 400.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status =
      Number.isInteger(err.status) ? err.status :
      err.message && /too large|file size/i.test(err.message) ? 413 : 400;
    logger.warn({ err: err.message }, 'request error');
    res.status(status).json({ error: err.message || 'request failed' });
  });

  return app;
}

module.exports = { createApp };
