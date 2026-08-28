'use strict';

/**
 * The durable record of work Foundry decided should happen.
 *
 * The important word is durable. A screen showing "transferring…" is not state:
 * if the process dies between the engine writing a movement and the record
 * being updated, the only way to avoid either repeating the transfer or losing
 * it is to have written down what was being attempted, under a key that makes
 * the attempt recognisable afterwards.
 *
 * So every item carries an idempotency key derived from the situation that
 * produced it. Planning the same situation twice yields the same key and the
 * unique index refuses the duplicate — which is what makes a scheduler that
 * fires twice, or two evaluations racing, harmless.
 *
 * The lifecycle is explicit and one-way:
 *
 *   DETECTED → PLANNED → WAITING_FOR_APPROVAL → AUTHORIZED
 *                     ↘ AUTHORIZED
 *   AUTHORIZED → EXECUTING → VERIFYING → COMPLETED
 *                          ↘ FAILED / BLOCKED / CANCELLED
 */

const crypto = require('crypto');
const { newId, nowIso } = require('../lib/util');
const { NotFoundError, ValidationError } = require('../domain/errors');

const STATUS = {
  DETECTED: 'DETECTED',
  PLANNED: 'PLANNED',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  AUTHORIZED: 'AUTHORIZED',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
  // Not cancelled — nobody rejected it — and not failed. A later decision that
  // covers the same stock need took it over, and it must not be approvable or
  // executable any more, because carrying out both would move or buy twice.
  SUPERSEDED: 'SUPERSEDED',
};

/** Statuses that are finished, one way or another. */
const TERMINAL = [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, STATUS.SUPERSEDED];
/** Statuses where a restart has to reconcile before doing anything. */
const IN_FLIGHT = [STATUS.EXECUTING, STATUS.VERIFYING];

const CATEGORY_LABEL = {
  replenishment_plan: 'Replenishment plan',
  balance_transfer: 'Move stock between locations',
  replenishment: 'Replenishment',
  purchase_preparation: 'Prepare a purchase order',
  purchase_approval: 'Approve a purchase order',
  receiving_followup: 'Follow up a delivery',
  expiration_review: 'Review stock approaching expiry',
  attention_review: 'Review a finding',
  discrepancy_review: 'Investigate a discrepancy',
  stale_recommendation: 'Recheck a recommendation',
};

const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * The key that makes planning repeatable.
 *
 * Deliberately built from the *situation*, not the moment: the same shortage on
 * the same product between the same two locations on the same day is one piece
 * of work however many times the loop runs.
 */
function keyFor(category, parts, { now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ category, parts, day }))
    .digest('hex')
    .slice(0, 24);
  return `${category}:${digest}`;
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workPlanId: row.work_plan_id,
    triggerEventId: row.trigger_event_id || null,
    category: row.category,
    categoryLabel: CATEGORY_LABEL[row.category] || row.category,
    source: row.source,
    sourceEvidence: json(row.source_evidence, []),
    affectedEntities: json(row.affected_entities, {}),
    recommendedAction: json(row.recommended_action, {}),
    priority: row.priority,
    urgency: row.urgency,
    confidence: row.confidence,
    policyId: row.policy_id,
    policyEvaluation: json(row.policy_evaluation, {}),
    approvalRequirement: row.approval_requirement,
    executionStatus: row.execution_status,
    verificationStatus: row.verification_status,
    proposalId: row.proposal_id,
    purchaseOrderId: row.purchase_order_id,
    movementIds: json(row.movement_ids, []),
    idempotencyKey: row.idempotency_key,
    outcome: json(row.outcome, {}),
    errorMessage: row.error_message,
    attempts: row.attempts,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    isTerminal: TERMINAL.includes(row.execution_status),
    isAutomatic: row.approval_requirement === 'NONE',
    needsPerson: row.execution_status === STATUS.WAITING_FOR_APPROVAL,
  };
}

/**
 * Records a piece of work, or returns the one that already exists for this
 * situation. Never creates a second.
 */
function upsert(db, workspaceId, input) {
  const key = input.idempotencyKey;
  if (!key) throw new ValidationError('Work needs an idempotency key.');

  const existing = db
    .prepare('SELECT * FROM work_items WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, key);
  if (existing) return { item: hydrate(existing), created: false };

  const id = newId('wi');
  const now = nowIso();
  db.prepare(
    `INSERT INTO work_items (
       id, workspace_id, work_plan_id, trigger_event_id, category, source, source_evidence, affected_entities,
       recommended_action, priority, urgency, confidence, policy_id, policy_evaluation,
       approval_requirement, execution_status, verification_status, purchase_order_id,
       idempotency_key, due_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, workspaceId, input.workPlanId || null, input.triggerEventId || null,
    input.category, input.source || 'autopilot',
    JSON.stringify(input.sourceEvidence || []), JSON.stringify(input.affectedEntities || {}),
    JSON.stringify(input.recommendedAction || {}), Number(input.priority) || 0,
    input.urgency || 'normal', input.confidence || 'medium',
    input.policyId || null, JSON.stringify(input.policyEvaluation || {}),
    input.approvalRequirement || 'REQUIRED',
    input.executionStatus || STATUS.PLANNED,
    input.verificationStatus || 'PENDING',
    input.purchaseOrderId || null, key, input.dueAt || null, now
  );

  recordEvent(db, workspaceId, id, 'planned', {
    category: input.category,
    automatic: input.approvalRequirement === 'NONE',
  });
  return { item: get(db, workspaceId, id), created: true };
}

function get(db, workspaceId, workItemId) {
  const row = db
    .prepare('SELECT * FROM work_items WHERE id = ? AND workspace_id = ?')
    .get(workItemId, workspaceId);
  if (!row) throw new NotFoundError('That piece of work is not in this inventory.');
  return hydrate(row);
}

/**
 * Re-size a piece of work that has not been acted on.
 *
 * Deliberately narrow: only while it is still waiting for a person, and still
 * unapproved — that is, still nothing but a suggestion. It exists because a plan
 * made before a policy existed keeps a quantity no policy can authorise, and
 * idempotency would otherwise pin that number in place for the rest of the day.
 * Anything approved, authorised, running or finished is never touched: changing
 * that would alter what somebody agreed to after they agreed to it.
 */
function resize(db, workspaceId, workItemId, input) {
  const existing = get(db, workspaceId, workItemId);
  if (existing.executionStatus !== STATUS.WAITING_FOR_APPROVAL || existing.approvedAt) return existing;

  db.prepare(
    `UPDATE work_items
        SET recommended_action = ?, policy_evaluation = ?, approval_requirement = ?,
            execution_status = ?, policy_id = ?
      WHERE workspace_id = ? AND id = ?`
  ).run(
    JSON.stringify(input.recommendedAction || {}),
    JSON.stringify(input.policyEvaluation || {}),
    input.approvalRequirement || existing.approvalRequirement,
    input.executionStatus || existing.executionStatus,
    input.policyId === undefined ? existing.policyId : input.policyId,
    workspaceId,
    workItemId
  );
  recordEvent(db, workspaceId, workItemId, 'replanned', {
    from: (existing.recommendedAction || {}).quantity,
    to: (input.recommendedAction || {}).quantity,
    reason: input.reason || 'the rules changed',
  });
  return get(db, workspaceId, workItemId);
}

/**
 * Stores the exact authority decision and measured facts consulted immediately
 * before an automatic action. Policies are immutable, but keeping the version
 * on the work itself makes the audit record self-contained even if a later
 * policy replaces it.
 */
function recordAuthoritySnapshot(db, workspaceId, workItemId, input) {
  get(db, workspaceId, workItemId);
  db.prepare(
    `UPDATE work_items
        SET policy_id = ?, policy_evaluation = ?, source_evidence = ?
      WHERE workspace_id = ? AND id = ?`
  ).run(
    input.policyId || null,
    JSON.stringify(input.policyEvaluation || {}),
    JSON.stringify(input.sourceEvidence || []),
    workspaceId,
    workItemId
  );
  recordEvent(db, workspaceId, workItemId, 'authority_rechecked', {
    policyId: input.policyId || null,
    policyVersion: (input.policyEvaluation || {}).policyVersion || null,
    decision: (input.policyEvaluation || {}).decision || null,
    evidenceCount: (input.sourceEvidence || []).length,
    triggerEventId: input.triggerEventId || null,
  });
  return get(db, workspaceId, workItemId);
}

function find(db, workspaceId, workItemId) {
  const row = db
    .prepare('SELECT * FROM work_items WHERE id = ? AND workspace_id = ?')
    .get(workItemId, workspaceId);
  return row ? hydrate(row) : null;
}

function list(db, workspaceId, { status = null, category = null, limit = 100, since = null } = {}) {
  const clauses = ['workspace_id = ?'];
  const params = [workspaceId];
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    clauses.push(`execution_status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (category) {
    clauses.push('category = ?');
    params.push(category);
  }
  if (since) {
    clauses.push('created_at >= ?');
    params.push(since);
  }
  return db
    .prepare(
      `SELECT * FROM work_items WHERE ${clauses.join(' AND ')} ORDER BY priority DESC, created_at DESC, rowid DESC LIMIT ?`
    )
    .all(...params, limit)
    .map(hydrate);
}

/** Work waiting on a person. */
function awaitingApproval(db, workspaceId) {
  return list(db, workspaceId, { status: STATUS.WAITING_FOR_APPROVAL });
}

/** What Foundry actually completed, for "what did you do today". */
function completedSince(db, workspaceId, since) {
  return db
    .prepare(
      `SELECT * FROM work_items
        WHERE workspace_id = ? AND execution_status = 'COMPLETED' AND completed_at >= ?
        ORDER BY completed_at DESC`
    )
    .all(workspaceId, since)
    .map(hydrate);
}

function transition(db, workspaceId, workItemId, status, extra = {}) {
  const item = get(db, workspaceId, workItemId);
  if (item.isTerminal && status !== item.executionStatus) {
    // Finished work does not change its mind. Anything else would let a retry
    // resurrect an action that was already recorded as done.
    throw new ValidationError(`That work is already ${item.executionStatus.toLowerCase()}.`);
  }

  const now = nowIso();
  db.prepare(
    `UPDATE work_items
        SET execution_status = ?,
            verification_status = COALESCE(?, verification_status),
            proposal_id = COALESCE(?, proposal_id),
            purchase_order_id = COALESCE(?, purchase_order_id),
            movement_ids = COALESCE(?, movement_ids),
            outcome = COALESCE(?, outcome),
            error_message = ?,
            attempts = attempts + ?,
            approved_by_user_id = COALESCE(?, approved_by_user_id),
            approved_at = COALESCE(?, approved_at),
            completed_at = CASE WHEN ? IN ('COMPLETED','FAILED','CANCELLED','SUPERSEDED') THEN ? ELSE completed_at END
      WHERE id = ? AND workspace_id = ?`
  ).run(
    status,
    extra.verificationStatus || null,
    extra.proposalId || null,
    extra.purchaseOrderId || null,
    extra.movementIds ? JSON.stringify(extra.movementIds) : null,
    extra.outcome ? JSON.stringify(extra.outcome) : null,
    extra.errorMessage || null,
    extra.countAttempt ? 1 : 0,
    extra.approvedByUserId || null,
    extra.approvedAt || null,
    status, now,
    workItemId, workspaceId
  );

  recordEvent(db, workspaceId, workItemId, status.toLowerCase(), extra.detail || {}, extra.approvedByUserId);
  return get(db, workspaceId, workItemId);
}

function recordEvent(db, workspaceId, workItemId, event, detail, actorUserId) {
  db.prepare(
    `INSERT INTO work_item_events (id, workspace_id, work_item_id, event, detail, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('wie'), workspaceId, workItemId, event, JSON.stringify(detail || {}), actorUserId || null, nowIso());
}

function eventsFor(db, workspaceId, workItemId) {
  return db
    .prepare(
      `SELECT e.*, u.name AS actor_name FROM work_item_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.workspace_id = ? AND e.work_item_id = ?
        ORDER BY e.created_at, e.rowid`
    )
    .all(workspaceId, workItemId)
    .map((row) => ({
      event: row.event,
      detail: json(row.detail, {}),
      actorName: row.actor_name,
      createdAt: row.created_at,
    }));
}

/**
 * Work left mid-flight by a crash or a restart.
 *
 * Never retried blindly. The caller reconciles each one against the ledger
 * first, because "we do not know whether the transfer happened" is answered by
 * looking at the movements, not by trying again and hoping.
 */
function inFlight(db, workspaceId) {
  return list(db, workspaceId, { status: IN_FLIGHT });
}

module.exports = {
  STATUS,
  TERMINAL,
  IN_FLIGHT,
  CATEGORY_LABEL,
  keyFor,
  hydrate,
  upsert,
  resize,
  recordAuthoritySnapshot,
  get,
  find,
  list,
  awaitingApproval,
  completedSince,
  transition,
  recordEvent,
  eventsFor,
  inFlight,
};
