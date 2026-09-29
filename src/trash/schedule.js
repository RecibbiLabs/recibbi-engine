'use strict';

// How long a receipt waits in the trash, and when the trash is emptied -- the
// two settings, read and checked. Pure: no config, no clock, no I/O, so
// src/config.js can require it and throw at boot on a value it cannot read.
//
//   TRASH_RETENTION    how long a deleted receipt stays recoverable. `30d` by
//                      default. A number and a unit -- `30d`, `12h`, `5s`,
//                      `2 weeks`, `1 sec` -- or a bare number, which is DAYS,
//                      because days are what the setting is about and what the
//                      trash page counts down in.
//   TRASH_EMPTY_CRON   when the sweep runs, in cron notation. Five fields
//                      (minute hour day month weekday), or six with seconds
//                      first. `0 3 * * *` by default: once a night. `off`
//                      turns the sweep off, and then nothing is ever purged
//                      except by a member pressing "Delete it now".
//
// WHY TWO SETTINGS AND NOT ONE. The retention is the promise to the member --
// "thirty days" is printed on their trash page. The schedule is housekeeping:
// how late after its thirty days a receipt actually goes. A receipt is purged
// on the first sweep AFTER its time is up, never before, so a slow schedule
// can only make the promise more generous, never break it.
//
// The retention is NOT stored on the receipt. A receipt's purge time is
// derived from `deletedAt` and the retention in force when it is read, so
// changing the setting moves every receipt already in the trash -- which is
// what an operator changing it means, and it keeps the two from disagreeing.

const cronParser = require('cron-parser');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const UNITS = [
  [['ms', 'msec', 'msecs', 'millisecond', 'milliseconds'], 1],
  [['s', 'sec', 'secs', 'second', 'seconds'], SECOND],
  [['m', 'min', 'mins', 'minute', 'minutes'], MINUTE],
  [['h', 'hr', 'hrs', 'hour', 'hours'], HOUR],
  [['d', 'day', 'days'], DAY],
  [['w', 'wk', 'wks', 'week', 'weeks'], WEEK],
];
const UNIT = new Map(UNITS.flatMap(([names, ms]) => names.map((n) => [n, ms])));

const DEFAULT_RETENTION = '30d';
const DEFAULT_CRON = '0 3 * * *';

class TrashSettingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrashSettingError';
  }
}

/**
 * `30d`, `5 seconds`, `1 sec`, `30` (days) -> milliseconds.
 *
 * Unset or empty is the default. Anything else that does not read is an ERROR,
 * not the default: an operator who typed `5 secnds` to test the sweep and got
 * thirty days would conclude the sweep does not work.
 */
function parseRetention(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!text) return parseRetention(DEFAULT_RETENTION);
  const m = text.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
  const unit = m && (m[2] ? UNIT.get(m[2]) : DAY);
  const ms = m && unit ? Math.round(Number(m[1]) * unit) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new TrashSettingError(
      `TRASH_RETENTION="${text}" is not a length of time. Write a number and a unit -- ` +
        '30d, 12h, 5s, "2 weeks" -- or a bare number of days. Unset, it is 30 days.'
    );
  }
  return ms;
}

/** A retention in words, in the largest unit it divides into: `30 days`, `5 seconds`. */
function describe(ms) {
  // Never weeks: 14 days reads as "14 days" on a page that counts down in days.
  const pick = [
    [DAY, 'day'],
    [HOUR, 'hour'],
    [MINUTE, 'minute'],
    [SECOND, 'second'],
  ];
  for (const [size, word] of pick) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return `${n} ${word}${n === 1 ? '' : 's'}`;
    }
  }
  return `${ms} ms`;
}

/**
 * The sweep's cron expression, checked -- or null for `off`.
 *
 * Checked by the same parser BullMQ schedules with (cron-parser, which it
 * depends on and which is pinned here to its version), so an expression that
 * passes this will be scheduled exactly as written.
 */
function parseCron(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!text) return DEFAULT_CRON;
  if (/^(off|never|none|0|false|no)$/i.test(text)) return null;
  const fields = text.split(/\s+/).length;
  if (fields < 5 || fields > 6) {
    throw new TrashSettingError(
      `TRASH_EMPTY_CRON="${text}" has ${fields} field(s). Cron takes five -- minute hour day month ` +
        'weekday, e.g. "0 3 * * *" -- or six with seconds first, e.g. "* * * * * *" for every second.'
    );
  }
  try {
    cronParser.parseExpression(text);
  } catch (err) {
    throw new TrashSettingError(`TRASH_EMPTY_CRON="${text}" is not a cron expression: ${err.message}`);
  }
  return text;
}

/** When a cron expression next fires after `from`, or null when it is off. */
function nextRun(cron, from = new Date()) {
  if (!cron) return null;
  try {
    return cronParser.parseExpression(cron, { currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

module.exports = {
  SECOND,
  MINUTE,
  HOUR,
  DAY,
  DEFAULT_RETENTION,
  DEFAULT_CRON,
  TrashSettingError,
  parseRetention,
  describe,
  parseCron,
  nextRun,
};
