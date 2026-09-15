'use strict';

const { ValidationError } = require('../domain/errors');
const { nowIso } = require('../lib/util');

const MODES = Object.freeze({ MANUAL: 'MANUAL', RECOMMEND: 'RECOMMEND', AUTOMATIC: 'AUTOMATIC' });

function get(db, workspaceId) {
  const row = db.prepare('SELECT * FROM shipping_operation_policy WHERE workspace_id = ?')
    .get(workspaceId);
  return row ? { mode: row.mode, updatedAt: row.updated_at } : { mode: MODES.RECOMMEND, updatedAt: null };
}

function set(db, ctx, mode) {
  const selected = String(mode || '').toUpperCase();
  if (!Object.values(MODES).includes(selected)) {
    throw new ValidationError('Choose Manual, Recommend, or Automatic shipping.');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO shipping_operation_policy
      (workspace_id, mode, updated_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET mode = excluded.mode,
      updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`)
    .run(ctx.workspaceId, selected, ctx.actorId || null, now, now);
  return get(db, ctx.workspaceId);
}

module.exports = { MODES, get, set };
