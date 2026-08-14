'use strict';

/**
 * What a person does with an attention item.
 *
 * Acknowledging, dismissing and snoozing change how an item is *presented* —
 * never what the ledger says, and never the detection rules. Feedback is
 * recorded as evidence about the rules' usefulness; it is deliberately not
 * applied as a silent threshold change, because a briefing that quietly
 * re-tunes itself is one nobody can reason about.
 */

const { inTransaction } = require('../db');
const { SNOOZE_DAYS } = require('./policy');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');

const VERDICTS = ['useful', 'not_useful', 'dismissed', 'acknowledged', 'snoozed'];
const DAY = 24 * 60 * 60 * 1000;

function load(db, workspaceId, attentionId) {
  const row = db.prepare('SELECT * FROM attention_items WHERE id = ? AND workspace_id = ?').get(attentionId, workspaceId);
  if (!row) throw new NotFoundError('That attention item could not be found.');
  return row;
}

function record(db, workspaceId, attentionId, verdict, { note = null, actorUserId = null } = {}) {
  if (!VERDICTS.includes(verdict)) throw new ValidationError(`Unknown feedback: ${verdict}`);
  const id = newId('afb');
  db.prepare(
    `INSERT INTO attention_feedback (id, workspace_id, attention_id, verdict, note, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, attentionId, verdict, note ? String(note).slice(0, 500) : null, actorUserId, nowIso());
  return id;
}

/** "I have seen this and I am dealing with it." The item stays visible. */
function acknowledge(db, ctx, attentionId, { note = null } = {}) {
  return inTransaction(db, () => {
    const row = load(db, ctx.workspaceId, attentionId);
    if (row.status === 'RESOLVED') throw new ValidationError('That item has already been resolved.');
    db.prepare(
      `UPDATE attention_items
          SET status = 'ACKNOWLEDGED', acknowledged_at = ?, dismissed_at = NULL, dismissed_until = NULL
        WHERE id = ?`
    ).run(nowIso(), row.id);
    record(db, ctx.workspaceId, attentionId, 'acknowledged', { note, actorUserId: ctx.userId });
    return { status: 'ACKNOWLEDGED' };
  });
}

/**
 * "Not a problem for us." Hidden until it expires — the underlying condition is
 * still measured on every run, so nothing is lost, and if it materially worsens
 * the detectors will still have it on record.
 */
function dismiss(db, ctx, attentionId, { note = null, days = SNOOZE_DAYS } = {}) {
  const window = Number(days);
  if (!Number.isFinite(window) || window < 1 || window > 365) {
    throw new ValidationError('Choose between 1 and 365 days.');
  }
  return inTransaction(db, () => {
    const row = load(db, ctx.workspaceId, attentionId);
    const until = new Date(Date.now() + window * DAY).toISOString();
    db.prepare(
      `UPDATE attention_items
          SET status = 'DISMISSED', dismissed_at = ?, dismissed_until = ?, acknowledged_at = NULL
        WHERE id = ?`
    ).run(nowIso(), until, row.id);
    record(db, ctx.workspaceId, attentionId, window >= 30 ? 'dismissed' : 'snoozed', {
      note,
      actorUserId: ctx.userId,
    });
    return { status: 'DISMISSED', dismissedUntil: until };
  });
}

/** Puts a dismissed or acknowledged item back in the briefing. */
function reopen(db, ctx, attentionId) {
  return inTransaction(db, () => {
    const row = load(db, ctx.workspaceId, attentionId);
    db.prepare(
      `UPDATE attention_items
          SET status = 'OPEN', dismissed_at = NULL, dismissed_until = NULL, acknowledged_at = NULL,
              resolution_reason = NULL, resolved_at = NULL
        WHERE id = ?`
    ).run(row.id);
    return { status: 'OPEN' };
  });
}

/** "This was worth telling me" / "this was not." Recorded, not acted on. */
function rate(db, ctx, attentionId, verdict, { note = null } = {}) {
  if (verdict !== 'useful' && verdict !== 'not_useful') {
    throw new ValidationError('Rate an item as useful or not useful.');
  }
  return inTransaction(db, () => {
    load(db, ctx.workspaceId, attentionId);
    record(db, ctx.workspaceId, attentionId, verdict, { note, actorUserId: ctx.userId });
    return { verdict };
  });
}

function listFeedback(db, workspaceId, attentionId) {
  return db
    .prepare(
      `SELECT f.*, u.name AS actor_name
         FROM attention_feedback f
         LEFT JOIN users u ON u.id = f.actor_user_id
        WHERE f.workspace_id = ? AND f.attention_id = ?
        ORDER BY f.created_at DESC`
    )
    .all(workspaceId, attentionId)
    .map((row) => ({
      feedbackId: row.id,
      verdict: row.verdict,
      note: row.note,
      actorName: row.actor_name || 'Someone',
      createdAt: row.created_at,
    }));
}

/** Aggregate usefulness per category — visible to us, never auto-applied. */
function usefulnessByCategory(db, workspaceId) {
  return db
    .prepare(
      `SELECT i.category,
              SUM(CASE WHEN f.verdict = 'useful' THEN 1 ELSE 0 END) AS useful,
              SUM(CASE WHEN f.verdict = 'not_useful' THEN 1 ELSE 0 END) AS notUseful,
              SUM(CASE WHEN f.verdict IN ('dismissed', 'snoozed') THEN 1 ELSE 0 END) AS dismissed
         FROM attention_feedback f
         JOIN attention_items i ON i.id = f.attention_id
        WHERE f.workspace_id = ?
        GROUP BY i.category`
    )
    .all(workspaceId);
}

module.exports = {
  VERDICTS,
  acknowledge,
  dismiss,
  reopen,
  rate,
  listFeedback,
  usefulnessByCategory,
};
