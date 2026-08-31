'use strict';

const { createId } = require('@paralleldrive/cuid2');
const { ValidationError } = require('../domain/errors');

const newId = (prefix) => (prefix ? `${prefix}_${createId()}` : createId());

const nowIso = () => new Date().toISOString();

function trimOrNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function requireText(value, field, { max = 200 } = {}) {
  const trimmed = trimOrNull(value);
  if (!trimmed) throw new ValidationError(`${field} is required.`, { field });
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be ${max} characters or fewer.`, { field });
  }
  return trimmed;
}

/** Positive whole number of units. Inventory is never fractional in Mission 1. */
function requirePositiveInt(value, field) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError(`${field} must be a whole number greater than zero.`, { field });
  }
  if (num > 1_000_000_000) {
    throw new ValidationError(`${field} is unrealistically large.`, { field });
  }
  return num;
}

function requireNonNegativeInt(value, field) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new ValidationError(`${field} must be zero or a positive whole number.`, { field });
  }
  return num;
}

function requireOneOf(value, allowed, field) {
  const trimmed = trimOrNull(value);
  if (!trimmed || !allowed.includes(trimmed)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}.`, { field });
  }
  return trimmed;
}

/** Accepts `YYYY-MM-DD` (from date inputs) or a full ISO timestamp. */
function optionalDate(value, field) {
  const trimmed = trimOrNull(value);
  if (!trimmed) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${field} is not a valid date.`, { field });
  }
  return date.toISOString();
}

/** Normalises a form value that may arrive as a scalar or as a repeated field. */
function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeLike(term) {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Plural of a unit word the customer typed.
 *
 * Purchase units are free text — box, case, pallet, batch, bunch — and the
 * display helpers appended "s" to whatever arrived, so a shop buying by the box
 * was asked to confirm an order for "3 boxs". Sibilant endings take "es", and a
 * consonant before a final "y" takes "ies".
 */
function pluralUnit(word) {
  // Strips a trailing "(s)" that some labels carry — not a trailing "s", which
  // would turn "glass" into "glas" and then back into "glases".
  const clean = String(word || 'unit').replace(/\(s\)$/i, '').trim() || 'unit';

  // Already plural, and left alone. Somebody who typed "boxes" as their unit
  // should not be shown "boxeses"; "glass" and "batch" are singular despite
  // ending in a sibilant, so they are excluded from this test rather than
  // caught by it.
  if (/(ses|xes|zes|ches|shes|ies)$/i.test(clean)) return clean;
  if (/[^s]s$/i.test(clean)) return clean;

  if (/(s|x|z|ch|sh)$/i.test(clean)) return `${clean}es`;
  if (/[^aeiou]y$/i.test(clean)) return `${clean.slice(0, -1)}ies`;
  return `${clean}s`;
}

module.exports = {
  pluralUnit,
  newId,
  nowIso,
  trimOrNull,
  requireText,
  requirePositiveInt,
  requireNonNegativeInt,
  requireOneOf,
  optionalDate,
  toArray,
  escapeLike,
};
