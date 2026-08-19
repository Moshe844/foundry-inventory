'use strict';

/**
 * Counting things in the customer's own words.
 *
 * The unit label belongs to them — "each", "case", "kg", "box" — so it is
 * pluralised the way English does rather than by bolting an "s" onto whatever
 * they typed. Three cases matter:
 *
 *   a measure abbreviation is already plural   64 kg, never 64 kgs
 *   some unit words simply do not inflect      90 each, never 90 eachs
 *   a sibilant takes "es"                      2 boxes, never 2 boxs
 *
 * Getting this wrong is not merely untidy. "90 eachs" on a purchase order is
 * the sort of thing that makes a customer wonder what else was generated rather
 * than understood.
 */

/** Unit words that read the same however many there are. */
const INVARIANT = new Set(['each', 'ea', 'pcs', 'pc', 'per', 'dozen', 'gross', 'stock']);

function unitCount(quantity, label) {
  return `${quantity} ${unitLabel(quantity, label)}`;
}

function unitLabel(quantity, label) {
  const word = String(label || 'unit').trim() || 'unit';
  if (Number(quantity) === 1) return word;
  if (INVARIANT.has(word.toLowerCase())) return word;
  // Abbreviations and anything with punctuation or digits are left exactly as
  // the customer wrote them.
  if (word.length <= 2 || !/^[a-z]+$/i.test(word)) return word;
  return /(s|x|z|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
}

module.exports = { unitCount, unitLabel, INVARIANT };
