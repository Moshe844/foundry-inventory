'use strict';

/**
 * How dangerous an action is, decided by arithmetic rather than by judgement.
 *
 * A model must never be the thing that decides whether a mutation needs a
 * warning — that would make the safety of the system a property of a sentence.
 * Everything below is computed from the proposal's own numbers against current
 * inventory truth, so the same request always gets the same classification.
 */

const SAFETY = {
  LOW: 'LOW',            // configuration that changes no stock
  MUTATION: 'MUTATION',  // moves real inventory
  HIGH: 'HIGH',          // corrections, and unusually large mutations
};

const APPROVAL = {
  NONE: 'NONE',
  CONFIRM: 'CONFIRM',
  CONFIRM_WITH_WARNING: 'CONFIRM_WITH_WARNING',
};

const THRESHOLDS = {
  // A mutation touching this much of what is on hand is worth spelling out.
  largeShareOfStock: 0.5,
  // …and this much is worth an explicit extra warning.
  severeShareOfStock: 0.9,
  // A single movement larger than this is unusual regardless of proportion.
  largeAbsoluteQuantity: 1000,
  // A correction moving more than this many units always warns.
  largeAdjustmentDelta: 25,
  // A correction of more than this share of the counted balance always warns.
  largeAdjustmentShare: 0.25,
};

/** How long an unapproved proposal stays good for. */
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

const CONFIGURATION_ACTIONS = ['add_location', 'rename_terminology', 'create_item', 'archive_item'];
const MUTATION_ACTIONS = ['receive', 'issue', 'transfer', 'adjust'];

function share(part, whole) {
  if (!whole || whole <= 0) return null;
  return part / whole;
}

/**
 * Classifies a proposal.
 *
 * @param {object} input
 *   actionType, quantity, adjustmentDelta, availableAtSource, totalOnHand
 * @returns {{ safetyLevel, approvalRequirement, warnings }}
 */
function classify(input) {
  const warnings = [];
  const actionType = input.actionType;

  if (CONFIGURATION_ACTIONS.includes(actionType) && !(actionType === 'create_item' && Number(input.quantity) > 0)) {
    return {
      safetyLevel: SAFETY.LOW,
      approvalRequirement: APPROVAL.CONFIRM,
      warnings,
    };
  }

  let level = SAFETY.MUTATION;

  // Corrections are always the sensitive case: they change what the records
  // say without anything having physically moved.
  if (actionType === 'adjust') {
    level = SAFETY.HIGH;
    const delta = Math.abs(Number(input.adjustmentDelta) || 0);
    const expected = Number(input.availableAtSource) || 0;
    const proportion = share(delta, expected);
    if (delta >= THRESHOLDS.largeAdjustmentDelta) {
      warnings.push(
        `This changes the recorded count by ${delta} ${delta === 1 ? 'unit' : 'units'}.`
      );
    }
    if (proportion !== null && proportion >= THRESHOLDS.largeAdjustmentShare) {
      warnings.push(
        `That is ${formatPercent(proportion)} of what the records currently show here.`
      );
    }
    warnings.push('A correction changes the records without stock moving. It cannot be undone, only corrected again.');
  }

  // How much of the available stock an outbound movement consumes.
  const quantity = Math.abs(Number(input.quantity) || 0);
  if (['issue', 'transfer'].includes(actionType) && quantity > 0) {
    const available = Number(input.availableAtSource) || 0;
    const proportion = share(quantity, available);
    if (proportion !== null && proportion >= THRESHOLDS.severeShareOfStock) {
      level = SAFETY.HIGH;
      warnings.push(
        `This would ${actionType === 'issue' ? 'remove' : 'move'} ${formatPercent(proportion)} of the stock available here.`
      );
    } else if (proportion !== null && proportion >= THRESHOLDS.largeShareOfStock) {
      warnings.push(
        `This is ${formatPercent(proportion)} of the stock available here.`
      );
    }
  }

  if (quantity >= THRESHOLDS.largeAbsoluteQuantity) {
    level = SAFETY.HIGH;
    warnings.push(`${quantity} units is an unusually large single movement.`);
  }

  return {
    safetyLevel: level,
    approvalRequirement:
      level === SAFETY.HIGH || warnings.length > 0 ? APPROVAL.CONFIRM_WITH_WARNING : APPROVAL.CONFIRM,
    warnings,
  };
}

function formatPercent(proportion) {
  const value = proportion * 100;
  const rounded = value >= 99.95 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}%`;
}

/**
 * Whether a re-validated proposal differs enough from what was approved that a
 * person has to look again. Any change to what actually moves does.
 */
function materiallyChanged(approved, current) {
  const fields = ['quantity', 'adjustmentTarget', 'skuId', 'lotId', 'sourceLocationId', 'destinationLocationId'];
  for (const field of fields) {
    if ((approved[field] ?? null) !== (current[field] ?? null)) return { changed: true, field };
  }
  // The starting position changing means the result changes, even when the
  // instruction did not: 15 out of 48 is not the same act as 15 out of 16.
  const before = approved.expectedBeforeState || {};
  const now = current.expectedBeforeState || {};
  for (const key of Object.keys(before)) {
    if (typeof before[key] === 'number' && before[key] !== now[key]) {
      return { changed: true, field: `before.${key}` };
    }
  }
  return { changed: false, field: null };
}

module.exports = {
  SAFETY,
  APPROVAL,
  THRESHOLDS,
  PROPOSAL_TTL_MS,
  CONFIGURATION_ACTIONS,
  MUTATION_ACTIONS,
  classify,
  materiallyChanged,
  formatPercent,
};
