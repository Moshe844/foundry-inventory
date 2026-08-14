'use strict';

/**
 * What a plan allows.
 *
 * Limits live here as data, never as numbers written into the code that
 * enforces them — so when billing arrives it changes this table (or replaces it
 * with rows from a billing provider) and nothing else moves.
 *
 * `null` means unlimited. Absent means the limit is not one Foundry checks yet;
 * adding it here is enough to make it enforced everywhere it is asserted.
 */

const LIMITS = [
  { key: 'workspaces', label: 'inventories', scope: 'account' },
  { key: 'members', label: 'people', scope: 'workspace' },
  { key: 'locations', label: 'locations', scope: 'workspace' },
  { key: 'skus', label: 'items', scope: 'workspace' },
  { key: 'aiRequestsPerDay', label: 'Foundry requests a day', scope: 'account' },
];

const FEATURES = ['foundry_setup', 'foundry_assistant', 'attention_briefing', 'ask_foundry'];

/**
 * The plans themselves. Only `free` exists today; the shape is what matters,
 * because it is what a paid tier will be expressed in.
 */
const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    limits: {
      workspaces: 3,
      members: 5,
      locations: 10,
      skus: 500,
      aiRequestsPerDay: 50,
    },
    features: ['foundry_setup', 'foundry_assistant', 'attention_briefing', 'ask_foundry'],
  },
  // Deliberately present and deliberately not sold: it proves the boundary is a
  // lookup rather than a constant, and gives billing somewhere to write.
  unlimited: {
    id: 'unlimited',
    label: 'Unlimited',
    limits: {
      workspaces: null,
      members: null,
      locations: null,
      skus: null,
      aiRequestsPerDay: null,
    },
    features: [...FEATURES],
  },
};

const DEFAULT_PLAN = 'free';

function getPlan(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN];
}

function limitFor(planId, key) {
  const plan = getPlan(planId);
  return Object.prototype.hasOwnProperty.call(plan.limits, key) ? plan.limits[key] : null;
}

function hasFeature(planId, feature) {
  return getPlan(planId).features.includes(feature);
}

module.exports = { PLANS, LIMITS, FEATURES, DEFAULT_PLAN, getPlan, limitFor, hasFeature };
