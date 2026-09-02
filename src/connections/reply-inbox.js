'use strict';

/*
 * The three drawers, and moving mail between them.
 *
 * Foundry's first guess put every captured message somewhere. This is how a
 * person overrules it, and how the rest of the app asks what is still open.
 *
 * An owner's choice always wins and is always attributed. When Foundry sorted
 * a message the reason reads as an observation ("they wrote can you"); when a
 * person moved it, the record says who. That distinction matters the day
 * somebody asks why a customer never got an answer.
 */

const { nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const triage = require('./reply-triage');

const STATES = ['NEEDS_REPLY', 'WAITING', 'HANDLED'];
const WORDS = {
  NEEDS_REPLY: 'Needs a reply',
  WAITING: 'Waiting on them',
  HANDLED: 'Handled',
};

const SELECT = `SELECT m.id, m.connector_id, m.sender, m.subject, m.body_text, m.received_at,
    m.classification, m.trust_status, m.processing_status, m.reply_state, m.reply_reason,
    m.reply_state_by_user_id, m.reply_state_at, m.external_thread_id,
    c.display_name AS connector_name, s.name AS supplier_name,
    (SELECT COUNT(*) FROM connection_email_attachments a
      WHERE a.message_id = m.id AND a.workspace_id = m.workspace_id) AS attachment_count
  FROM connection_email_messages m
  JOIN workspace_connectors c ON c.id = m.connector_id
  LEFT JOIN suppliers s ON s.id = m.supplier_id`;

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    stateWords: WORDS[row.reply_state] || row.reply_state,
    // The first readable lines, for a list that has to be skimmed.
    preview: triage.prose(row.body_text).split(/\n+/).filter(Boolean).slice(0, 2).join(' ').slice(0, 220),
    decidedByPerson: Boolean(row.reply_state_by_user_id),
  };
}

function get(db, workspaceId, messageId) {
  const row = db.prepare(`${SELECT} WHERE m.id = ? AND m.workspace_id = ?`).get(messageId, workspaceId);
  if (!row) throw new NotFoundError('That message is not in this inventory.');
  return hydrate(row);
}

/**
 * One drawer, newest first — the order a person reads their own mail in.
 */
function list(db, workspaceId, state, options = {}) {
  if (!STATES.includes(state)) throw new ValidationError('That is not one of the three drawers.');
  const limit = Math.min(Number(options.limit) || 100, 500);
  return db.prepare(`${SELECT} WHERE m.workspace_id = ? AND m.reply_state = ?
    ORDER BY m.received_at DESC, m.rowid DESC LIMIT ?`)
    .all(workspaceId, state, limit).map(hydrate);
}

function counts(db, workspaceId) {
  const rows = db.prepare(`SELECT reply_state, COUNT(*) AS n FROM connection_email_messages
    WHERE workspace_id = ? GROUP BY reply_state`).all(workspaceId);
  const found = (state) => Number((rows.find((row) => row.reply_state === state) || {}).n || 0);
  return { NEEDS_REPLY: found('NEEDS_REPLY'), WAITING: found('WAITING'), HANDLED: found('HANDLED') };
}

/**
 * Move a message to a drawer, on a person's say-so.
 */
function setState(db, ctx, messageId, state, reason = null) {
  if (!STATES.includes(state)) throw new ValidationError('That is not one of the three drawers.');
  const current = get(db, ctx.workspaceId, messageId);
  if (current.reply_state === state) return current;
  const now = nowIso();
  db.prepare(`UPDATE connection_email_messages SET reply_state = ?, reply_reason = ?,
    reply_state_by_user_id = ?, reply_state_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(state, trimOrNull(reason) || `Moved to ${WORDS[state].toLowerCase()} by hand.`,
      ctx.actorId || null, now, messageId, ctx.workspaceId);
  return get(db, ctx.workspaceId, messageId);
}

/**
 * Ask Foundry to look again.
 *
 * Only offered for a message a person has not already ruled on, because
 * re-deciding somebody's decision for them is how software loses an argument
 * it was not invited to.
 */
function rejudge(db, ctx, messageId) {
  const current = get(db, ctx.workspaceId, messageId);
  if (current.decidedByPerson) {
    throw new ValidationError('You already decided where this belongs. Move it yourself if that has changed.');
  }
  const verdict = triage.judge({
    sender: current.sender, subject: current.subject, bodyText: current.body_text,
    attachmentCount: Number(current.attachment_count || 0),
    processingStatus: current.processing_status,
  });
  db.prepare(`UPDATE connection_email_messages SET reply_state = ?, reply_reason = ?, reply_state_at = ?
    WHERE id = ? AND workspace_id = ?`)
    .run(verdict.state, verdict.reason, nowIso(), messageId, ctx.workspaceId);
  return get(db, ctx.workspaceId, messageId);
}

/**
 * The oldest unanswered mail, for Needs You.
 *
 * Oldest rather than newest: the message most likely to have become a problem
 * is the one that has been sitting longest, and a queue that leads with today
 * quietly buries last Tuesday.
 */
function oldestUnanswered(db, workspaceId, limit = 5) {
  return db.prepare(`${SELECT} WHERE m.workspace_id = ? AND m.reply_state = 'NEEDS_REPLY'
    ORDER BY m.received_at ASC, m.rowid ASC LIMIT ?`)
    .all(workspaceId, Math.min(Number(limit) || 5, 50)).map(hydrate);
}

module.exports = { STATES, WORDS, get, list, counts, setState, rejudge, oldestUnanswered };
