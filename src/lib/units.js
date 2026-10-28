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
const ALREADY_PLURAL = /(?:ies|ses|xes|zes|ches|shes|units|pieces|pairs|packs|rolls|pallets|cartons|bottles)$/i;

function unitCount(quantity, label) {
  return `${quantity} ${unitLabel(quantity, label)}`;
}

function unitLabel(quantity, label) {
  const word = String(label || 'unit').trim() || 'unit';
  if (Number(quantity) === 1) {
    const singular={units:'unit',pieces:'piece',pairs:'pair',packs:'pack',rolls:'roll',pallets:'pallet',cartons:'carton',bottles:'bottle',shirts:'shirt',chairs:'chair',knives:'knife',boxes:'box',cases:'case'}[word.toLowerCase()];
    return singular ? (word[0]===word[0].toUpperCase()?singular[0].toUpperCase()+singular.slice(1):singular) : word;
  }
  if (INVARIANT.has(word.toLowerCase())) return word;
  if (ALREADY_PLURAL.test(word)) return word;
  // A supplied regular plural (shirts, bolts, spoons) is already a unit label.
  // Keep singular sibilants such as glass/class for the rule below.
  if(/[^su]s$/i.test(word))return word;
  // Abbreviations and anything with punctuation or digits are left exactly as
  // the customer wrote them.
  if (word.length <= 2 || !/^[a-z]+$/i.test(word)) return word;
  return /(s|x|z|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
}

module.exports = { unitCount, unitLabel, INVARIANT, ALREADY_PLURAL };
