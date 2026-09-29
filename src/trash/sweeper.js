'use strict';

// Emptying the trash on a schedule: TRASH_EMPTY_CRON, run by the worker.
//
// A BullMQ JOB SCHEDULER, not a setInterval. The worker already holds Redis and
// BullMQ, and a scheduler gives the two things a timer does not: the cron
// pattern is honoured exactly as written (BullMQ parses it with the same
// cron-parser src/trash/schedule.js checks it with at boot), and with more than
// one worker the sweep still runs ONCE per tick, because each tick is one job.
//
// ITS OWN QUEUE, `trash-sweep`. The receipt queues are `<QUEUE_NAME>-<tenant>`,
// one per tenant; the sweep is deployment-wide and belongs to none of them, and
// a name under that prefix could collide with a tenant called "sweep".
//
// The scheduler is UPSERTED at every start, under a fixed id, so a changed
// TRASH_EMPTY_CRON replaces the old pattern rather than adding a second one --
// and `off` removes it, so turning the sweep off really stops it.

const { Queue, Worker } = require('bullmq');
const config = require('../config');
const logger = require('../logger');
const { createConnection } = require('../redis');
const trash = require('./index');

const QUEUE = 'trash-sweep';
const SCHEDULER_ID = 'empty-trash';
const JOB = 'emptyTrash';

async function run() {
  const res = await trash.sweep();
  // Quiet unless it did something: at `* * * * * *` this runs every second.
  if (res.purged || res.failed) logger.info(res, 'trash swept');
  return res;
}

/** Register the schedule and start consuming it. Side-effecting; the worker calls it. */
async function start() {
  const queue = new Queue(QUEUE, { connection: createConnection() });
  const cron = config.trash.cron;
  if (!cron) {
    await queue.removeJobScheduler(SCHEDULER_ID);
    logger.info({ retention: trash.settings().retention.label }, 'trash sweep is OFF (TRASH_EMPTY_CRON=off); nothing is purged except by hand');
    return { queue, worker: null };
  }
  await queue.upsertJobScheduler(SCHEDULER_ID, { pattern: cron }, {
    name: JOB,
    opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } },
  });
  const worker = new Worker(QUEUE, run, { connection: createConnection(), concurrency: 1 });
  worker.on('failed', (job, err) => logger.error({ err: err.message }, 'trash sweep failed'));
  const s = trash.settings();
  logger.info({ cron, retention: s.retention.label, next: s.sweep.next }, 'trash sweep scheduled');
  return { queue, worker };
}

module.exports = { QUEUE, SCHEDULER_ID, JOB, run, start };
