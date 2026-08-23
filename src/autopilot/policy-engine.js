'use strict';

/**
 * The gate. Every autonomous action passes through here, and nothing else
 * decides whether Foundry may act.
 *
 * It is deliberately dull code: measurements compared with numbers a person
 * approved. No model is consulted, no heuristic is applied, and the same inputs
 * always produce the same verdict — which is the only reason it is safe to let
 * anything run unattended.
 *
 * The verdict is one of:
 *
 *   authorized      every condition and limit passed; Foundry may proceed
 *   needs_approval  the work is sound but nothing authorises doing it silently
 *   refused         a limit or condition says no; the work must not happen
 *
 * Every verdict carries the individual checks, so "why did you move those
 * tights" is answered with the rule and the measurement rather than a summary.
 */

const modes = require('./modes');
const paths = require('../onboarding/paths');
const policyService = require('./policy-service');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const check = (name, passed, detail) => ({ name, passed, detail });

/**
 * The value Foundry has already committed automatically today.
 *
 * Only actions whose value was actually known are counted. An unpriced transfer
 * contributes nothing rather than a guessed figure — a budget spent against
 * invented numbers is not a budget.
 */
function valueToday(db, workspaceId, { now = Date.now() } = {}) {
  const since = new Date(now - DAY_MS).toISOString();
  return db
    .prepare(
      `SELECT COALESCE(SUM(json_extract(outcome, '$.value')), 0) AS total FROM work_items
        WHERE workspace_id = ? AND completed_at >= ? AND approval_requirement = 'NONE'
          AND execution_status = 'COMPLETED' AND json_extract(outcome, '$.value') IS NOT NULL`
    )
    .get(workspaceId, since).total || 0;
}

/**
 * How long a migrated inventory operates before Foundry may act on it, and how
 * much real trading it must have done.
 *
 * Deliberately modest. This is a settling period, not a probation: it exists so
 * that the first automatic action rests on movements Foundry recorded itself
 * rather than on a spreadsheet's opening figure.
 */
const SETTLING_DAYS = 14;
const SETTLING_MOVEMENTS = 5;

/**
 * Whether this workspace has been operated rather than merely loaded.
 *
 * A workspace that never imported anything is native and needs no settling —
 * every number in it arrived through the engine in the first place.
 */
function migrationSettled(db, workspaceId, { now = Date.now() } = {}) {
  const opening = db
    .prepare(
      `SELECT MIN(occurred_at) AS first, MAX(occurred_at) AS last FROM movements
        WHERE workspace_id = ? AND notes = 'Initial inventory import'`
    )
    .get(workspaceId);

  if (!opening || !opening.last) {
    return { ok: true, detail: 'nothing was imported; every movement is Foundry’s own' };
  }

  // Movements recorded after the opening balances, excluding the import itself
  // and Foundry's own automatic work — a migration cannot vouch for itself, and
  // neither can the automation being judged.
  const since = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(occurred_at) AS first FROM movements
        WHERE workspace_id = ? AND occurred_at > ? AND notes IS NOT 'Initial inventory import'`
    )
    .get(workspaceId, opening.last);

  const days = since.first ? (now - Date.parse(since.first)) / DAY_MS : 0;
  if (since.n < SETTLING_MOVEMENTS || days < SETTLING_DAYS) {
    return {
      ok: false,
      detail: `${since.n} movements over ${Math.floor(days)} days since the opening balances`,
      because:
        'This inventory was brought in from somewhere else and has not been operated here long enough ' +
        'for Foundry to act on its own yet. It will keep preparing the work for you.',
    };
  }
  return { ok: true, detail: `${since.n} movements over ${Math.floor(days)} days since the opening balances` };
}

/** Automatic actions already taken today, for the daily budget. */
function actionsToday(db, workspaceId, { now = Date.now(), category = null } = {}) {
  const since = new Date(now - DAY_MS).toISOString();
  const clause = category ? ' AND category = ?' : '';
  const params = category ? [workspaceId, since, category] : [workspaceId, since];
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM work_items
        WHERE workspace_id = ? AND completed_at >= ? AND approval_requirement = 'NONE'
          AND execution_status = 'COMPLETED'${clause}`
    )
    .get(...params).n;
}

/**
 * Recent automatic actions on one product, for the cooldown and the
 * per-item weekly ceiling.
 *
 * This is what stops stock bouncing between two warehouses. A signal that
 * crosses a threshold, gets acted on, and crosses back is not new information
 * — it is the same information moving, and acting on it again would be a loop.
 */
function recentActionsForSku(db, workspaceId, skuId, { now = Date.now() } = {}) {
  const rows = db
    .prepare(
      `SELECT completed_at, recommended_action, affected_entities FROM work_items
        WHERE workspace_id = ? AND execution_status = 'COMPLETED' AND completed_at IS NOT NULL
        ORDER BY completed_at DESC LIMIT 200`
    )
    .all(workspaceId);

  const mine = [];
  for (const row of rows) {
    let entities = {};
    try {
      entities = JSON.parse(row.affected_entities) || {};
    } catch {
      entities = {};
    }
    if (entities.skuId !== skuId) continue;
    let action = {};
    try {
      action = JSON.parse(row.recommended_action) || {};
    } catch {
      action = {};
    }
    mine.push({ completedAt: row.completed_at, at: Date.parse(row.completed_at), action });
  }
  return mine;
}

/**
 * Decides whether a planned action may run.
 *
 * @param {object} plan { actionType, skuId, quantity, fromLocationId, toLocationId, value, evidence }
 */
function evaluate(db, workspaceId, plan, options = {}) {
  const now = options.now || Date.now();
  const checks = [];

  // 1. Is Foundry allowed to act at all in this workspace right now?
  const execution = modes.executionState(db, workspaceId, { scope: plan.actionType });
  checks.push(check('Foundry is able to act', execution.allowed, execution.because || null));
  if (!execution.allowed) {
    return { decision: 'refused', reason: execution.because, checks, policy: null };
  }

  // 2. Are these records the ones that count?
  //
  // A workspace whose stock is really kept in another system can be read from
  // and reconciled against, but Foundry writing to its own ledger there would
  // be writing to a copy — the movement would look successful and the business
  // would still be wrong. Until a connector can write and independently re-read
  // the result, that is prepared for a person, never executed. Fails closed:
  // an unrecognised mode is treated as not-native.
  const sourceOfTruth = paths.sourceOfTruth(db, workspaceId);
  const native = sourceOfTruth === paths.SOURCE_OF_TRUTH.FOUNDRY_NATIVE;
  checks.push(check('These records are the ones that count', native, native ? null : sourceOfTruth));
  if (!native) {
    return {
      decision: 'needs_approval',
      reason:
        'This inventory is kept in another system, so Foundry prepares the work rather than carrying it out here.',
      checks,
      policy: null,
    };
  }

  // 3. Has this inventory actually been operated, or only loaded?
  //
  // A migration produces a workspace that looks fully stocked within minutes,
  // and every number in it is somebody else's — a spreadsheet's idea of what
  // was on the shelf, not a movement Foundry watched happen. Acting on that
  // immediately means acting on an unverified copy, and the first thing a
  // customer would see from their new system is stock moving on the strength of
  // a figure that was already wrong. Earning trust takes trading days.
  const settled = migrationSettled(db, workspaceId, { now });
  checks.push(check('This inventory has been operated, not just loaded', settled.ok, settled.detail));
  if (!settled.ok) {
    return {
      decision: 'needs_approval',
      reason: settled.because,
      checks,
      policy: null,
    };
  }

  // 4. Is there an approved policy covering this exact action?
  const candidates = policyService.activeFor(db, workspaceId, plan.actionType);
  if (!candidates.length) {
    checks.push(check('An approved policy allows this', false, 'no policy covers this action'));
    return {
      decision: 'needs_approval',
      reason: 'No policy authorises Foundry to do this on its own, so it is prepared for you instead.',
      checks,
      policy: null,
    };
  }

  const limits = modes.limits(db, workspaceId);
  let bestRefusal = null;

  for (const policy of candidates) {
    const result = evaluateAgainstPolicy(db, workspaceId, plan, policy, limits, now);
    if (result.decision === 'authorized') {
      // Automatic execution additionally requires the workspace to be in the
      // mode that permits it; a policy alone is not enough.
      if (!execution.automatic) {
        return {
          decision: 'needs_approval',
          reason: 'This inventory is supervised, so Foundry prepares the work and waits for you.',
          checks: [...checks, ...result.checks],
          policy,
        };
      }
      return { ...result, checks: [...checks, ...result.checks], policy };
    }
    if (!bestRefusal) bestRefusal = { ...result, policy };
  }

  return {
    decision: bestRefusal ? bestRefusal.decision : 'needs_approval',
    reason: bestRefusal ? bestRefusal.reason : 'No policy authorises this.',
    checks: [...checks, ...(bestRefusal ? bestRefusal.checks : [])],
    policy: bestRefusal ? bestRefusal.policy : null,
  };
}

function evaluateAgainstPolicy(db, workspaceId, plan, policy, limits, now) {
  const checks = [];
  const refuse = (reason) => ({ decision: 'refused', reason, checks });

  // --- scope ----------------------------------------------------------------
  if (policy.effectiveFrom && new Date(now).toISOString() < policy.effectiveFrom) {
    checks.push(check('Policy is in force', false, `starts ${policy.effectiveFrom}`));
    return refuse(`${policy.name} does not start until ${policy.effectiveFrom}.`);
  }
  if (policy.effectiveUntil && new Date(now).toISOString() > policy.effectiveUntil) {
    checks.push(check('Policy is in force', false, `ended ${policy.effectiveUntil}`));
    return refuse(`${policy.name} ended on ${policy.effectiveUntil}.`);
  }
  checks.push(check('Policy is in force', true, policy.name));

  if (policy.itemScope.length && !policy.itemScope.includes(plan.skuId) && !policy.itemScope.includes(plan.itemId)) {
    checks.push(check('Product is in scope', false, 'this product is not on the policy'));
    return refuse(`${policy.name} does not cover this product.`);
  }
  if (policy.exclusions.includes(plan.skuId) || policy.exclusions.includes(plan.itemId)) {
    checks.push(check('Product is not excluded', false, 'explicitly excluded'));
    return refuse(`${policy.name} excludes this product.`);
  }
  checks.push(check('Product is in scope', true, null));

  const locations = [plan.fromLocationId, plan.toLocationId].filter(Boolean);
  if (policy.locationScope.length && !locations.every((id) => policy.locationScope.includes(id))) {
    checks.push(check('Locations are in scope', false, 'one of these locations is not on the policy'));
    return refuse(`${policy.name} does not cover both of those locations.`);
  }
  checks.push(check('Locations are in scope', true, null));

  if (policy.supplierScope.length && (!plan.supplierId || !policy.supplierScope.includes(plan.supplierId))) {
    checks.push(check('Supplier is in scope', false, 'this supplier is not on the policy'));
    return refuse(`${policy.name} does not cover this supplier.`);
  }
  if (plan.supplierId) checks.push(check('Supplier is in scope', true, null));

  // --- limits ---------------------------------------------------------------
  const quantity = Number(plan.quantity) || 0;
  if (policy.maximumQuantity && quantity > policy.maximumQuantity) {
    checks.push(check('Within the policy quantity limit', false, `${quantity} > ${policy.maximumQuantity}`));
    return refuse(`${policy.name} allows at most ${policy.maximumQuantity} units in one go; this is ${quantity}.`);
  }
  checks.push(check(
    'Within the policy quantity limit',
    true,
    policy.maximumQuantity ? `${quantity} of ${policy.maximumQuantity}` : `${quantity}; this rule sets no quantity cap`
  ));

  if (quantity > limits.maxUnitsPerAction) {
    checks.push(check('Within the workspace unit limit', false, `${quantity} > ${limits.maxUnitsPerAction}`));
    return refuse(`This inventory caps automatic actions at ${limits.maxUnitsPerAction} units.`);
  }
  checks.push(check('Within the workspace unit limit', true, null));

  if (plan.value !== undefined && plan.value !== null) {
    if (policy.maximumValue && plan.value > policy.maximumValue) {
      checks.push(check('Within the policy value limit', false, `${plan.value} > ${policy.maximumValue}`));
      return refuse(`${policy.name} allows at most ${policy.maximumValue} of value per action.`);
    }
    if (limits.maxValuePerAction && plan.value > limits.maxValuePerAction) {
      checks.push(check('Within the workspace value limit', false, null));
      return refuse(`This inventory caps automatic actions at ${limits.maxValuePerAction} of value.`);
    }
    if (limits.maxValuePerDay) {
      const spent = valueToday(db, workspaceId, { now });
      if (spent + plan.value > limits.maxValuePerDay) {
        checks.push(check('Within the daily value budget', false, `${spent} already today`));
        return refuse(
          `Foundry has committed ${spent} of its ${limits.maxValuePerDay} daily value budget, and this would go over it.`
        );
      }
      checks.push(check('Within the daily value budget', true, `${spent} of ${limits.maxValuePerDay} used`));
    }
  }

  if (plan.actionType === 'approve_purchase_order') {
    const allowedIncrease = Number(policy.thresholds.maxUnitPriceChangePercent);
    const measuredIncrease = Number(plan.maxPriceIncreasePercent) || 0;
    if (Number.isFinite(allowedIncrease) && measuredIncrease > allowedIncrease) {
      checks.push(check('Price is within the approved change limit', false, `${measuredIncrease}% > ${allowedIncrease}%`));
      return refuse(`A known unit price rose ${measuredIncrease}%, above ${policy.name}'s ${allowedIncrease}% limit.`);
    }
    checks.push(check('Price is within the approved change limit', true, `${measuredIncrease}% of ${allowedIncrease}%`));
  }

  const today = actionsToday(db, workspaceId, { now });
  if (today >= limits.maxActionsPerDay) {
    checks.push(check('Within the daily budget', false, `${today} already today`));
    return refuse(`Foundry has already taken its ${limits.maxActionsPerDay} automatic actions for today.`);
  }
  if (policy.dailyLimit && today >= policy.dailyLimit) {
    checks.push(check('Within the policy daily limit', false, `${today} already today`));
    return refuse(`${policy.name} allows ${policy.dailyLimit} actions a day and that is used up.`);
  }
  checks.push(check('Within the daily budget', true, `${today} of ${limits.maxActionsPerDay} used`));

  // --- anti-oscillation -----------------------------------------------------
  const recent = recentActionsForSku(db, workspaceId, plan.skuId, { now });
  const lastAction = recent[0];
  if (lastAction && limits.cooldownHours) {
    const hoursSince = (now - lastAction.at) / HOUR_MS;
    if (hoursSince < limits.cooldownHours) {
      checks.push(check('Cooldown has elapsed', false, `${Math.round(hoursSince)}h of ${limits.cooldownHours}h`));
      return refuse(
        `Foundry moved this product ${Math.round(hoursSince)} hours ago and waits ${limits.cooldownHours} hours before moving it again.`
      );
    }
  }
  checks.push(check('Cooldown has elapsed', true, null));

  const weekAgo = now - 7 * DAY_MS;
  const thisWeek = recent.filter((entry) => entry.at >= weekAgo).length;
  if (thisWeek >= limits.maxActionsPerItemPerWeek) {
    checks.push(check('Within the per-product weekly limit', false, `${thisWeek} this week`));
    return refuse(
      `Foundry has already moved this product ${thisWeek} times this week, which is its limit. Something else is going on here.`
    );
  }
  checks.push(check('Within the per-product weekly limit', true, `${thisWeek} of ${limits.maxActionsPerItemPerWeek}`));

  // Moving it straight back is the signature of two policies fighting, or of a
  // threshold that sits right on the usual balance. Refuse and say so.
  const reversal = recent.find(
    (entry) =>
      entry.action &&
      entry.action.fromLocationId === plan.toLocationId &&
      entry.action.toLocationId === plan.fromLocationId &&
      now - entry.at < 7 * DAY_MS
  );
  if (reversal) {
    checks.push(check('Not a reversal of a recent move', false, `moved the other way on ${reversal.completedAt.slice(0, 10)}`));
    return refuse(
      'This would move the stock straight back where it came from. Foundry stops rather than bouncing it between locations.'
    );
  }
  checks.push(check('Not a reversal of a recent move', true, null));

  // --- conditions -----------------------------------------------------------
  for (const condition of policy.conditions) {
    const evidence = (plan.conditions || {})[condition];
    if (evidence === undefined) {
      checks.push(check(policyService.CONDITION_LABEL[condition] || condition, false, 'not measured'));
      return refuse(`Foundry could not measure whether ${policyService.CONDITION_LABEL[condition]}.`);
    }
    if (evidence !== true && !(evidence && evidence.passed)) {
      const detail = evidence && evidence.detail ? evidence.detail : null;
      checks.push(check(policyService.CONDITION_LABEL[condition] || condition, false, detail));
      return refuse(`Not doing this because it is not true that ${policyService.CONDITION_LABEL[condition]}.`);
    }
    checks.push(
      check(policyService.CONDITION_LABEL[condition] || condition, true, evidence.detail || null)
    );
  }

  return {
    decision: 'authorized',
    reason: `${policy.name} allows this.`,
    checks,
  };
}

/**
 * Policies that cannot all be satisfied for one product at once.
 *
 * Two rules that each demand a minimum, where the stock on hand cannot meet
 * both, will otherwise produce an endless argument conducted in transfers. The
 * answer is not to pick one — it is to say so and let a person decide.
 */
function detectConflicts(db, workspaceId, skuId, { totalOnHand }) {
  const active = policyService.list(db, workspaceId, { activeOnly: true });
  const floors = [];

  for (const policy of active) {
    const minimums = policy.thresholds && policy.thresholds.minimumByLocation;
    if (!minimums) continue;
    for (const [locationId, minimum] of Object.entries(minimums)) {
      floors.push({ policy: policy.name, policyId: policy.id, locationId, minimum: Number(minimum) || 0 });
    }
  }
  if (floors.length < 2) return null;

  const required = floors.reduce((sum, floor) => sum + floor.minimum, 0);
  if (required <= totalOnHand) return null;

  return {
    skuId,
    required,
    totalOnHand,
    floors,
    message:
      `Your policies ask for ${required} units to be kept in reserve across locations, but there are only ` +
      `${totalOnHand}. Foundry will not keep moving stock between them trying to satisfy both — decide which matters more.`,
  };
}

module.exports = {
  evaluate,
  evaluateAgainstPolicy,
  detectConflicts,
  actionsToday,
  recentActionsForSku,
  check,
};
