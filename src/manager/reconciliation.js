'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const investigations = require('./investigations');
const inventoryEngine = require('../domain/inventory-engine');

const json = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

function hydrate(row) {
  return row && {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    status: row.status,
    expectedState: json(row.expected_state, {}),
    observedState: json(row.observed_state, {}),
    checks: json(row.checks, []),
    evidence: json(row.evidence, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function keyFor(kind, referenceType, referenceId, observed) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(observed)).digest('hex').slice(0, 20);
  return `${kind}:${referenceType}:${referenceId}:${digest}`;
}

function record(db, workspaceId, input) {
  const key = input.idempotencyKey || keyFor(input.kind, input.referenceType, input.referenceId, input.observedState);
  const existing = db.prepare(
    'SELECT * FROM reconciliation_records WHERE workspace_id = ? AND idempotency_key = ?'
  ).get(workspaceId, key);
  if (existing) return hydrate(existing);
  const id = newId('rec');
  const now = nowIso();
  db.prepare(
    `INSERT INTO reconciliation_records
       (id, workspace_id, kind, reference_type, reference_id, status, expected_state,
        observed_state, checks, evidence, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, input.kind, input.referenceType, input.referenceId, input.status,
    JSON.stringify(input.expectedState || {}), JSON.stringify(input.observedState || {}),
    JSON.stringify(input.checks || []), JSON.stringify(input.evidence || []), key, now, now);
  return hydrate(db.prepare('SELECT * FROM reconciliation_records WHERE id = ?').get(id));
}

function reconcileWorkItem(db, workspaceId, workItemId) {
  const item = db.prepare('SELECT * FROM work_items WHERE id = ? AND workspace_id = ?').get(workItemId, workspaceId);
  if (!item) return null;
  const expected = { executionStatus: 'COMPLETED', verificationStatus: 'VERIFIED' };
  const observed = {
    executionStatus: item.execution_status,
    verificationStatus: item.verification_status,
    movementIds: json(item.movement_ids, []),
    purchaseOrderId: item.purchase_order_id,
  };
  const complete = item.execution_status === 'COMPLETED';
  const verified = item.verification_status === 'VERIFIED' ||
    (item.category === 'purchase_preparation' && Boolean(item.purchase_order_id));
  const checks = [
    { name: 'Work completed', passed: complete, detail: item.execution_status },
    { name: 'Outcome independently present', passed: verified, detail: item.verification_status },
  ];
  const result = record(db, workspaceId, {
    kind: 'work_item_outcome', referenceType: 'work_item', referenceId: item.id,
    status: complete && verified ? 'VERIFIED' : complete || item.execution_status === 'FAILED' ? 'FAILED' : 'PENDING',
    expectedState: expected, observedState: observed, checks,
    evidence: [{ source: 'work_items', id: item.id }],
  });
  if (result.status === 'FAILED') {
    investigations.create(db, workspaceId, {
      trigger: 'reconciliation_failure', affectedEntities: { workItemId: item.id },
      observedDifference: observed, confidence: 'high',
      recommendedNextStep: 'Review the work evidence before retrying or changing inventory.',
      idempotencyKey: `reconciliation:${result.id}`,
    });
  }
  return result;
}

function reconcilePurchaseOrder(db, workspaceId, purchaseOrderId) {
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND workspace_id = ?').get(purchaseOrderId, workspaceId);
  if (!order) return null;
  const totals = db.prepare(
    `SELECT COALESCE(SUM(quantity_units),0) ordered, COALESCE(SUM(quantity_received_units),0) received
       FROM purchase_order_lines WHERE purchase_order_id = ? AND workspace_id = ?`
  ).get(order.id, workspaceId);
  const expectedStatus = totals.received === 0 ? order.status :
    totals.received >= totals.ordered ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  const passed = order.status === expectedStatus || totals.received === 0;
  const result = record(db, workspaceId, {
    kind: 'purchase_order_state', referenceType: 'purchase_order', referenceId: order.id,
    status: passed ? 'VERIFIED' : 'FAILED',
    expectedState: { status: expectedStatus, orderedUnits: totals.ordered },
    observedState: { status: order.status, receivedUnits: totals.received },
    checks: [{ name: 'Order status matches recorded receipts', passed, detail: `${totals.received}/${totals.ordered} units` }],
    evidence: [{ source: 'purchase_order_lines', purchaseOrderId: order.id }],
  });
  if (!passed) investigations.create(db, workspaceId, {
    trigger: 'purchase_reconciliation_failure', affectedEntities: { purchaseOrderId: order.id },
    observedDifference: { expectedStatus, observedStatus: order.status }, confidence: 'high',
    recommendedNextStep: 'Review this order and its receipts before recording another delivery.',
    idempotencyKey: `reconciliation:${result.id}`,
  });
  return result;
}

function reconcileInventoryIntegrity(db, workspaceId) {
  const audit = inventoryEngine.verifyIntegrity(db, workspaceId);
  const result = record(db, workspaceId, {
    kind: 'inventory_integrity', referenceType: 'workspace', referenceId: workspaceId,
    status: audit.ok ? 'VERIFIED' : 'FAILED', expectedState: { integrity: 'valid' },
    observedState: { integrity: audit.ok ? 'valid' : 'invalid', problems: audit.problems },
    checks: [{ name: 'Ledger, balances, lots and serial units agree', passed: audit.ok,
      detail: audit.ok ? 'All inventory invariants passed.' : `${audit.problems.length} invariant(s) failed.` }],
    evidence: audit.problems,
  });
  if (!audit.ok) investigations.create(db, workspaceId, {
    trigger: 'inventory_integrity_failure', affectedEntities: { workspaceId },
    observedDifference: { problems: audit.problems }, confidence: 'high',
    recommendedNextStep: 'Stop inventory mutations and review the ledger integrity evidence before continuing.',
    idempotencyKey: `reconciliation:${result.id}`,
  });
  return result;
}

function reconcileFailedImports(db, workspaceId) {
  const rows = db.prepare(`SELECT iv.id, iv.import_id, iv.execution_id, iv.problems, iv.observed
    FROM import_verifications iv WHERE iv.workspace_id = ? AND iv.verified = 0
    ORDER BY iv.created_at DESC LIMIT 25`).all(workspaceId);
  return rows.map((row) => {
    const problems = json(row.problems, []);
    const observed = json(row.observed, {});
    const result = record(db, workspaceId, {
      kind: 'import_verification', referenceType: 'import', referenceId: row.import_id,
      status: 'FAILED', expectedState: { verified: true }, observedState: observed,
      checks: [{ name: 'Imported inventory matches the approved source', passed: false,
        detail: `${problems.length} verification problem(s).` }],
      evidence: problems,
    });
    investigations.create(db, workspaceId, {
      trigger: 'import_reconciliation_failure', affectedEntities: { importId: row.import_id, executionId: row.execution_id },
      observedDifference: { problems, observed }, confidence: 'high',
      recommendedNextStep: 'Review the source totals and failed import rows before relying on this migration.',
      idempotencyKey: `reconciliation:${result.id}`,
    });
    return result;
  });
}

function reconcileUnifiedBusinessState(db, workspaceId) {
  const state = require('./business-brain').build(db, workspaceId);
  return state.consistency
    .filter((check) => check.key !== 'inventory-ledger')
    .map((check) => {
      const result = record(db, workspaceId, {
        kind: `business_${check.key}`,
        referenceType: 'workspace', referenceId: workspaceId,
        status: check.passed ? (check.complete === false ? 'PENDING' : 'VERIFIED') : 'FAILED',
        expectedState: { consistent: true },
        observedState: { consistent: check.passed, complete: check.complete !== false,
          detail: check.detail, evidence: check.evidence },
        checks: [{ name: check.title, passed: check.passed, detail: check.detail }],
        evidence: Array.isArray(check.evidence) ? check.evidence : [check.evidence],
      });
      if (!check.passed && check.needsOwner !== false) investigations.create(db, workspaceId, {
        trigger: `business_consistency_${check.key}`,
        affectedEntities: { workspaceId, consistencyKey: check.key },
        observedDifference: { detail: check.detail, evidence: check.evidence },
        confidence: 'high',
        recommendedNextStep: `Review ${check.title.toLowerCase()} before making another related change.`,
        idempotencyKey: `reconciliation:${result.id}`,
      });
      else investigations.resolveByTrigger(db, workspaceId, `business_consistency_${check.key}`,
        check.complete === false
          ? 'Foundry reclassified this as missing financial evidence, not a contradiction in the business records.'
          : 'The related records now agree.');
      return result;
    });
}

function scanWorkspace(db, workspaceId) {
  const records = [reconcileInventoryIntegrity(db, workspaceId)];
  const items = db.prepare(
    `SELECT id FROM work_items WHERE workspace_id = ?
      AND category IN ('balance_transfer','purchase_preparation','purchase_approval')
      AND execution_status IN ('COMPLETED','FAILED') ORDER BY completed_at DESC LIMIT 100`
  ).all(workspaceId);
  for (const item of items) records.push(reconcileWorkItem(db, workspaceId, item.id));
  const orders = db.prepare(
    `SELECT id FROM purchase_orders WHERE workspace_id = ?
      AND status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') ORDER BY updated_at DESC LIMIT 100`
  ).all(workspaceId);
  for (const order of orders) records.push(reconcilePurchaseOrder(db, workspaceId, order.id));
  records.push(...reconcileFailedImports(db, workspaceId));
  records.push(...reconcileUnifiedBusinessState(db, workspaceId));
  return { checked: records.length, failed: records.filter((entry) => entry && entry.status === 'FAILED').length, records };
}

function list(db, workspaceId, { status = null, limit = 100 } = {}) {
  const clause = status ? ' AND status = ?' : '';
  const params = status ? [workspaceId, status, limit] : [workspaceId, limit];
  return db.prepare(`SELECT * FROM reconciliation_records WHERE workspace_id = ?${clause} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params).map(hydrate);
}

module.exports = { hydrate, keyFor, record, reconcileWorkItem, reconcilePurchaseOrder,
  reconcileInventoryIntegrity, reconcileFailedImports, reconcileUnifiedBusinessState,
  scanWorkspace, list };
