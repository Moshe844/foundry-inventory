'use strict';

/*
 * The record of mail StockChief did not take.
 *
 * A filter nobody can see is indistinguishable from a bug. If a customer says
 * "I emailed you last Tuesday" and StockChief has nothing, the owner needs to be
 * able to look at what was set aside and find it there, with the reason it was
 * set aside, and bring it in with one click.
 *
 * So this stores the envelope and nothing else: sender, subject, when, and
 * why. No body, no attachments. The whole point of the gate is that StockChief
 * does not keep the contents of mail that is not its business, and a log that
 * kept them anyway would be the same mistake wearing a different name.
 */

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { NotFoundError } = require('../domain/errors');

/**
 * Note that a message was looked at and left alone.
 *
 * Idempotent on the provider's own message id: the poll window overlaps on
 * purpose, so the same message is offered several times and must not pile up.
 */
function record(db, workspaceId, connectorId, message, reason) {
  const externalId = String(message.messageId || message.externalMessageId || '').trim();
  if (!externalId) return null;
  const existing = db.prepare(`SELECT id FROM connection_email_set_aside
    WHERE workspace_id = ? AND connector_id = ? AND external_message_id = ?`)
    .get(workspaceId, connectorId, externalId);
  if (existing) return existing.id;
  const id = newId('setaside');
  db.prepare(`INSERT INTO connection_email_set_aside
    (id, workspace_id, connector_id, external_message_id, sender, subject, received_at, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, connectorId, externalId,
      String(message.sender || message.from || '').toLowerCase(),
      trimOrNull(message.subject), message.receivedAt || nowIso(), reason, nowIso());
  return id;
}

/** Newest first, because this is a list somebody scans for one thing. */
function list(db, workspaceId, options = {}) {
  const limit = Math.min(Number(options.limit) || 100, 500);
  return db.prepare(`SELECT a.*, c.display_name AS connector_name
    FROM connection_email_set_aside a
    JOIN workspace_connectors c ON c.id = a.connector_id
    WHERE a.workspace_id = ? AND a.brought_in_at IS NULL
    ORDER BY a.received_at DESC, a.rowid DESC LIMIT ?`).all(workspaceId, limit);
}

function count(db, workspaceId) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM connection_email_set_aside
    WHERE workspace_id = ? AND brought_in_at IS NULL`).get(workspaceId).n || 0);
}

function get(db, workspaceId, id) {
  const row = db.prepare(`SELECT * FROM connection_email_set_aside
    WHERE workspace_id = ? AND id = ?`).get(workspaceId, id);
  if (!row) throw new NotFoundError('That message is not in this inventory.');
  return row;
}

/** A person overruled the gate, and this is what the message became. */
function markBroughtIn(db, workspaceId, id, messageId, actorId) {
  db.prepare(`UPDATE connection_email_set_aside
    SET brought_in_message_id = ?, brought_in_by_user_id = ?, brought_in_at = ?
    WHERE workspace_id = ? AND id = ?`)
    .run(messageId, actorId || null, nowIso(), workspaceId, id);
  return get(db, workspaceId, id);
}

/**
 * Forget a decision so the message can be judged again.
 *
 * Used when a message is brought in by hand: the row stays as the record that
 * it was once set aside, so the same message arriving on the next overlapping
 * poll is not set aside a second time.
 */
function alreadySeen(db, workspaceId, connectorId, externalMessageId) {
  return Boolean(db.prepare(`SELECT 1 FROM connection_email_set_aside
    WHERE workspace_id = ? AND connector_id = ? AND external_message_id = ?
      AND brought_in_at IS NOT NULL`)
    .get(workspaceId, connectorId, externalMessageId));
}

module.exports = { record, list, count, get, markBroughtIn, alreadySeen };
