'use strict';

/**
 * Constrained decoding compiles a JSON Schema into a grammar, and that grammar
 * cannot express size or pattern constraints. Those keywords are therefore
 * stripped from the schema sent over the wire.
 *
 * The same stripped schema is used to validate the reply, so the model is
 * judged against the contract it was actually given — being rejected for a rule
 * it was never shown is a bug in the caller, not a bad answer. Foundry then
 * repairs what is safely repairable and enforces the full, stricter contract.
 */

const GRAMMAR_UNSUPPORTED = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'pattern',
  'uniqueItems',
]);

function toWireSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toWireSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GRAMMAR_UNSUPPORTED.has(key)) continue;
    out[key] = value && typeof value === 'object' ? toWireSchema(value) : value;
  }
  return out;
}

/**
 * Brings a response back inside the size limits the model was never shown.
 *
 * Length and item caps exist to protect storage and layout, and a summary that
 * runs fifty characters long is not a wrong answer — so it is trimmed rather
 * than thrown away. This handles the whole class of "exceeded a stripped
 * constraint" at once, instead of one field at a time as each surfaces.
 * Meaning-bearing rules — enums, types, required, additionalProperties — are
 * never touched here; those still have to be right.
 */
function clampToSchema(value, schema) {
  if (!schema || typeof schema !== 'object') return value;

  if (typeof value === 'string' && Number.isInteger(schema.maxLength)) {
    return value.length > schema.maxLength ? value.slice(0, schema.maxLength) : value;
  }

  if (Array.isArray(value)) {
    const capped = Number.isInteger(schema.maxItems) ? value.slice(0, schema.maxItems) : value;
    return schema.items ? capped.map((entry) => clampToSchema(entry, schema.items)) : capped;
  }

  if (value && typeof value === 'object' && schema.properties) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = schema.properties[key] ? clampToSchema(entry, schema.properties[key]) : entry;
    }
    return out;
  }

  return value;
}

/** Identifiers are internal plumbing; normalise rather than reject on shape. */
function slugify(value, fallback = 'option') {
  const slug = String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'x$1')
    .slice(0, 48);
  return slug || fallback;
}

module.exports = { toWireSchema, clampToSchema, slugify, GRAMMAR_UNSUPPORTED };
