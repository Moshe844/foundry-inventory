'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const workItems = require('../autopilot/work-items');
const investigations = require('./investigations');
const readiness = require('./readiness');

function build(db, workspaceId, { now = Date.now() } = {}) {
  const since = new Date(now); since.setHours(0, 0, 0, 0);
  const handled = workItems.completedSince(db, workspaceId, since.toISOString()).slice(0, 20).map((item) => ({
    type: 'work', id: item.id, title: item.categoryLabel, outcome: item.outcome,
    completedAt: item.completedAt, verified: item.verificationStatus === 'VERIFIED',
  }));
  const handling = workItems.list(db, workspaceId, {
    status: [workItems.STATUS.DETECTED, workItems.STATUS.PLANNED, workItems.STATUS.AUTHORIZED,
      workItems.STATUS.EXECUTING, workItems.STATUS.VERIFYING], limit: 20,
  }).map((item) => ({ type: 'work', id: item.id, title: item.categoryLabel, status: item.executionStatus }));
  const needsYou = [
    ...readiness.decisions(db, workspaceId).map((item) => ({
      type: item.kind, id: item.id, title: item.title, reason: item.because,
    })),
    ...workItems.awaitingApproval(db, workspaceId).map((item) => ({
      type: 'work', id: item.id, title: item.categoryLabel, reason: item.policyEvaluation.reason || 'Your approval is required.',
    })),
    ...investigations.list(db, workspaceId, { statuses: ['NEEDS_HUMAN', 'INCONCLUSIVE'], limit: 20 }).map((item) => ({
      type: 'investigation', id: item.investigationId, title: 'Inventory discrepancy', reason: item.recommendedNextStep,
    })),
    ...db.prepare(`SELECT id, event_type, stated_as FROM physical_events WHERE workspace_id = ?
      AND status = 'NEEDS_HUMAN' AND investigation_id IS NULL
      ORDER BY created_at DESC LIMIT 20`).all(workspaceId).map((item) => ({
      type: 'physical_event', id: item.id, title: item.event_type.replaceAll('_', ' '), reason: item.stated_as,
    })),
  ];
  const nextEvents = db.prepare(
    `SELECT id, po_number, expected_date, status FROM purchase_orders
      WHERE workspace_id = ? AND status IN ('ORDERED','PARTIALLY_RECEIVED') AND expected_date IS NOT NULL
      ORDER BY expected_date LIMIT 12`
  ).all(workspaceId).map((po) => ({ type: 'delivery', id: po.id, title: `${po.po_number} expected`, at: po.expected_date }));
  const summary = needsYou.length
    ? `${needsYou.length} item${needsYou.length === 1 ? ' needs' : 's need'} your decision. Foundry is handling ${handling.length}.`
    : handling.length
      ? `Nothing needs you right now. Foundry is handling ${handling.length} item${handling.length === 1 ? '' : 's'}.`
      : 'Everything Foundry can verify is in order. Nothing needs you right now.';
  const payload = { handled, handling, needsYou, nextEvents, summary };
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
