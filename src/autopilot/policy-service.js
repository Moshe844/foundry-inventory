'use strict';

/**
 * What Foundry may do without asking, as data a person approved.
 *
 * A model may help someone *express* a policy — "handle ordinary transfers
 * yourself" becomes a structured proposal with real limits — but nothing a
 * model says at run time authorises anything. Authorisation is the evaluator in
 * policy-engine.js reading these rows, and it would behave identically if the
 * model were switched off.
 *
 * Policies are versioned and never edited in place. Broadening what an
 * automaton may do is exactly the change that must not happen quietly, so a
 * change supersedes the previous version and has to be approved again — and the
 * old version stays on record, because the audit question is always "what was
 * it allowed to do at the moment it acted".
 */

const crypto = require('crypto');
const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const repo = require('../domain/repository');

/**
 * The only actions a policy may ever authorise.
 *
 * Mission 7 proves controlled autonomy with one narrow mutation category:
 * moving stock between the business's own locations. Nothing leaves the
 * business, the total is unchanged, and a wrong one is undone by moving it
 * back. Adjustments are deliberately absent — a count discrepancy is a claim
 * that the records are wrong, and no automaton should settle that.
 */
const AUTOMATABLE_ACTIONS = ['transfer'];

/** Named conditions a policy can require. Each maps to a real measurement. */
const CONDITIONS = {
  DESTINATION_STOCKOUT_RISK: 'destination_stockout_risk',
  SOURCE_ABOVE_SAFETY: 'source_above_safety',
  NO_CONFLICTING_TRANSFER: 'no_conflicting_transfer',
  SUFFICIENT_HISTORY: 'sufficient_history',
};

const CONDITION_LABEL = {
  destination_stockout_risk: 'the destination is measurably at risk of running out',
  source_above_safety: 'the source keeps enough stock to cover its own demand',
  no_conflicting_transfer: 'no other transfer of the same product is already in flight',
  sufficient_history: 'there is enough movement history to trust the signal',
};

const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** A hash over what the policy permits, and nothing presentational. */
function integrityHash(policy) {
  return crypto
    .createHash('sha256')
    .update(
      stableStringify({
        allowedActionTypes: policy.allowedActionTypes,
        itemScope: policy.itemScope,
        locationScope: policy.locationScope,
        supplierScope: policy.supplierScope,
        exclusions: policy.exclusions,
        conditions: policy.conditions,
        thresholds: policy.thresholds,
        maximumQuantity: policy.maximumQuantity ?? null,
        maximumValue: policy.maximumValue ?? null,
        dailyLimit: policy.dailyLimit ?? null,
      })
    )
    .digest('hex');
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    allowedActionTypes: json(row.allowed_action_types, []),
    scope: json(row.scope, {}),
    itemScope: json(row.item_scope, []),
    locationScope: json(row.location_scope, []),
    supplierScope: json(row.supplier_scope, []),
    exclusions: json(row.exclusions, []),
    conditions: json(row.conditions, []),
    thresholds: json(row.thresholds, {}),
    maximumQuantity: row.maximum_quantity,
    maximumValue: row.maximum_value,
    dailyLimit: row.daily_limit,
    approvalRules: json(row.approval_rules, {}),
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    version: row.version,
    supersedesPolicyId: row.supersedes_policy_id,
    integrityHash: row.integrity_hash,
    approvedAt: row.approved_at,
    approvedByUserId: row.approved_by_user_id,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isApproved: Boolean(row.approved_at),
    isActive: Boolean(row.enabled) && Boolean(row.approved_at) && !row.disabled_at,
  };
}

// ---------------------------------------------------------------------------
// Writing policies
// ---------------------------------------------------------------------------

function validate(db, workspaceId, input) {
  const name = trimOrNull(input.name);
  if (!name) throw new ValidationError('Give the policy a name you would recognise on a list.');

  const actions = (Array.isArray(input.allowedActionTypes) ? input.allowedActionTypes : [])
    .map((a) => String(a).trim().toLowerCase())
    .filter(Boolean);
  if (!actions.length) throw new ValidationError('A policy has to say which action it allows.');

  const unsupported = actions.filter((a) => !AUTOMATABLE_ACTIONS.includes(a));
  if (unsupported.length) {
    throw new ValidationError(
      `Foundry will not automate ${unsupported.join(', ')} yet. Today it can only be trusted with transfers between your own locations.`
    );
  }

  const maximumQuantity = input.maximumQuantity === undefined || input.maximumQuantity === null || input.maximumQuantity === ''
    ? null
    : Math.trunc(Number(input.maximumQuantity));
  if (maximumQuantity === null || !Number.isFinite(maximumQuantity) || maximumQuantity <= 0) {
    // Not optional. A policy with no ceiling is not a policy, it is permission.
    throw new ValidationError('Say the most Foundry may move in one go. A policy without a limit is not a limit.');
  }

  const locationScope = (Array.isArray(input.locationScope) ? input.locationScope : []).filter(Boolean);
  for (const locationId of locationScope) {
    repo.requireLocation(db, workspaceId, locationId, 'location');
  }
  const itemScope = (Array.isArray(input.itemScope) ? input.itemScope : []).filter(Boolean);

  const conditions = (Array.isArray(input.conditions) ? input.conditions : []).filter((c) =>
    Object.values(CONDITIONS).includes(c)
  );

  return {
    name,
    description: trimOrNull(input.description),
    allowedActionTypes: actions,
    scope: input.scope && typeof input.scope === 'object' ? input.scope : {},
    itemScope,
    locationScope,
    supplierScope: (Array.isArray(input.supplierScope) ? input.supplierScope : []).filter(Boolean),
    exclusions: (Array.isArray(input.exclusions) ? input.exclusions : []).filter(Boolean),
    conditions,
    thresholds: input.thresholds && typeof input.thresholds === 'object' ? input.thresholds : {},
    maximumQuantity,
    maximumValue:
      input.maximumValue === undefined || input.maximumValue === null || input.maximumValue === ''
        ? null
        : Number(input.maximumValue),
    dailyLimit:
      input.dailyLimit === undefined || input.dailyLimit === null || input.dailyLimit === ''
        ? null
        : Math.trunc(Number(input.dailyLimit)),
    approvalRules: input.approvalRules && typeof input.approvalRules === 'object' ? input.approvalRules : {},
    effectiveFrom: trimOrNull(input.effectiveFrom),
    effectiveUntil: trimOrNull(input.effectiveUntil),
  };
}

/**
 * Creates a policy. It is inert until somebody approves it.
 */
function propose(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.ADMIN, 'create automation policies');
  const clean = validate(db, ctx.workspaceId, input);
  const now = nowIso();
  const id = newId('apol');

  db.prepare(
    `INSERT INTO automation_policies (
       id, workspace_id, name, description, enabled, allowed_action_types, scope,
       item_scope, location_scope, supplier_scope, exclusions, conditions, thresholds,
       maximum_quantity, maximum_value, daily_limit, approval_rules,
       effective_from, effective_until, version, supersedes_policy_id, integrity_hash,
       created_by_user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, ctx.workspaceId, clean.name, clean.description,
    JSON.stringify(clean.allowedActionTypes), JSON.stringify(clean.scope),
    JSON.stringify(clean.itemScope), JSON.stringify(clean.locationScope),
    JSON.stringify(clean.supplierScope), JSON.stringify(clean.exclusions),
    JSON.stringify(clean.conditions), JSON.stringify(clean.thresholds),
    clean.maximumQuantity, clean.maximumValue, clean.dailyLimit,
    JSON.stringify(clean.approvalRules),
    clean.effectiveFrom, clean.effectiveUntil,
    Number(input.version) || 1,
    trimOrNull(input.supersedesPolicyId),
    integrityHash(clean),
    ctx.actorId, now, now
  );

  return get(db, ctx.workspaceId, id);
}

/**
 * Approval is what makes a policy real, and it checks the hash: approving
 * something that changed since it was shown would make the approval meaningless.
 */
function approve(db, ctx, membership, policyId, { expectedHash = null } = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'approve automation policies');
  const policy = get(db, ctx.workspaceId, policyId);
  if (policy.isApproved && policy.enabled) return policy;
  if (expectedHash && expectedHash !== policy.integrityHash) {
    throw new ValidationError('This policy changed since you looked at it. Read it again before approving.');
  }

  const now = nowIso();
  db.prepare(
    `UPDATE automation_policies
        SET enabled = 1, approved_by_user_id = ?, approved_at = ?, disabled_at = NULL,
            disabled_by_user_id = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ?`
  ).run(ctx.actorId, now, now, policyId, ctx.workspaceId);

  // Approving a replacement retires what it replaced, so two versions can
  // never both be authorising work.
  if (policy.supersedesPolicyId) {
    db.prepare(
      `UPDATE automation_policies SET enabled = 0, disabled_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`
    ).run(now, now, policy.supersedesPolicyId, ctx.workspaceId);
  }
  return get(db, ctx.workspaceId, policyId);
}

/**
 * Changing a policy creates the next version rather than editing this one.
 */
function revise(db, ctx, membership, policyId, changes) {
  permissions.assertCan(membership, permissions.ADMIN, 'change automation policies');
  const existing = get(db, ctx.workspaceId, policyId);
  return propose(db, ctx, membership, {
    ...existing,
    ...changes,
    version: existing.version + 1,
    supersedesPolicyId: existing.id,
  });
}

/** "Stop doing that." Already-completed actions stay in history. */
function disable(db, ctx, membership, policyId, reason) {
  permissions.assertCan(membership, permissions.OPERATE, 'stop an automation policy');
  get(db, ctx.workspaceId, policyId);
  const now = nowIso();
  db.prepare(
    `UPDATE automation_policies
        SET enabled = 0, disabled_at = ?, disabled_by_user_id = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`
  ).run(now, ctx.actorId, now, policyId, ctx.workspaceId);
  return get(db, ctx.workspaceId, policyId);
}

function get(db, workspaceId, policyId) {
  const row = db
    .prepare('SELECT * FROM automation_policies WHERE id = ? AND workspace_id = ?')
    .get(policyId, workspaceId);
  if (!row) throw new NotFoundError('That policy is not in this inventory.');
  return hydrate(row);
}

function list(db, workspaceId, { activeOnly = false } = {}) {
  const clause = activeOnly ? ' AND enabled = 1 AND approved_at IS NOT NULL AND disabled_at IS NULL' : '';
  return db
    .prepare(`SELECT * FROM automation_policies WHERE workspace_id = ?${clause} ORDER BY created_at DESC, rowid DESC`)
    .all(workspaceId)
    .map(hydrate);
}

/** Active policies that could authorise this kind of action. */
function activeFor(db, workspaceId, actionType) {
  return list(db, workspaceId, { activeOnly: true }).filter((policy) =>
    policy.allowedActionTypes.includes(actionType)
  );
}

/** Records what a policy decided, so it can be shown later as evidence. */
function recordEvaluation(db, workspaceId, evaluation) {
  const id = newId('pev');
  db.prepare(
    `INSERT INTO policy_evaluations (
       id, workspace_id, policy_id, work_item_id, decision, reason, checks, policy_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, workspaceId, evaluation.policyId || null, evaluation.workItemId || null,
    evaluation.decision, evaluation.reason || '', JSON.stringify(evaluation.checks || []),
    evaluation.policyVersion || null, nowIso()
  );
  return id;
}

/** In plain words: what this policy lets Foundry do. */
function describe(policy) {
  // Tolerant of a partial policy on purpose: this is also how a *draft* is read
  // back to someone before it exists, and a display helper that throws on a
  // missing field would take a whole page down to save a null check.
  const lines = [];
  lines.push(`Foundry may ${(policy.allowedActionTypes || []).join(' and ') || 'do nothing'} without asking.`);
  if (policy.maximumQuantity) lines.push(`Never more than ${policy.maximumQuantity} units in one go.`);
  if (policy.dailyLimit) lines.push(`At most ${policy.dailyLimit} of these a day.`);
  if ((policy.locationScope || []).length) lines.push(`Only between the locations you listed.`);
  if ((policy.itemScope || []).length) lines.push(`Only for the products you listed.`);
  for (const condition of policy.conditions || []) {
    if (CONDITION_LABEL[condition]) lines.push(`Only when ${CONDITION_LABEL[condition]}.`);
  }
  lines.push('Anything outside this comes to you first.');
  return lines;
}

module.exports = {
  AUTOMATABLE_ACTIONS,
  CONDITIONS,
  CONDITION_LABEL,
  stableStringify,
  integrityHash,
  hydrate,
  validate,
  propose,
  approve,
  revise,
  disable,
  get,
  list,
  activeFor,
  recordEvaluation,
  describe,
};
