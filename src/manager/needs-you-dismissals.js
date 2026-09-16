'use strict';

/**
 * Durable, workspace-scoped decisions to stop surfacing an inbox item.
 *
 * This does not change or delete the business record that caused the prompt.
 * Its only effect is that StockChief stops treating this exact actionable prompt
 * as work the owner needs to see, everywhere the unified inbox is used.
 */

const { newId, nowIso } = require('../lib/util');
const { ValidationError } = require('../domain/errors');

function cleanEntryId(entryId) {
  const value = String(entryId || '').trim();
  if (!value) throw new ValidationError('Choose the item you want to dismiss.');
  return value.slice(0, 500);
}

function dismiss(db, ctx, entryId) {
  const clean = cleanEntryId(entryId);
  const actorId = ctx.actorId || ctx.userId || null;
  const at = nowIso();
  db.prepare(
    `INSERT INTO needs_you_dismissals
       (id, workspace_id, entry_id, dismissed_by_user_id, dismissed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, entry_id) DO UPDATE SET
       dismissed_by_user_id = excluded.dismissed_by_user_id,
       dismissed_at = excluded.dismissed_at`
  ).run(newId('nyd'), ctx.workspaceId, clean, actorId, at);
  return { entryId: clean, dismissedAt: at };
}

function dismissedIds(db, workspaceId, entryIds) {
  const ids = [...new Set((entryIds || []).map((entryId) => String(entryId || '').trim()).filter(Boolean))];
  if (!ids.length) return new Set();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT entry_id FROM needs_you_dismissals
       WHERE workspace_id = ? AND entry_id IN (${placeholders})`
  ).all(workspaceId, ...ids);
  return new Set(rows.map((row) => row.entry_id));
}

module.exports = { dismiss, dismissedIds };
