'use strict';

/**
 * The assistant's ledger.
 *
 * What was asked, in how many parts, and what became of each part. A message
 * is a turn; a turn has goals; every goal ends in one status a person can
 * read. The Ask page is a view of this ledger and the reply about any goal is
 * composed from its row, so nothing can be said to have happened that the
 * ledger does not record — and nothing asked can vanish without a row that
 * says what became of it.
 *
 * A turn also leaves referents: the PO it drafted, the proposal it prepared.
 * "That PO" in the next message resolves against them.
 */

const { newId, nowIso } = require('../lib/util');

const GOAL_KINDS = ['lookup', 'change', 'send', 'communication', 'instruction', 'report', 'navigate', 'unsupported', 'unclear'];
const GOAL_STATUSES = ['pending', 'answered', 'needs_approval', 'drafted', 'clarify', 'handed', 'refused', 'failed', 'done', 'skipped', 'replaced', 'withdrawn'];

/** What each status means to the person reading it, and its tone. */
const STATUS_LABEL = {
  pending: { label: 'Waiting', tone: 'muted' },
  answered: { label: 'Answered', tone: 'ok' },
  needs_approval: { label: 'Needs your approval', tone: 'warn' },
  drafted: { label: 'Drafted — not sent', tone: 'warn' },
  clarify: { label: 'Needs an answer from you', tone: 'warn' },
  handed: { label: 'Taken to its page', tone: 'muted' },
  refused: { label: 'Not done — refused', tone: 'danger' },
  failed: { label: 'Not done — failed', tone: 'danger' },
  done: { label: 'Done', tone: 'ok' },
  skipped: { label: 'Left undone — you skipped it', tone: 'muted' },
  replaced: { label: 'Replaced by your correction', tone: 'muted' },
  withdrawn: { label: 'Withdrawn — you undid it', tone: 'muted' },
};

const json = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function hydrateGoal(row) {
  return {
    id: row.id, turnId: row.turn_id, position: row.position, kind: row.kind, text: row.text, status: row.status,
    said: row.said || '', resultHref: row.result_href || null, resultLabel: row.result_label || null,
    provenance: json(row.provenance, {}), createdAt: row.created_at, updatedAt: row.updated_at,
    statusLabel: (STATUS_LABEL[row.status] || STATUS_LABEL.pending).label,
    statusTone: (STATUS_LABEL[row.status] || STATUS_LABEL.pending).tone,
  };
}

function hydrateTurn(row) {
  return {
    id: row.id, conversationId: row.conversation_id, channel: row.channel, message: row.message,
    understanding: json(row.understanding, {}), continuesTurnId: row.continues_turn_id || null, createdAt: row.created_at,
    goals: [], referents: [],
  };
}

/**
 * Opens a turn with its goals, all pending. `understanding` is stored as it
 * was produced so a later reader can see what StockChief made of the message.
 */
function openTurn(db, ctx, input) {
  const now = nowIso();
  const id = newId('turn');
  const goals = (input.goals || []).length ? input.goals : [{ kind: 'unclear', text: input.message }];
  db.prepare(`INSERT INTO assistant_turns
    (id, workspace_id, user_id, conversation_id, channel, message, understanding, continues_turn_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, ctx.actorId, String(input.conversationId || 'default'), String(input.channel || 'tell'),
      String(input.message || ''), JSON.stringify(input.understanding || {}), input.continuesTurnId || null, now);
  const insert = db.prepare(`INSERT INTO assistant_goals
    (id, workspace_id, turn_id, position, kind, text, status, provenance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', '{}', ?, ?)`);
  const rows = goals.map((goal, position) => {
    const goalId = newId('goal');
    insert.run(goalId, ctx.workspaceId, id, position, GOAL_KINDS.includes(goal.kind) ? goal.kind : 'unclear', String(goal.text || input.message), now, now);
    return goalId;
  });
  return getTurn(db, ctx.workspaceId, id, rows);
}

function getTurn(db, workspaceId, turnId) {
  const row = db.prepare('SELECT * FROM assistant_turns WHERE id = ? AND workspace_id = ?').get(turnId, workspaceId);
  if (!row) return null;
  const turn = hydrateTurn(row);
  turn.goals = db.prepare('SELECT * FROM assistant_goals WHERE turn_id = ? ORDER BY position').all(turnId).map(hydrateGoal);
  turn.referents = db.prepare('SELECT * FROM assistant_referents WHERE turn_id = ? ORDER BY created_at').all(turnId)
    .map((r) => ({ id: r.id, kind: r.kind, refId: r.ref_id, label: r.label, href: r.href || null }));
  return turn;
}

function getGoal(db, workspaceId, goalId) {
  const row = db.prepare('SELECT * FROM assistant_goals WHERE id = ? AND workspace_id = ?').get(goalId, workspaceId);
  return row ? hydrateGoal(row) : null;
}

/**
 * Records what became of a goal. Provenance is merged, not replaced, so the
 * dispatcher can say "handed to /actions" and the page can add what it read.
 */
function settle(db, ctx, goalId, outcome = {}) {
  const current = getGoal(db, ctx.workspaceId, goalId);
  if (!current) return null;
  const status = GOAL_STATUSES.includes(outcome.status) ? outcome.status : current.status;
  db.prepare(`UPDATE assistant_goals SET status = ?, said = ?, result_href = ?, result_label = ?, provenance = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?`)
    .run(status, outcome.said !== undefined ? String(outcome.said || '') : current.said,
      outcome.resultHref !== undefined ? outcome.resultHref : current.resultHref,
      outcome.resultLabel !== undefined ? outcome.resultLabel : current.resultLabel,
      JSON.stringify({ ...current.provenance, ...(outcome.provenance || {}) }), nowIso(), goalId, ctx.workspaceId);
  return getGoal(db, ctx.workspaceId, goalId);
}

/** Something a turn put on the table, named as a person would name it. */
function noteReferent(db, ctx, turnId, referent) {
  if (!turnId || !referent || !referent.refId) return null;
  const id = newId('ref');
  db.prepare(`INSERT INTO assistant_referents (id, workspace_id, turn_id, kind, ref_id, label, href, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, turnId, String(referent.kind), String(referent.refId), String(referent.label || referent.refId),
      referent.href || null, nowIso());
  return id;
}

/** The last turns of one conversation, oldest first, with goals and referents. */
function conversation(db, ctx, conversationId, { limit = 12 } = {}) {
  const rows = db.prepare(`SELECT id FROM assistant_turns
    WHERE workspace_id = ? AND user_id = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(ctx.workspaceId, ctx.actorId, String(conversationId || 'default'), limit);
  return rows.reverse().map((row) => getTurn(db, ctx.workspaceId, row.id));
}

/** Referents from the last few turns of a conversation, newest first. */
function recentReferents(db, ctx, conversationId, { turns = 6 } = {}) {
  return db.prepare(`SELECT r.* FROM assistant_referents r
    JOIN assistant_turns t ON t.id = r.turn_id
    WHERE t.workspace_id = ? AND t.user_id = ? AND t.conversation_id = ?
    ORDER BY t.created_at DESC, r.created_at DESC LIMIT ?`)
    .all(ctx.workspaceId, ctx.actorId, String(conversationId || 'default'), turns * 4)
    .map((r) => ({ id: r.id, kind: r.kind, refId: r.ref_id, label: r.label, href: r.href || null, turnId: r.turn_id }));
}

/** A goal with how many siblings its turn had, for a page that shows one goal. */
function goalWithTurn(db, workspaceId, goalId) {
  const goal = getGoal(db, workspaceId, goalId);
  if (!goal) return null;
  const n = db.prepare('SELECT COUNT(*) n FROM assistant_goals WHERE turn_id = ?').get(goal.turnId).n;
  return { ...goal, turnGoals: n };
}

/** The most recent goal of a conversation that ended at this address. */
function goalByResult(db, ctx, conversationId, href) {
  const row = db.prepare(`SELECT g.id FROM assistant_goals g JOIN assistant_turns t ON t.id = g.turn_id
    WHERE t.workspace_id = ? AND t.user_id = ? AND t.conversation_id = ? AND g.result_href = ?
    ORDER BY g.updated_at DESC LIMIT 1`).get(ctx.workspaceId, ctx.actorId, String(conversationId || 'default'), href);
  return row ? goalWithTurn(db, ctx.workspaceId, row.id) : null;
}

/**
 * What the conversation was last about: the one product and the one place
 * the most recent answered lookup read. "Them" and "there" in the next
 * message mean these.
 */
function lastSubjects(db, ctx, conversationId) {
  const rows = db.prepare(`SELECT g.provenance, g.status FROM assistant_goals g JOIN assistant_turns t ON t.id = g.turn_id
    WHERE t.workspace_id = ? AND t.user_id = ? AND t.conversation_id = ? AND g.status = 'answered'
    ORDER BY g.updated_at DESC LIMIT 3`).all(ctx.workspaceId, ctx.actorId, String(conversationId || 'default'));
  for (const row of rows) {
    const reads = (json(row.provenance, {}).reads || []);
    const products = new Set(reads.map((r) => r.entity).filter(Boolean));
    const places = new Set(reads.map((r) => r.location).filter(Boolean));
    if (products.size || places.size) return { product: products.size === 1 ? [...products][0] : null, location: places.size === 1 ? [...places][0] : null };
  }
  return { product: null, location: null };
}

/** The most recent goal of a conversation that ended somewhere, newest first. */
function lastSettled(db, ctx, conversationId) {
  const row = db.prepare(`SELECT g.* FROM assistant_goals g JOIN assistant_turns t ON t.id = g.turn_id
    WHERE t.workspace_id = ? AND t.user_id = ? AND t.conversation_id = ? AND g.status <> 'pending'
    ORDER BY g.updated_at DESC, g.rowid DESC LIMIT 1`).get(ctx.workspaceId, ctx.actorId, String(conversationId || 'default'));
  return row ? hydrateGoal(row) : null;
}

/** The goals of a conversation that are still waiting, oldest first. */
function pendingGoals(db, ctx, conversationId) {
  return db.prepare(`SELECT g.* FROM assistant_goals g JOIN assistant_turns t ON t.id = g.turn_id
    WHERE t.workspace_id = ? AND t.user_id = ? AND t.conversation_id = ? AND g.status = 'pending'
    ORDER BY t.created_at, g.position`)
    .all(ctx.workspaceId, ctx.actorId, String(conversationId || 'default')).map(hydrateGoal);
}

module.exports = {
  GOAL_KINDS, GOAL_STATUSES, STATUS_LABEL,
  openTurn, getTurn, getGoal, goalWithTurn, goalByResult, settle, noteReferent, conversation, recentReferents, pendingGoals, lastSubjects, lastSettled,
};
