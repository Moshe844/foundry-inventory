'use strict';

const crypto = require('node:crypto');

const OMIT_TABLES = new Set([
  'connection_credentials', 'connection_authorization_states', 'sessions',
]);

function build(db, workspaceId) {
  const workspace = db.prepare('SELECT id, name, source_of_truth_mode, created_at FROM workspaces WHERE id = ?')
    .get(workspaceId);
  if (!workspace) throw new Error('Workspace not found.');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name)
    .filter((name) => !OMIT_TABLES.has(name))
    .filter((name) => db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all()
      .some((column) => column.name === 'workspace_id'));
  const records = {};
  for (const table of tables) {
    const safe = table.replaceAll('"', '""');
    records[table] = db.prepare(`SELECT * FROM "${safe}" WHERE workspace_id = ?`).all(workspaceId)
      .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        Buffer.isBuffer(value) ? { encoding: 'base64', data: value.toString('base64') } : value])));
  }
  // Membership is business audit identity, but login credentials and other
  // workspaces owned by the same account are deliberately excluded.
  records.users = db.prepare('SELECT id, name, role, permissions, created_at FROM users WHERE workspace_id = ?')
    .all(workspaceId);
  const exportedAt = new Date().toISOString();
  const payload = { format: 'keeper-workspace-export', version: 1, exportedAt, workspace, records };
  payload.integrity = { algorithm: 'sha256', digest: crypto.createHash('sha256')
    .update(JSON.stringify(payload.records)).digest('hex') };
  return payload;
}

module.exports = { build, OMIT_TABLES };
