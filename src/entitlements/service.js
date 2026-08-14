'use strict';

/**
 * The entitlement boundary.
 *
 * Every place that could exceed a plan asks *here* rather than counting for
 * itself, and it asks by name. Billing does not exist yet; when it does, it
 * changes where a plan comes from and what its numbers are, and every call site
 * below keeps working untouched.
 *
 * Counting is deliberately live rather than cached. A stale counter that lets
 * someone past a limit is a billing bug; a query is cheap by comparison.
 */

const { DomainError } = require('../domain/errors');
const { getPlan, limitFor, hasFeature, DEFAULT_PLAN } = require('./plans');

class LimitExceededError extends DomainError {
  constructor(message, details) {
    super(message, { code: 'limit_exceeded', status: 402 });
    this.details = details || null;
  }
}

class FeatureUnavailableError extends DomainError {
  constructor(message, details) {
    super(message, { code: 'feature_unavailable', status: 402 });
    this.details = details || null;
  }
}

/** How much of each limit is currently used. One query per limit, no caching. */
const USAGE = {
  workspaces: (db, { accountId }) =>
    db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE owner_account_id = ?').get(accountId).n,

  members: (db, { workspaceId }) =>
    db.prepare('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?').get(workspaceId).n,

  locations: (db, { workspaceId }) =>
    db.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND is_active = 1').get(workspaceId).n,

  skus: (db, { workspaceId }) =>
    db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ? AND is_active = 1').get(workspaceId).n,

  // Usage metering has no store yet; billing will supply one. Reporting zero is
  // honest — the limit is declared and checked, it simply never binds today.
  aiRequestsPerDay: () => 0,
};

function planIdFor(db, accountId) {
  if (!accountId) return DEFAULT_PLAN;
  const row = db.prepare('SELECT plan FROM accounts WHERE id = ?').get(accountId);
  return (row && row.plan) || DEFAULT_PLAN;
}

/**
 * @param {object} scope { accountId, workspaceId }
 * @returns {{ key, limit, used, remaining, unlimited, exceeded }}
 */
function usage(db, scope, key) {
  const planId = planIdFor(db, scope.accountId);
  const limit = limitFor(planId, key);
  const counter = USAGE[key];
  const used = counter ? counter(db, scope) : 0;
  return {
    key,
    planId,
    limit,
    used,
    unlimited: limit === null || limit === undefined,
    remaining: limit === null || limit === undefined ? null : Math.max(0, limit - used),
    exceeded: limit !== null && limit !== undefined && used >= limit,
  };
}

/** Throws if adding one more of `key` would pass the plan's limit. */
function assertWithin(db, scope, key, { adding = 1 } = {}) {
  const state = usage(db, scope, key);
  if (state.unlimited) return state;
  if (state.used + adding <= state.limit) return state;

  const plan = getPlan(state.planId);
  const label = { workspaces: 'inventories', members: 'people', locations: 'locations', skus: 'items' }[key] || key;
  throw new LimitExceededError(
    `The ${plan.label} plan includes ${state.limit} ${label}. You have ${state.used}.`,
    { key, limit: state.limit, used: state.used, plan: state.planId }
  );
}

function assertFeature(db, scope, feature) {
  const planId = planIdFor(db, scope.accountId);
  if (hasFeature(planId, feature)) return true;
  throw new FeatureUnavailableError('That is not part of your current plan.', { feature, plan: planId });
}

/** Everything at once, for a settings page that wants to show where you stand. */
function summarise(db, scope) {
  const keys = ['workspaces', 'members', 'locations', 'skus'];
  return {
    plan: getPlan(planIdFor(db, scope.accountId)),
    limits: keys.map((key) => usage(db, scope, key)),
  };
}

module.exports = {
  LimitExceededError,
  FeatureUnavailableError,
  usage,
  assertWithin,
  assertFeature,
  summarise,
  planIdFor,
};
