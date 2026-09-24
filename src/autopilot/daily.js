'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const permissions = require('../actions/permissions');
const { ValidationError } = require('../domain/errors');
const work = require('./work-items');
const runner = require('./runner');

function snapshot(item, db) {
  const orderId = item.purchaseOrderId || item.recommendedAction.purchaseOrderId;
  const orderHash = db && orderId ? require('../purchasing/po-service').get(db, item.workspaceId, orderId) : null;
  const proposalHash = db && item.proposalId ? require('../actions/proposal-service').get(db, item.workspaceId, item.proposalId) : null;
  if (db && item.proposalId && !proposalHash) throw new ValidationError('The referenced proposal is missing. Review this decision individually; it cannot be batch approved.');
  return crypto.createHash('sha256').update(JSON.stringify({ id: item.id, workspaceId: item.workspaceId,
    executionStatus: item.executionStatus, recommendedAction: item.recommendedAction,
    sourceEvidence: item.sourceEvidence, affectedEntities: item.affectedEntities,
    policyEvaluation: item.policyEvaluation, purchaseOrderId: item.purchaseOrderId, proposalId: item.proposalId, orderHash, proposalHash })).digest('hex');
}

function report(db, workspaceId, date = new Date().toISOString().slice(0, 10)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new ValidationError('Choose a valid calendar date.');
  const from = `${date}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86400000).toISOString();
  const completed = db.prepare(`SELECT id FROM work_items WHERE workspace_id = ? AND execution_status = 'COMPLETED'
    AND verification_status = 'VERIFIED' AND completed_at >= ? AND completed_at < ? ORDER BY completed_at, id`)
    .all(workspaceId, from, to).map((row) => work.get(db, workspaceId, row.id));
  const waiting = db.prepare(`SELECT id FROM work_items WHERE workspace_id = ? AND execution_status = 'WAITING_FOR_APPROVAL'
    ORDER BY priority DESC, created_at, id`).all(workspaceId).map((row) => work.get(db, workspaceId, row.id));
  const unfinished = db.prepare(`SELECT id FROM work_items WHERE workspace_id = ?
    AND (execution_status IN ('AUTHORIZED','EXECUTING','VERIFYING','FAILED','BLOCKED','NEEDS_REVIEW')
      OR (execution_status = 'COMPLETED' AND verification_status IS NOT 'VERIFIED')) ORDER BY created_at, id`)
    .all(workspaceId).map((row) => work.get(db, workspaceId, row.id));
  const providerOperations = db.prepare(`SELECT id, title, status, phase, link, completed_at, verification
    FROM autonomous_operations WHERE workspace_id = ? AND
      ((completed_at >= ? AND completed_at < ?) OR status NOT IN ('COMPLETED','CANCELLED')) ORDER BY created_at, id`)
    .all(workspaceId, from, to);
  const communications = db.prepare(`SELECT subject, recipient, status, external_message_id FROM supplier_communications
    WHERE workspace_id = ? AND (status NOT IN ('SENT','CANCELLED') OR (sent_at >= ? AND sent_at < ?)) ORDER BY created_at, id`)
    .all(workspaceId, from, to);
  const suggestions = require('../manager/operating-instructions').list(db, workspaceId, { status: 'PENDING' })
    .filter((proposal) => proposal.source === 'repeated_approval_suggestion');
  return { date, completed, waiting: waiting.map((item) => {
    try {
      return { ...item, approvalHash: snapshot(item, db),
        order: item.purchaseOrderId ? require('../purchasing/po-service').get(db, workspaceId, item.purchaseOrderId) : null };
    } catch (error) {
      if (!['not_found', 'validation_error'].includes(error.code)) throw error;
      return { ...item, approvalHash: null, order: null, approvalBlockedReason: 'A required business record is missing or invalid. Review this decision individually; batch approval is disabled.' };
    }
  }),
    unfinished, providerOperations, communications, suggestions };
}

function approveBatch(db, ctx, membership, selections) {
  permissions.assertCan(membership, permissions.ADMIN, 'approve the selected daily work');
  if (!Array.isArray(selections) || !selections.length || selections.length > 25
      || new Set(selections.map((entry) => entry.id)).size !== selections.length) throw new ValidationError('Select between one and 25 distinct decisions.');
  inTransaction(db, () => {
    for (const selection of selections) {
      const item = work.get(db, ctx.workspaceId, selection.id);
      if (item.executionStatus !== 'WAITING_FOR_APPROVAL' || snapshot(item, db) !== selection.hash) {
        throw new ValidationError('A selected decision changed. Nothing in this batch was approved. Refresh and review the current work.');
      }
    }
    for (const selection of selections) runner.approveWorkItem(db, ctx, membership, selection.id);
  });
  return selections.map((selection) => {
    try {
      const result = runner.executeWorkItem(db, ctx, membership, selection.id);
      const item = work.get(db, ctx.workspaceId, selection.id);
      return { id: item.id, done: item.executionStatus === 'COMPLETED' && item.verificationStatus === 'VERIFIED',
        status: item.executionStatus, reason: result.because || result.error || item.errorMessage || null };
    } catch (error) {
      return { id: selection.id, done: false, status: work.get(db, ctx.workspaceId, selection.id).executionStatus,
        reason: error.status && error.status < 500 ? error.message : 'Execution failed. Review this decision; it has not been reported as completed.' };
    }
  });
}

function generate(db, workspaceId, { now = Date.now() } = {}) {
  const date = new Date(now - 86400000).toISOString().slice(0, 10);
  const from = `${date}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86400000).toISOString();
  return inTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM workspace_daily_digests WHERE workspace_id = ? AND report_date = ?').get(workspaceId, date);
    if (existing) return { created: false, ...existing };
    const completed = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN verification_status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified
      FROM work_items WHERE workspace_id = ? AND execution_status = 'COMPLETED' AND completed_at >= ? AND completed_at < ?`)
      .get(workspaceId, from, to);
    const pending = db.prepare(`SELECT COUNT(*) AS total FROM work_items WHERE workspace_id = ?
      AND execution_status NOT IN ('COMPLETED','CANCELLED','SUPERSEDED')`).get(workspaceId);
    const waiting = db.prepare(`SELECT COUNT(*) AS total FROM work_items WHERE workspace_id = ?
      AND execution_status = 'WAITING_FOR_APPROVAL'`).get(workspaceId);
    const provider = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN json_extract(verification, '$.passed') = 1 THEN 1 ELSE 0 END) AS verified
      FROM autonomous_operations WHERE workspace_id = ? AND status = 'COMPLETED' AND completed_at >= ? AND completed_at < ?`)
      .get(workspaceId, from, to);
    const summary = { verifiedWork: Number(completed.verified || 0), unverifiedWork: completed.total - Number(completed.verified || 0),
      waiting: waiting.total, unfinished: pending.total, verifiedProviderOperations: Number(provider.verified || 0),
      unverifiedProviderOperations: provider.total - Number(provider.verified || 0) };
    const generatedAt = new Date(now).toISOString();
    db.prepare('INSERT INTO workspace_daily_digests(workspace_id, report_date, generated_at, summary) VALUES (?, ?, ?, ?)')
      .run(workspaceId, date, generatedAt, JSON.stringify(summary));
    return { created: true, workspace_id: workspaceId, report_date: date, generated_at: generatedAt, summary: JSON.stringify(summary) };
  });
}

function history(db, workspaceId) {
  return db.prepare('SELECT * FROM workspace_daily_digests WHERE workspace_id = ? ORDER BY report_date DESC LIMIT 14')
    .all(workspaceId).map((row) => ({ ...row, summary: JSON.parse(row.summary) }));
}

module.exports = { snapshot, report, approveBatch, generate, history };
