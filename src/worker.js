'use strict';

const { Worker } = require('bullmq');
const config = require('./config');
const logger = require('./logger');
const { createConnection } = require('./redis');
const store = require('./store');
const tenants = require('./tenants');
const { queueNameFor } = require('./queue');
const { processReceipt } = require('./pipeline');
const applyService = require('./receiptProfiles/applyService');
const resolveService = require('./products/resolveService');

/**
 * Pure job dispatcher — routes on job.name so it can be unit-tested without
 * Redis. `process-receipt` keeps its original name for backward compatibility;
 * `applyProfile` and `resolveProducts` (camelCase, the project convention) are
 * the later additions.
 *   - process-receipt: run the OCR pipeline (extract -> parse -> enrich -> summarize).
 *   - applyProfile:     apply a profile to an (already processed) receipt.
 *   - resolveProducts:  map a profile result's line items to products.
 * In an upload-time flow all three run bottom-up: process-receipt -> applyProfile
 * -> resolveProducts, so products are resolved from the freshly-applied profile.
 */
async function dispatch(job) {
  const { receiptId, profileId } = job.data;
  switch (job.name) {
    case 'process-receipt':
      logger.info({ jobId: job.id, receiptId, attempt: job.attemptsMade + 1 }, 'processing receipt');
      return processReceipt(receiptId);
    case 'applyProfile':
      logger.info({ jobId: job.id, receiptId, profileId, attempt: job.attemptsMade + 1 }, 'applying profile');
      return applyService.applyProfileToReceipt(receiptId, profileId);
    case 'resolveProducts':
      logger.info({ jobId: job.id, receiptId, profileId, attempt: job.attemptsMade + 1 }, 'resolving products');
      return resolveService.resolveProductsForProfileResult(receiptId, profileId);
    default:
      throw new Error(`unknown job name: ${job.name}`);
  }
}

/**
 * Mark the durable record failed when a processing job will not run again: on
 * its final attempt, or on ANY attempt when it failed unrecoverably (BullMQ
 * does not retry an UnrecoverableError, so waiting for the last attempt would
 * leave the receipt in "processing" forever). An applyProfile failure leaves
 * the receipt record untouched.
 */
async function markFailedIfFinal(job, err) {
  if (!job || job.name !== 'process-receipt') return false;
  const unrecoverable = !!err && err.name === 'UnrecoverableError';
  if (!unrecoverable && job.attemptsMade < (job.opts.attempts || config.jobAttempts)) return false;
  try {
    await store.update(job.data.receiptId, { status: 'failed', error: err.message });
    return true;
  } catch (e) {
    logger.error({ err: e.message }, 'could not mark receipt failed');
    return false;
  }
}

// Build a BullMQ Worker for one tenant's queue. Each tenant has its own queue
// (receipts:<tenant>) so a tenant's jobs are isolated; the dispatcher is shared
// (receiptIds are composite, so the services resolve scope from the id itself).
function makeTenantWorker(tenantId) {
  const connection = createConnection();
  const worker = new Worker(queueNameFor(tenantId), dispatch, {
    connection,
    concurrency: config.queueConcurrency,
  });

  worker.on('completed', (job) => {
    logger.info({ tenantId, jobId: job.id, name: job.name, receiptId: job.data.receiptId }, 'job completed');
  });

  worker.on('failed', async (job, err) => {
    logger.error(
      { tenantId, jobId: job?.id, name: job?.name, receiptId: job?.data?.receiptId, attempt: job?.attemptsMade, err: err.message },
      'job failed'
    );
    await markFailedIfFinal(job, err);
  });

  logger.info({ tenantId, queue: queueNameFor(tenantId), concurrency: config.queueConcurrency }, 'tenant worker started');
  return worker;
}

/** Start the BullMQ worker(s). Side-effecting (opens Redis); called only when
 *  this module is run directly (`node src/worker.js`), so requiring it for unit
 *  tests never touches Redis. Runs one Worker per registered tenant queue and
 *  polls the tenant registry so tenants onboarded at runtime are picked up. */
function start() {
  const workers = new Map(); // tenantId -> Worker
  const watchMs = Number(process.env.TENANT_WATCH_MS) || 5000;

  // Add Workers for any registered tenants we aren't yet consuming.
  async function sync() {
    try {
      for (const tenantId of await tenants.list()) {
        if (!workers.has(tenantId)) workers.set(tenantId, makeTenantWorker(tenantId));
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'tenant queue sync failed');
    }
  }

  let timer = null;
  (async () => {
    await tenants.hydrate(); // repopulate the Redis SET from the durable list
    await tenants.ensureDefault(); // the default tenant always has a queue
    await sync();
    timer = setInterval(sync, watchMs);
    timer.unref();
  })();

  logger.info({ ocr: config.ocrProvider, watchMs }, 'worker started (per-tenant queues)');

  function shutdown(sig) {
    logger.info({ sig }, 'shutting down worker');
    if (timer) clearInterval(timer);
    Promise.all([...workers.values()].map((w) => w.close())).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { workers, sync };
}

if (require.main === module) start();

module.exports = { dispatch, markFailedIfFinal, start };
