'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const workItems = require('../autopilot/work-items');
const readiness = require('./readiness');
const exceptionInbox = require('./needs-you-inbox');

function build(db, workspaceId, { now = Date.now() } = {}) {
  const since = new Date(now); since.setHours(0, 0, 0, 0);
  const handled = workItems.completedSince(db, workspaceId, since.toISOString()).map((item) => ({
    type: 'work', id: item.id, title: item.categoryLabel, outcome: item.outcome,
    completedAt: item.completedAt, verified: item.verificationStatus === 'VERIFIED',
  }));
  handled.push(...db.prepare(`SELECT d.id, d.document_type, d.purchase_order_id, d.processed_at,
      po.po_number, s.name AS supplier_name
    FROM supplier_documents d LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    LEFT JOIN suppliers s ON s.id = d.supplier_id
    WHERE d.workspace_id = ? AND d.status = 'MATCHED' AND d.processed_at >= ?
      AND json_array_length(d.discrepancies) = 0
    ORDER BY d.processed_at DESC`).all(workspaceId, since.toISOString()).map((row) => ({
      type: 'supplier', id: row.id,
      title: `${row.supplier_name || 'Supplier'} ${String(row.document_type).replaceAll('_', ' ')} matched${row.po_number ? ` ${row.po_number}` : ''}`,
      outcome: { purchaseOrderId: row.purchase_order_id, noActionNeeded: true },
      completedAt: row.processed_at, verified: true,
    })));
  const handlingCount = db.prepare(`SELECT COUNT(*) AS count FROM work_items WHERE workspace_id = ?
    AND execution_status IN ('DETECTED','PLANNED','AUTHORIZED','EXECUTING','VERIFYING')`).get(workspaceId).count;
  const handling = workItems.list(db, workspaceId, {
    status: [workItems.STATUS.DETECTED, workItems.STATUS.PLANNED, workItems.STATUS.AUTHORIZED,
      workItems.STATUS.EXECUTING, workItems.STATUS.VERIFYING], limit: handlingCount,
  }).map((item) => ({ type: 'work', id: item.id, title: item.categoryLabel, status: item.executionStatus }));
  const exceptions = exceptionInbox.inbox(db, workspaceId);
  const needsYou = [
    ...readiness.decisions(db, workspaceId).map((item) => ({
      type: item.kind, id: item.id, title: item.title, reason: item.because,
    })),
    ...exceptions.map((item) => ({
      type: item.kind, id: item.id, title: item.title, reason: item.why,
      recommendation: item.recommendation, missing: item.missing, href: item.href,
    })),
  ];
  const nextEvents = db.prepare(
    `SELECT id, po_number, expected_date, status FROM purchase_orders
      WHERE workspace_id = ? AND status IN ('ORDERED','PARTIALLY_RECEIVED') AND expected_date IS NOT NULL
      ORDER BY expected_date`
  ).all(workspaceId).map((po) => ({ type: 'delivery', id: po.id, title: `${po.po_number} expected`, at: po.expected_date,
    overdue: po.expected_date < new Date(now).toISOString().slice(0, 10) }));
  const coverageErrors = exceptions.coverageErrors || [];
  const summary = coverageErrors.length
    ? `Operations review is incomplete: ${coverageErrors.length} exception source${coverageErrors.length === 1 ? '' : 's'} could not be checked. ${needsYou.length} known decision${needsYou.length === 1 ? '' : 's'} need attention; StockChief is handling ${handling.length}.`
    : needsYou.length
    ? `${needsYou.length} item${needsYou.length === 1 ? ' needs' : 's need'} your decision. StockChief is handling ${handling.length}.`
    : handling.length
      ? `Nothing needs you right now. StockChief is handling ${handling.length} item${handling.length === 1 ? '' : 's'}.`
      : 'Everything StockChief can verify is in order. Nothing needs you right now.';
  const payload = { handled, handling, needsYou, nextEvents, summary, coverageErrors,
    counts: { handled: handled.length, handling: handling.length, needsYou: needsYou.length, nextEvents: nextEvents.length } };
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const date = new Date(now).toISOString().slice(0, 10);
  const stamp = nowIso();
  db.prepare(
    `INSERT INTO manager_briefs (id, workspace_id, brief_date, handled, handling, needs_you, next_events,
       summary, evidence_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, brief_date) DO UPDATE SET handled=excluded.handled, handling=excluded.handling,
       needs_you=excluded.needs_you, next_events=excluded.next_events, summary=excluded.summary,
       evidence_hash=excluded.evidence_hash, updated_at=excluded.updated_at`
  ).run(newId('brf'), workspaceId, date, JSON.stringify(handled), JSON.stringify(handling), JSON.stringify(needsYou),
    JSON.stringify(nextEvents), summary, hash, stamp, stamp);
  return payload;
}

module.exports = { build };
