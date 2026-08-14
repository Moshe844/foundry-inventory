'use strict';

/**
 * Customer-facing vocabulary.
 *
 * This is presentation only. Nothing in `src/domain` reads it, no table or
 * column is renamed, and there is still exactly one inventory engine — a
 * customer who calls locations "Warehouses" is looking at the same rows as
 * everyone else.
 */

const { DEFAULT_TERMS } = require('./plan-builder');

const PLURALS = {
  Item: 'Items',
  Location: 'Locations',
  Unit: 'Units',
  Lot: 'Lots',
  Variant: 'Variants',
};

function createVocabulary(terminology = {}) {
  const terms = {};
  for (const [key, fallback] of Object.entries(DEFAULT_TERMS)) {
    const custom = terminology && typeof terminology[key] === 'string' ? terminology[key].trim() : '';
    terms[key] = custom || fallback;
  }

  const term = (key, { plural = false, lower = false } = {}) => {
    const singular = terms[key] || DEFAULT_TERMS[key] || key;
    const value = plural ? pluralise(singular) : singular;
    return lower ? value.toLowerCase() : value;
  };

  return {
    terms,
    term,
    isCustomised: Object.entries(terms).some(([key, value]) => value !== DEFAULT_TERMS[key]),
    customised: Object.entries(terms)
      .filter(([key, value]) => value !== DEFAULT_TERMS[key])
      .map(([key, value]) => ({ key, from: DEFAULT_TERMS[key], to: value })),
  };
}

function pluralise(word) {
  if (PLURALS[word]) return PLURALS[word];
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

module.exports = { createVocabulary, pluralise, DEFAULT_TERMS };
