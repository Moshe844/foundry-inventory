'use strict';

/**
 * Schema validation for anything that crosses the AI boundary.
 *
 * Model output is untrusted input. It is validated here before any other module
 * is allowed to read it, and validation failures are ordinary, expected events
 * rather than crashes.
 */

const Ajv = require('ajv');
const { ValidationError } = require('../domain/errors');

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  removeAdditional: false, // reject unexpected keys rather than silently dropping them
});

const cache = new Map();

function compile(schema, key) {
  if (key && cache.has(key)) return cache.get(key);
  const validate = ajv.compile(schema);
  if (key) cache.set(key, validate);
  return validate;
}

/**
 * @returns {{ok: true, data: object} | {ok: false, errors: string[]}}
 */
function validate(schema, data, { key } = {}) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['Expected a JSON object.'] };
  }
  const validator = compile(schema, key);
  if (validator(data)) return { ok: true, data };
  return { ok: false, errors: describe(validator.errors) };
}

/** Throws instead of returning a result, for callers that cannot continue. */
function validateOrThrow(schema, data, { key, label = 'data' } = {}) {
  const result = validate(schema, data, { key });
  if (!result.ok) {
    throw new ValidationError(`Foundry produced ${label} that did not match its own contract.`, {
      errors: result.errors.slice(0, 12),
    });
  }
  return result.data;
}

function describe(errors) {
  if (!errors) return ['Unknown validation failure.'];
  return errors.slice(0, 25).map((err) => {
    const where = err.instancePath || '(root)';
    if (err.keyword === 'additionalProperties') {
      return `${where}: unexpected property "${err.params.additionalProperty}"`;
    }
    if (err.keyword === 'enum') {
      return `${where}: must be one of ${JSON.stringify(err.params.allowedValues)}`;
    }
    if (err.keyword === 'required') {
      return `${where}: missing required property "${err.params.missingProperty}"`;
    }
    return `${where}: ${err.message}`;
  });
}

module.exports = { validate, validateOrThrow, describe };
