'use strict';

// A per-key serializer for read-modify-write on a settings document.
//
// WHY THIS IS NEEDED AT ALL. Both persistence backends replace a document
// whole: `put()` is an upsert of the entire JSON, not a field update. Every
// write here is therefore read-modify-write, and two of them interleaved lose
// one of the two changes:
//
//   flip productIcons   read {icons:on,  enrich:off} ─┐
//   flip enrichFrom...  read {icons:on,  enrich:off} ─┤ both read the same doc
//   flip productIcons   write{icons:OFF, enrich:off} ─┤
//   flip enrichFrom...  write{icons:on,  enrich:ON } ─┘ icons is back ON
//
// The member flipped two switches and watched the first one flip itself back.
// The design atlas has a law about exactly this shape of event — a control that
// undoes itself has to SAY why — and the honest reading is that here there is
// nothing to say, because nothing refused it. It was simply lost. So it must
// not happen rather than be reported.
//
// The two switches sit one above the other in the same card, which is what
// makes this a realistic sequence rather than a theoretical one.
//
// WHY AN IN-PROCESS LOCK IS ENOUGH. The engine's two processes have different
// jobs: the server answers requests, the worker runs the pipeline. THE WORKER
// NEVER WRITES A SETTINGS DOCUMENT — it only reads the retailer preference, and
// only through the copy already frozen onto a receipt record at accept time
// (see src/ingest/acceptService.js). So the server is the only writer, and
// serializing within it serializes everything.
//
// That is a claim about the code rather than a property of the storage, so it
// is asserted in test/settingsStores.test.js and stated here. If a second
// writer ever appears — a CLI, a second API process behind a load balancer —
// this becomes insufficient and the lock has to move to the store: SQLite can
// do it with a transaction, the filesystem backend with an O_EXCL lock file.
// Redis is not the answer; a lock that evaporates on eviction is not a lock.

// key -> the tail of the chain of work queued against it. Entries are removed
// when their chain drains, so this map does not grow with traffic.
const chains = new Map();

/**
 * Run `fn` with nothing else running against the same `key`.
 *
 * Serialization is per key, so one member's save never waits on another's, and
 * a slow write blocks only the document it is writing.
 *
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>} whatever fn resolves to (and it rejects if fn does)
 * @template T
 */
function withLock(key, fn) {
  const previous = chains.get(key) || Promise.resolve();

  // The chain is built on a SETTLED predecessor (`.then(noop, noop)`), so one
  // caller's rejection does not cancel everybody queued behind it. Each caller
  // still sees its own outcome — that is what `result` carries.
  const run = previous.then(() => fn(), () => fn());

  // The tail must never be a rejected promise: an unhandled rejection stored in
  // this map would be reported globally even though `run` is handled below.
  const tail = run.then(noop, noop);
  chains.set(key, tail);

  // Drop the entry once this is the last thing queued, so the map stays the
  // size of the CONCURRENT write set rather than of every key ever written.
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });

  return run;
}

function noop() {}

/** Test-only: how many keys currently have work queued. */
function _pending() {
  return chains.size;
}

module.exports = { withLock, _pending };
