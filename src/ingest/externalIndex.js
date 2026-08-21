'use strict';

// External-id -> receipt-id index, so re-posting an order a sync tool has
// already sent returns the receipt that exists instead of creating a duplicate.
// A photographed receipt has no stable external identity; a retailer payload
// does (its order id), which is what makes this possible at all.
//
// The index lives in Redis, not in the durable record store, because it is an
// OPTIMIZATION and not a constraint: an eviction or a cold Redis degrades to
// the old behavior — a second record for the same order — rather than losing
// data or blocking an upload. Scoped per tenant+user, like the enrichment cache.

const config = require('../config');
const logger = require('../logger');
const { cache } = require('../redis');

function keyFor({ tenantId, userId }, externalId) {
  return `${tenantId}:${userId}:ingest:ext:${externalId}`;
}

/** The receipt id already ingested for this external id, or null. */
async function get(scope, externalId) {
  if (!config.retailers.dedupe || !externalId) return null;
  try {
    return await cache().get(keyFor(scope, externalId));
  } catch (err) {
    logger.warn({ err: err.message }, 'ingest dedupe index read failed');
    return null;
  }
}

async function put(scope, externalId, receiptId) {
  if (!config.retailers.dedupe || !externalId) return;
  try {
    await cache().set(keyFor(scope, externalId), receiptId, 'EX', config.retailers.dedupeTtlSeconds);
  } catch (err) {
    logger.warn({ err: err.message }, 'ingest dedupe index write failed');
  }
}

module.exports = { get, put, keyFor };
