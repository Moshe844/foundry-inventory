'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const { NotFoundError, ValidationError } = require('../domain/errors');
const repo = require('../domain/repository');

const STATUS = {
  OPEN: 'OPEN',
  INVESTIGATING: 'INVESTIGATING',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  RESOLVED: 'RESOLVED',
  INCONCLUSIVE: 'INCONCLUSIVE',
};

const json = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

function hydrate(row) {
  if (!row) return null;
  return {
    investigationId: row.id,
    workspaceId: row.workspace_id,
    trigger: row.trigger,
    affectedEntities: json(row.affected_entities, {}),
    observedDifference: json(row.observed_difference, {}),
    evidenceReviewed: json(row.evidence_reviewed, []),
    hypotheses: json(row.hypotheses, []),
    evidenceFor: json(row.evidence_for, []),
    evidenceAgainst: json(row.evidence_against, []),
    explainedAmount: row.explained_amount,
    unexplainedAmount: row.unexplained_amount,
    confidence: row.confidence,
    recommendedNextStep: row.recommended_next_step,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function keyFor(trigger, entities, observed) {
  return `${trigger}:${crypto.createHash('sha256').update(JSON.stringify({ entities, observed })).digest('hex').slice(0, 24)}`;
}

function recordEvent(db, workspaceId, investigationId, event, detail = {}, actorUserId = null) {
  db.prepare(
    `INSERT INTO investigation_events
       (id, workspace_id, investigation_id, event, detail, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('ive'), workspaceId, investigationId, event, JSON.stringify(detail), actorUserId, nowIso());
}

function create(db, workspaceId, input) {
  const entities = input.affectedEntities || {};
  const observed = input.observedDifference || {};
  const key = input.idempotencyKey || keyFor(input.trigger, entities, observed);
  const existing = db
    .prepare('SELECT * FROM inventory_investigations WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, key);
  if (existing) return { investigation: hydrate(existing), created: false };

  const id = newId('inv');
  const now = nowIso();
  db.prepare(
    `INSERT INTO inventory_investigations
       (id, workspace_id, trigger, affected_entities, observed_difference, confidence,
        recommended_next_step, status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`
  ).run(
    id, workspaceId, input.trigger, JSON.stringify(entities), JSON.stringify(observed),
    input.confidence || 'low', input.recommendedNextStep || null, key, now, now
  );
  recordEvent(db, workspaceId, id, 'opened', { trigger: input.trigger }, input.actorUserId);
  return { investigation: get(db, workspaceId, id), created: true };
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM inventory_investigations WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new NotFoundError('That investigation is not in this inventory.');
  return hydrate(row);
}

function list(db, workspaceId, { statuses = null, limit = 50 } = {}) {
  const wanted = statuses ? (Array.isArray(statuses) ? statuses : [statuses]) : null;
  const clause = wanted ? ` AND status IN (${wanted.map(() => '?').join(',')})` : '';
  return db
    .prepare(`SELECT * FROM inventory_investigations WHERE workspace_id = ?${clause} ORDER BY updated_at DESC LIMIT ?`)
    .all(workspaceId, ...(wanted || []), limit)
    .map(hydrate);
}

function events(db, workspaceId, id) {
  get(db, workspaceId, id);
  return db.prepare(
    `SELECT e.*, u.name AS actor_name FROM investigation_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.workspace_id = ? AND e.investigation_id = ? ORDER BY e.created_at, e.rowid`
  ).all(workspaceId, id).map((row) => ({
    event: row.event,
    detail: json(row.detail, {}),
    actorName: row.actor_name,
    createdAt: row.created_at,
  }));
}

function openPhysicalCount(db, ctx, input) {
  const sku = repo.requireSku(db, ctx.workspaceId, input.skuId);
  const location = repo.requireLocation(db, ctx.workspaceId, input.locationId);
  const expected = repo.getBalance(db, ctx.workspaceId, sku.id, location.id);
  const observed = Number(input.countedQuantity);
  if (!Number.isInteger(observed) || observed < 0) throw new ValidationError('A physical count must be a whole number of units.');
  const difference = observed - expected;
  const entities = { skuId: sku.id, itemId: sku.item_id, locationId: location.id, displayName: input.displayName || sku.code };

  if (difference === 0) {
    return create(db, ctx.workspaceId, {
      trigger: 'physical_count',
      affectedEntities: entities,
      observedDifference: { expected, observed, difference: 0 },
      confidence: 'high',
      recommendedNextStep: 'No correction is needed.',
      actorUserId: ctx.actorId,
      idempotencyKey: input.idempotencyKey || keyFor('physical_count_match', entities, { expected, observed }),
    });
  }

  return create(db, ctx.workspaceId, {
    trigger: 'physical_count_discrepancy',
    affectedEntities: entities,
    observedDifference: { expected, observed, difference },
    confidence: 'low',
    recommendedNextStep: `Recount ${entities.displayName || 'this item'} at ${location.name}.`,
    actorUserId: ctx.actorId,
    idempotencyKey: input.idempotencyKey || keyFor('physical_count_discrepancy', entities, { expected, observed }),
  });
}

/** Evidence-backed, deterministic investigation. No model authors hypotheses. */
function investigate(db, workspaceId, id) {
  const investigation = get(db, workspaceId, id);
  if ([STATUS.RESOLVED].includes(investigation.status)) return investigation;
  const entities = investigation.affectedEntities;
  const rawDifference = investigation.observedDifference.difference;
  const hasMeasuredDifference = rawDifference !== undefined && rawDifference !== null && Number.isFinite(Number(rawDifference));
  const difference = hasMeasuredDifference ? Number(rawDifference) : null;
  const now = nowIso();

  db.prepare("UPDATE inventory_investigations SET status = 'INVESTIGATING', updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(now, id, workspaceId);
  recordEvent(db, workspaceId, id, 'investigating', { difference });

  const movements = entities.skuId
    ? db.prepare(
        `SELECT m.id, m.group_id, m.operation, m.quantity_delta, m.balance_after, m.reason_code,
                m.notes, m.reference, m.occurred_at, l.name AS location_name, u.name AS actor_name
           FROM movements m JOIN locations l ON l.id = m.location_id
           LEFT JOIN users u ON u.id = m.actor_user_id
          WHERE m.workspace_id = ? AND m.sku_id = ?
            AND (? IS NULL OR m.location_id = ?)
          ORDER BY m.occurred_at DESC, m.seq DESC LIMIT 80`
      ).all(workspaceId, entities.skuId, entities.locationId || null, entities.locationId || null)
    : [];
  const adjustments = entities.skuId
    ? db.prepare(
        `SELECT a.*, u.name AS actor_name FROM adjustments a
           LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE a.workspace_id = ? AND a.sku_id = ?
            AND (? IS NULL OR a.location_id = ?)
          ORDER BY a.created_at DESC LIMIT 25`
      ).all(workspaceId, entities.skuId, entities.locationId || null, entities.locationId || null)
    : [];

  const evidenceReviewed = [
    { source: 'movement_ledger', records: movements.length, immutable: true },
    { source: 'physical_adjustments', records: adjustments.length },
    { source: 'action_executions', records: entities.skuId ? db.prepare(
        `SELECT COUNT(*) AS n FROM action_executions ae
          JOIN action_proposals ap ON ap.id = ae.proposal_id
         WHERE ae.workspace_id = ? AND ap.sku_id = ?`
      ).get(workspaceId, entities.skuId).n : 0 },
    { source: 'purchase_order_receipts', records: entities.skuId ? db.prepare(
        `SELECT COUNT(*) AS n FROM purchase_order_receipt_lines
          WHERE workspace_id = ? AND sku_id = ?`
      ).get(workspaceId, entities.skuId).n : 0 },
    { source: 'import_verifications', failed: db.prepare(
        `SELECT COUNT(*) AS n FROM import_verifications WHERE workspace_id = ? AND verified = 0`
      ).get(workspaceId).n },
  ];

  if (!entities.skuId || !hasMeasuredDifference) {
    const next = investigation.recommendedNextStep ||
      'Name the product, location and physical count so Foundry can compare it with the ledger.';
    db.prepare(
      `UPDATE inventory_investigations
          SET evidence_reviewed = ?, hypotheses = '[]', evidence_for = '[]', evidence_against = '[]',
              explained_amount = NULL, unexplained_amount = NULL, confidence = 'low',
              recommended_next_step = ?, status = 'INCONCLUSIVE', updated_at = ?
        WHERE id = ? AND workspace_id = ?`
    ).run(JSON.stringify(evidenceReviewed), next, nowIso(), id, workspaceId);
    recordEvent(db, workspaceId, id, 'inconclusive', { reason: 'A measured product, location and count were not all available.' });
    return get(db, workspaceId, id);
  }

  if (difference === 0) {
    db.prepare(
      `UPDATE inventory_investigations
          SET evidence_reviewed = ?, hypotheses = '[]', evidence_for = '[]', evidence_against = '[]',
              explained_amount = 0, unexplained_amount = 0, confidence = 'high',
              recommended_next_step = 'No correction is needed.', status = 'RESOLVED', resolved_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`
    ).run(JSON.stringify(evidenceReviewed), nowIso(), nowIso(), id, workspaceId);
    recordEvent(db, workspaceId, id, 'resolved_by_reconciliation', { expected: investigation.observedDifference.expected, observed: investigation.observedDifference.observed });
    return get(db, workspaceId, id);
  }

  const target = Math.abs(difference);
  let explained = 0;
  const evidenceFor = [];
  const hypotheses = [];
  const evidenceAgainst = [];

  // Two separately recorded movements with the same non-empty external
  // reference, operation, quantity and location are concrete duplicate
  // evidence.  Foundry still calls this a likely explanation, never a cause.
  const duplicateIds = new Set();
  for (let a = 0; a < movements.length; a += 1) {
    const first = movements[a];
    if (!first.reference || first.group_id === null || Math.sign(first.quantity_delta) !== -Math.sign(difference)) continue;
    for (let b = a + 1; b < movements.length; b += 1) {
      const second = movements[b];
      if (first.group_id === second.group_id || duplicateIds.has(second.id)) continue;
      const closeInTime = Math.abs(Date.parse(first.occurred_at) - Date.parse(second.occurred_at)) <= 10 * 60 * 1000;
      if (closeInTime && first.operation === second.operation && first.quantity_delta === second.quantity_delta &&
          first.location_name === second.location_name && first.reference === second.reference) {
        const amount = Math.min(Math.abs(second.quantity_delta), target - explained);
        if (amount > 0) {
          duplicateIds.add(second.id);
          explained += amount;
          evidenceFor.push({ kind: 'possible_duplicate_movement', amount, operation: second.operation,
            reference: second.reference, location: second.location_name, firstAt: first.occurred_at,
            repeatedAt: second.occurred_at, actor: second.actor_name });
        }
      }
    }
  }
  if (duplicateIds.size) {
    hypotheses.push({
      statement: `${explained} units line up with separately recorded movements carrying the same external reference, quantity and location.`,
      confidence: explained === target ? 'medium' : 'low',
      evidence: evidenceFor.filter((entry) => entry.kind === 'possible_duplicate_movement'),
    });
  } else {
    evidenceAgainst.push({ kind: 'duplicate_check', statement: 'No repeated referenced movement matched the discrepancy.' });
  }

  // A recent counted correction with the same direction is a concrete lead.
  // It is never called the cause: it is a recorded event that can account for
  // some quantity and is shown with who/when/reason for a person to verify.
  for (const adjustment of adjustments) {
    const delta = adjustment.counted_qty - adjustment.expected_qty;
    if (!delta || Math.sign(delta) !== Math.sign(difference)) continue;
    const amount = Math.min(Math.abs(delta), target - explained);
    if (amount <= 0) break;
    explained += amount;
    evidenceFor.push({
      kind: 'adjustment',
      amount,
      expected: adjustment.expected_qty,
      counted: adjustment.counted_qty,
      reason: adjustment.reason_code,
      actor: adjustment.actor_name,
      at: adjustment.created_at,
    });
  }
  const adjustmentEvidence = evidenceFor.filter((entry) => entry.kind === 'adjustment');
  if (adjustmentEvidence.length) {
    hypotheses.push({
      statement: `${adjustmentEvidence.reduce((sum, entry) => sum + entry.amount, 0)} units may relate to recorded counted corrections in the same direction.`,
      confidence: explained === target ? 'medium' : 'low',
      evidence: adjustmentEvidence.map((entry) => ({ kind: entry.kind, amount: entry.amount, at: entry.at })),
    });
  }

  const unexplained = Math.max(0, target - explained);
  const status = STATUS.NEEDS_HUMAN;
  const confidence = explained === target && target > 0 ? 'medium' : explained > 0 ? 'low' : 'low';
  const location = entities.locationId
    ? db.prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?').get(entities.locationId, workspaceId)
    : null;
  const next = unexplained > 0
    ? `Recount ${entities.displayName || 'this item'}${location ? ` at ${location.name}` : ''}. Do not adjust the ledger until the remaining ${unexplained} units are explained or confirmed.`
    : 'Review the recorded evidence, then confirm whether the physical count should become the new ledger balance.';

  db.prepare(
    `UPDATE inventory_investigations
        SET evidence_reviewed = ?, hypotheses = ?, evidence_for = ?, evidence_against = ?,
            explained_amount = ?, unexplained_amount = ?, confidence = ?,
            recommended_next_step = ?, status = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`
  ).run(
    JSON.stringify(evidenceReviewed), JSON.stringify(hypotheses), JSON.stringify(evidenceFor),
    JSON.stringify(evidenceAgainst), explained, unexplained, confidence, next, status, nowIso(), id, workspaceId
  );
  recordEvent(db, workspaceId, id, 'evidence_reviewed', { explained, unexplained, confidence });
  return get(db, workspaceId, id);
}

function resolve(db, ctx, id, note) {
  const investigation = get(db, ctx.workspaceId, id);
  const resolvedAt = nowIso();
  let completedPhysicalEvents = 0;
  db.transaction(() => {
    db.prepare(
      "UPDATE inventory_investigations SET status = 'RESOLVED', resolved_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?"
    ).run(resolvedAt, resolvedAt, id, ctx.workspaceId);

    // A physical event and the investigation it opened are one exception, not
    // two independent jobs. Once the investigation is resolved, leaving the
    // source event in NEEDS_HUMAN makes Needs you ask for detail it already has.
    completedPhysicalEvents = db.prepare(
      `UPDATE physical_events
          SET status = 'COMPLETED', updated_at = ?
        WHERE workspace_id = ? AND investigation_id = ? AND status = 'NEEDS_HUMAN'`
    ).run(resolvedAt, ctx.workspaceId, id).changes;

    recordEvent(db, ctx.workspaceId, id, 'resolved', {
      note: note || null,
      completedPhysicalEvents,
    }, ctx.actorId);
  })();
  return {
    before: investigation,
    investigation: get(db, ctx.workspaceId, id),
    completedPhysicalEvents,
  };
}

function recover(db, workspaceId) {
  return db.prepare(
    "UPDATE inventory_investigations SET status = 'OPEN', updated_at = ? WHERE workspace_id = ? AND status = 'INVESTIGATING'"
  ).run(nowIso(), workspaceId).changes;
}

module.exports = { STATUS, hydrate, keyFor, create, get, list, events, openPhysicalCount, investigate, resolve, recover };
