'use strict';

/**
 * Turning a recommendation into a change.
 *
 * Everything up to here is opinion. This is the one file in src/forecasting
 * that alters the running business, and it is deliberately small, deliberately
 * boring, and deliberately the only door.
 *
 * Three rules hold it together:
 *
 *   authority is checked here, again      not because the gate was wrong when
 *                                         the recommendation was raised, but
 *                                         because that was hours ago and the
 *                                         owner may have paused StockChief since
 *
 *   a person's click needs no capability  granting StockChief authority is about
 *                                         what it may do *unattended*. An owner
 *                                         pressing "Use 84" is the owner
 *                                         changing their own setting, and
 *                                         requiring a capability for that would
 *                                         be StockChief withholding a button
 *
 *   applying twice changes nothing        the recommendation moves to APPLIED
 *                                         and a second attempt returns the
 *                                         first outcome
 *
 * What StockChief may do on its own is narrow on purpose: keep replenishment
 * levels current, and only that. Placing orders and moving stock stay where
 * they already were — behind their own capabilities and their own approved
 * policies, planned by the existing engines. A forecast is not a new way to
 * spend money.
 */

const { ValidationError } = require('../domain/errors');
const recommendations = require('./recommendations');
const purchasingPolicy = require('../purchasing/policy-service');
const policyEngine = require('../autopilot/policy-engine');
const managerEvents = require('../manager/events');

/** Which reorder setting each kind of advice writes. */
const POLICY_FIELD = {
  reorder_point: 'reorderPoint',
  target_stock: 'targetStock',
  safety_stock: 'safetyStock',
};

/**
 * Applies a recommendation on somebody's instruction.
 *
 * @param options.automatic true when StockChief is acting unattended, which is the
 *        only case that has to pass the authority gate.
 */
function accept(db, ctx, membership, id, options = {}) {
  const recommendation = recommendations.get(db, ctx.workspaceId, id);
  if (recommendation.status === 'APPLIED') return { recommendation, applied: false, replayed: true };
  if (recommendation.status === 'DECLINED') {
    throw new ValidationError('That recommendation was already turned down.');
  }

  const automatic = Boolean(options.automatic);
  if (automatic) {
    /*
     * Re-asked at the moment of acting. The verdict stored on the row was true
     * when the sweep ran; between then and now somebody may have paused
     * StockChief, and a stale yes is exactly the sort of thing that acts through
     * a stock take.
     */
    const verdict = judge(db, ctx.workspaceId, recommendation, { now: options.now });
    if (verdict.decision !== 'authorized') {
      return { recommendation, applied: false, refused: true, because: verdict.reason };
    }
  }

  const field = POLICY_FIELD[recommendation.kind];
  if (!field) {
    // Transfers and purchase orders are not applied from here. They are
    // prepared by the engines that already own them, under their own authority.
    throw new ValidationError('StockChief does not apply that kind of recommendation directly. '
      + 'Open the order or transfer and approve it there.');
  }
  if (recommendation.recommendedValue === null || recommendation.recommendedValue === undefined) {
    throw new ValidationError('That recommendation has no figure to apply.');
  }

  const value = Math.round(Number(recommendation.recommendedValue));
  purchasingPolicy.setPolicy(db, ctx, membership, recommendation.skuId, {
    [field]: value,
    source: automatic ? 'foundry' : 'manual',
  });

  const applied = recommendations.decide(db, ctx, id, 'APPLIED', {
    detail: {
      field,
      from: recommendation.currentValue,
      to: value,
      automatic,
      // Kept so "why is my reorder point 84" is answerable from the row alone.
      because: recommendation.why,
    },
    resultingAction: `reorder_policy:${recommendation.skuId}`,
  });

  /*
   * Announced like any other operational change. A level that moved on its own
   * has to show up in the activity record, or the first anyone knows about it
   * is an order they did not expect.
   */
  try {
    managerEvents.publish(db, ctx.workspaceId, managerEvents.TYPES.REORDER_POLICY_UPDATED, {
      skuId: recommendation.skuId, field, from: recommendation.currentValue, to: value,
      automatic, recommendationId: id,
    }, { source: automatic ? 'foundry' : 'user', idempotencyKey: `planning-level:${id}` });
  } catch {
    // The setting is changed and recorded. Failing to announce it must not
    // undo it, and the row above is the durable record either way.
  }

  return { recommendation: applied, applied: true, field, value };
}

/** Turning one down is a decision too, and worth keeping. */
function decline(db, ctx, id, reason = null) {
  const recommendation = recommendations.get(db, ctx.workspaceId, id);
  if (recommendation.status === 'APPLIED') {
    throw new ValidationError('That recommendation has already been applied.');
  }
  return recommendations.decide(db, ctx, id, 'DECLINED', { detail: { reason } });
}

/** Asks the gate about a recommendation, now rather than when it was raised. */
function judge(db, workspaceId, recommendation, { now = Date.now() } = {}) {
  const actionType = recommendations.ACTION_FOR_KIND[recommendation.kind];
  if (!actionType) return { decision: 'refused', reason: 'Nothing authorises that kind of change.' };
  try {
    return policyEngine.evaluate(db, workspaceId, {
      actionType,
      skuId: recommendation.skuId || null,
      quantity: recommendation.recommendedValue ?? null,
      value: null,
      evidence: recommendation.evidence || {},
    }, { now });
  } catch (error) {
    return { decision: 'refused', reason: `The authority check could not be completed: ${error.message}` };
  }
}

/**
 * Applies everything StockChief is actually allowed to apply on its own.
 *
 * Called from the scheduled turn. Returns what it did and what it left alone,
 * so the turn can report both — an owner who granted this should be able to see
 * every level StockChief moved, and every one it wanted to and could not.
 */
function applyAuthorised(db, ctx, membership, options = {}) {
  const applied = [];
  const left = [];
  for (const recommendation of recommendations.open(db, ctx.workspaceId, { limit: 100 })) {
    if (!POLICY_FIELD[recommendation.kind]) continue;
    if (!recommendations.mayActAlone(recommendation)) {
      left.push({ id: recommendation.id, because: 'not authorised' });
      continue;
    }
    try {
      const outcome = accept(db, ctx, membership, recommendation.id, { automatic: true, now: options.now });
      if (outcome.applied) applied.push(outcome);
      else left.push({ id: recommendation.id, because: outcome.because || 'already decided' });
    } catch (error) {
      left.push({ id: recommendation.id, because: error.message });
    }
  }
  return { applied, left };
}

module.exports = { accept, decline, applyAuthorised, judge, POLICY_FIELD };
