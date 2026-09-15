'use strict';

// Field rules for the two settings records. Shared by the store and the route
// so there is ONE definition of what is acceptable, and it is the engine's.
//
// The design atlas draws the same limits on the page (recibbi-ux-design-atlas
// assets/js/pages/settings.js, LIMITS). That check is a COURTESY — it fails a
// pasted document before a round trip. This one is the rule. A client-side
// limit is a hint to a member; it is not a constraint on a caller.
//
// WHAT IS DELIBERATELY NOT HERE
//
// There is no "that does not look like a name" rule, and there will not be one.
// Names do not have a shape: they carry spaces, apostrophes, hyphens, accents,
// non-Latin scripts, one character, or eight words. Every regex anybody has
// ever written for this rejects somebody's actual legal name, and the failure
// is silent to whoever wrote the regex and infuriating to whoever has the name.
// Length is the only honest bound, and it exists to stop a paste, not a person.
//
// Likewise there is no postal-code format, no state enum and no country list:
// the address is optional FIELD BY FIELD (see memberProfile.js), so a member
// who types a postcode and nothing else has given us a complete answer, and a
// validator that demands a country before it will believe a postcode turns a
// useful answer into no answer.

// Longest accepted value per field, in characters (not bytes — a member whose
// name is in a script with multi-byte code points has the same 60 as anybody).
const LIMITS = {
  firstName: 60,
  lastName: 60,
  line1: 120,
  line2: 120,
  city: 80,
  state: 60,
  postalCode: 16,
  country: 60,
};

const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'];
const NAME_FIELDS = ['firstName', 'lastName'];

class SettingsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SettingsError';
    this.status = status;
  }
}

/**
 * One submitted value -> the string to store, or null.
 *
 * BLANK IS NULL, and that is the whole reason this function exists rather than
 * the values going in as they arrive. A form posts every box it draws, so an
 * address the member emptied arrives as six empty strings. Stored as `''` they
 * are indistinguishable from six fields nobody filled in when read back, but
 * they are NOT indistinguishable to `hasAddress()` on the page, which would
 * then draw an address block containing nothing. One representation for absent.
 */
function clean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
  if (typeof value !== 'string') {
    throw new SettingsError(400, 'profile fields must be text');
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reject a value that is too long, naming the field and both numbers.
 *
 * The member is told what the limit is and what they sent, because "too long"
 * on its own leaves somebody trimming a character at a time.
 */
function checkLength(field, value) {
  const max = LIMITS[field];
  if (!max || value === null) return value;
  // [...value] counts code points, so an emoji or an astral character is one,
  // matching what the member sees in the box rather than what UTF-16 thinks.
  const length = [...value].length;
  if (length > max) {
    throw new SettingsError(400, `${field} is longer than ${max} characters (got ${length})`);
  }
  return value;
}

/** Clean and bound one field. */
function field(values, name) {
  return checkLength(name, clean(values ? values[name] : null));
}

module.exports = {
  LIMITS,
  ADDRESS_FIELDS,
  NAME_FIELDS,
  SettingsError,
  clean,
  checkLength,
  field,
};
