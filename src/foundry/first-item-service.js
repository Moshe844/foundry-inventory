'use strict';

/**
 * The last step of setting up: turning a described business into a real record.
 *
 * Configuring a workspace and then handing back an empty inventory is a strange
 * place to stop. Somebody who said "I wholesale baby headbands, sizes 0-6, 6-12
 * and 12-24 months, colours white, red, blue, purple and green" has named the
 * product and every one of its fifteen combinations. Making them type it again
 * is not caution — it is the setup failing to finish its own sentence.
 *
 * The line this does not cross is quantity. Foundry will create the *shape* of
 * what a customer described, because they described it. It will never write a
 * balance: how many are on the shelf is a physical fact nobody has told it, and
 * a system that guesses at those is worse than one that asks.
 *
 * So: a suggestion, from their own words, that they approve or edit or ignore.
 * Nothing here writes anything until `create` is called from a form they
 * submitted, and the item it creates has zero stock in it.
 */

const itemService = require('../domain/item-service');
const understandingService = require('./understanding-service');
const planApplier = require('./plan-applier');
const repo = require('../domain/repository');
const { ValidationError } = require('../domain/errors');

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Roughly "a product name", not a sentence. */
const MAX_NAME = 80;

/**
 * Trims a described product to something usable as a name.
 *
 * What comes back is rarely the bare product. Asked about baby headbands in
 * three sizes and five colours, the model answers with worked examples —
 * "Baby headband - White, 0-6 months" — because that is a better illustration
 * of the inventory than the noun on its own.
 *
 * So the option values are subtracted using the axes actually configured for
 * this workspace, which leaves the product. Guessing at the punctuation instead
 * would produce an item called "Baby headband - White, 0-6 month", and a
 * customer would rightly conclude Foundry had not understood a word.
 */
function tidyName(raw, optionValues = []) {
  let text = String(raw || '').replace(/\([^)]*\)/g, ' ');

  // Longest first, so "12-24 months" is removed before "12-24" could be.
  for (const value of [...optionValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escapeRegExp(value), 'gi'), ' ');
  }

  text = text
    // Whatever separators the values were strung together with.
    .replace(/[\s]*[-–—,/|]+[\s]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  // "Baby headbands" reads better as the singular on a product record, but only
  // for the obvious plural: "boxes" and "batches" are left alone rather than
  // mangled by a rule that cannot tell them apart.
  const singular = /[a-z]{3,}s$/i.test(text) && !/(ss|us|is|ches|shes|xes|zes)$/i.test(text)
    ? text.slice(0, -1)
    : text;

  return singular.slice(0, MAX_NAME).replace(/^./, (c) => c.toUpperCase());
}

/** A code like KT-100 from "Kids Tights", or null if nothing sensible falls out. */
function suggestCode(name) {
  const initials = String(name || '')
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
    .map((word) => word[0].toUpperCase())
    .join('');
  return initials.length >= 2 ? `${initials.slice(0, 4)}-100` : null;
}

/**
 * What Foundry would create, from what this workspace already told it.
 *
 * Returns null whenever there is nothing worth offering — no configuration, no
 * described product, or an inventory that already has items in it. An offer to
 * "create your first item" on a workspace with forty of them is noise.
 */
function suggest(db, workspaceId) {
  const configuration = planApplier.getConfiguration(db, workspaceId);
  if (!configuration || !configuration.configuredAt) return null;

  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?')
    .get(workspaceId).n;
  if (existing > 0) return null;

  const record = understandingService.latestUnderstanding(db, workspaceId);
  const understanding = record && record.understanding;
  if (!understanding) return null;

  const model = configuration.inventoryModel || {};
  const dimensions = Array.isArray(model.variantDimensions) ? model.variantDimensions : [];
  const usesVariants = Boolean(model.usesVariants) && dimensions.length > 0;

  // Every value across every axis, plus the axis names themselves — all of it
  // is describing the variant rather than the product.
  const vocabulary = dimensions.flatMap((dimension) => [
    ...(dimension.exampleValues || []),
    dimension.name,
  ]);

  // The shortest example is the least dressed-up, so it needs the least undoing.
  const examples = [...(understanding.inventoryExamples || [])].filter(Boolean);
  const shortest = examples.sort((a, b) => a.length - b.length)[0];
  const name = tidyName(shortest, vocabulary);
  if (!name) return null;

  const options = usesVariants
    ? dimensions
        .slice(0, 3)
        .map((dimension) => ({
          name: dimension.name || '',
          values: (dimension.exampleValues || []).filter(Boolean),
        }))
        .filter((option) => option.name && option.values.length)
    : [];

  // Variants were configured but no values were ever named: there is nothing to
  // generate, and inventing option values would be exactly the fabrication this
  // module is careful about everywhere else.
  if (usesVariants && !options.length) return null;

  const combinations = options.reduce((total, option) => total * option.values.length, 1);

  return {
    name,
    baseCode: suggestCode(name),
    trackingMode: model.primaryArchetype || 'quantity',
    hasVariants: options.length > 0,
    options,
    combinations: options.length ? combinations : 1,
    describedAs: shortest || null,
  };
}

/**
 * Creates it. Called only from a form the customer submitted, and deliberately
 * a thin wrapper: the catalogue rules live in the item service, and this is not
 * the place to grow a second set of them.
 */
function create(db, ctx, input) {
  const name = String(input.name || '').trim();
  if (!name) throw new ValidationError('Give the item a name.');

  const options = (Array.isArray(input.options) ? input.options : [])
    .map((option) => ({
      name: String(option.name || '').trim(),
      values: Array.isArray(option.values) ? option.values.join(', ') : String(option.values || ''),
    }))
    .filter((option) => option.name && option.values);

  const created = itemService.createItem(db, ctx, {
    name,
    baseCode: input.baseCode || null,
    trackingMode: input.trackingMode || 'quantity',
    hasVariants: options.length > 0,
    options,
  });

  // Said plainly for the caller's flash message: the record exists, the shelf
  // is still empty, and receiving is the customer's next move.
  return {
    ...created,
    // createItem returns ids, not the name it was given. Spreading it over the
    // name would leave the caller announcing "Created undefined".
    name,
    skuCount: repo.listSkusForItem(db, ctx.workspaceId, created.itemId).length,
    stockCreated: 0,
  };
}

module.exports = { suggest, create, tidyName, suggestCode };
