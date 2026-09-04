'use strict';

/**
 * What Foundry proposed, who decided, and what happened next.
 *
 * A prediction that changes a decision has to outlive the decision. Six months
 * after a recommendation was accepted, the useful question is never "what does
 * the model think now" — it is "what did it say then, on what evidence, under
 * whose authority, and did it turn out to be right". None of that can be
 * reconstructed later: the demand history will have moved, the supplier's lead
 * times will have moved, and re-running today's arithmetic answers a different
 * question while looking like an answer to the original one.
 *
 * So the evidence is frozen at the moment of proposing, and the whole life of a
 * recommendation lives in one row: raised, authorised or not, decided, applied,
 * and eventually scored.
 *
 * The authority story is not this module's to invent. Every consequential
 * action goes to the same gate everything else in Foundry goes to, and the
 * verdict is recorded whatever it is. A forecast being confident is not a
 * reason to act — confidence is a property of a prediction, and authority is a
 * property of a permission somebody granted. Conflating the two is how a
 * planning system starts spending money nobody agreed to.
 */

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const policyEngine = require('../autopilot/policy-engine');
const { CAPABILITY_FOR_ACTION } = require('../autopilot/capabilities');

const json = (value) => JSON.stringify(value === undefined ? null : value);
const parse = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

/**
 * Which authority gate each kind of recommendation belongs behind.
 *
 * A kind that is not on this list has no action attached — it is advice, and
 * advice needs no permission. A kind that *would* change something and is
 * missing from here gets no authority, which fails closed.
 */
const ACTION_FOR_KIND = {
  reorder_point: 'adjust_replenishment_policy',
  target_stock: 'adjust_replenishment_policy',
  safety_stock: 'adjust_replenishment_policy',
  transfer: 'transfer',
  order_now: 'prepare_purchase_order',
};

/**
 * Stores the forecast behind a recommendation, exactly as it stood.
 *
 * Written when a forecast is about to influence something, not every time one
 * is calculated. A page that shows a projection is a question, and storing an
 * answer to every question buries the ones that mattered.
 */
function saveForecast(db, workspaceId, forecast, { locationId = null } = {}) {
  const id = newId('fc');
  const now = nowIso();
  const horizonEnd = new Date(Date.parse(`${forecast.asOf}T00:00:00.000Z`)
    + forecast.horizonDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  db.prepare(`INSERT INTO demand_forecasts
      (id, workspace_id, sku_id, location_id, as_of, horizon_days, horizon_end,
       daily_rate, horizon_units, committed_units, confidence, model_id, model_version,
       evidence, backtest, calculation, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, forecast.skuId, locationId || forecast.locationId || null,
      forecast.asOf, forecast.horizonDays, horizonEnd,
      forecast.dailyRate, forecast.horizonUnits, forecast.committedUnits || 0,
      forecast.confidence, forecast.model ? forecast.model.id : null, forecast.version,
      json(forecast.evidence), json(forecast.backtest), json(forecast.calculation), now);

  return { id, horizonEnd };
}

/**
 * A stable name for "this proposal, about this thing, today".
 *
 * The same shortage evaluated three times in a morning is one recommendation.
 * Without this, a scheduled sweep and someone opening the product page produce
 * two rows, two notifications and — if either is ever acted on automatically —
 * two purchase orders. The date is part of the key so that a proposal genuinely
 * re-raised next week is a new one.
 */
function keyFor({ kind, subjectId, recommendedValue, asOf }) {
  const digest = crypto.createHash('sha256')
    .update([kind, subjectId, String(recommendedValue ?? ''), asOf].join('|'))
    .digest('hex').slice(0, 24);
  return `${kind}:${digest}`;
}

/**
 * Records a recommendation, asking the authority gate what may be done with it.
 *
 * Returns the stored row either way. A refused recommendation is still worth
 * keeping and still worth showing — "Foundry wanted to do this and was not
 * allowed" is information the owner is entitled to.
 */
function record(db, workspaceId, input, options = {}) {
  const now = options.now || Date.now();
  const asOf = new Date(now).toISOString().slice(0, 10);
  if (!input.kind) throw new ValidationError('A recommendation needs a kind.');
  if (!input.headline) throw new ValidationError('A recommendation needs something to say.');

  const idempotencyKey = input.idempotencyKey
    || keyFor({ kind: input.kind, subjectId: input.subjectId || input.skuId || workspaceId,
      recommendedValue: input.recommendedValue, asOf });

  const existing = db.prepare(`SELECT * FROM planning_recommendations
    WHERE workspace_id = ? AND idempotency_key = ?`).get(workspaceId, idempotencyKey);
  if (existing) return hydrate(existing);

  // What would it take to do this on Foundry's own authority?
  const actionType = ACTION_FOR_KIND[input.kind] || null;
  let verdict = null;
  let detail = {};
  if (actionType) {
    const plan = {
      actionType,
      skuId: input.skuId || null,
      quantity: input.quantity ?? null,
      fromLocationId: input.fromLocationId || null,
      toLocationId: input.toLocationId || null,
      value: input.valueMinor !== undefined && input.valueMinor !== null
        ? Number(input.valueMinor) / 100 : null,
      evidence: input.evidence || {},
    };
    try {
      const judged = policyEngine.evaluate(db, workspaceId, plan, { now });
      verdict = judged.decision;
      detail = { reason: judged.reason || null, checks: judged.checks || [],
        policy: judged.policy ? { id: judged.policy.id, name: judged.policy.name } : null,
        capability: CAPABILITY_FOR_ACTION[actionType] || null, actionType };
    } catch (error) {
      // A gate that cannot answer is a gate that says no.
      verdict = 'refused';
      detail = { reason: `The authority check could not be completed: ${error.message}`, actionType };
    }
  }

  const id = newId('rec');
  const iso = nowIso();
  db.prepare(`INSERT INTO planning_recommendations
      (id, workspace_id, kind, subject_type, subject_id, sku_id, supplier_id,
       current_value, recommended_value, headline, why, forecast_id, confidence, evidence,
       capability, authority_verdict, authority_detail, status, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`)
    .run(id, workspaceId, input.kind, input.subjectType || 'sku',
      input.subjectId || input.skuId || null, input.skuId || null, input.supplierId || null,
      input.currentValue ?? null, input.recommendedValue ?? null,
      input.headline, input.why || '', input.forecastId || null, input.confidence || null,
      json(input.evidence || {}), detail.capability || null, verdict, json(detail),
      idempotencyKey, iso, iso);

  return hydrate(db.prepare('SELECT * FROM planning_recommendations WHERE id = ?').get(id));
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    skuId: row.sku_id,
    supplierId: row.supplier_id,
    currentValue: row.current_value,
    recommendedValue: row.recommended_value,
    headline: row.headline,
    why: row.why,
    forecastId: row.forecast_id,
    confidence: row.confidence,
    evidence: parse(row.evidence, {}),
    capability: row.capability,
    authorityVerdict: row.authority_verdict,
    authorityDetail: parse(row.authority_detail, {}),
    status: row.status,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at,
    resultingAction: row.resulting_action,
    resultingDetail: parse(row.resulting_detail, {}),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM planning_recommendations WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id);
  if (!row) throw new NotFoundError('That recommendation could not be found.');
  return hydrate(row);
}

/** Everything still waiting on somebody. */
function open(db, workspaceId, { kind = null, limit = 50 } = {}) {
  const clause = kind ? ' AND kind = ?' : '';
  const params = kind ? [workspaceId, kind, limit] : [workspaceId, limit];
  return db.prepare(`SELECT * FROM planning_recommendations
    WHERE workspace_id = ? AND status = 'OPEN'${clause}
    ORDER BY created_at DESC LIMIT ?`).all(...params).map(hydrate);
}

/**
 * Records a decision.
 *
 * `applied` is separate from `accepted` on purpose: an owner agreeing with a
 * recommendation and the change actually landing are two events, and a system
 * that treats agreement as completion eventually reports work it never did.
 */
function decide(db, ctx, id, status, { detail = {}, resultingAction = null } = {}) {
  const allowed = ['ACCEPTED', 'DECLINED', 'APPLIED', 'SUPERSEDED', 'EXPIRED'];
  if (!allowed.includes(status)) throw new ValidationError('That is not a decision Foundry records.');
  const now = nowIso();
  const changed = db.prepare(`UPDATE planning_recommendations
      SET status = ?, decided_by_user_id = ?, decided_at = ?, resulting_action = ?,
          resulting_detail = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ? AND status IN ('OPEN', 'ACCEPTED')`)
    .run(status, ctx.actorId || null, now, resultingAction, json(detail), now, ctx.workspaceId, id);
  if (!changed.changes) {
    // Already decided. Not an error — two people clicking the same button is a
    // normal thing that happens, and the second one should see the outcome.
    return get(db, ctx.workspaceId, id);
  }
  return get(db, ctx.workspaceId, id);
}

/**
 * May Foundry do this one on its own?
 *
 * The single place that question is answered, so it cannot be answered
 * differently in two code paths. Note what it does *not* consider: how
 * confident the forecast was.
 */
function mayActAlone(recommendation) {
  return recommendation.authorityVerdict === 'authorized';
}

module.exports = {
  record, decide, get, open, hydrate, saveForecast, keyFor, mayActAlone,
  ACTION_FOR_KIND,
};
