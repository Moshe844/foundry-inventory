'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const { inTransaction } = require('../db');

const json = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    payload: json(row.payload, {}),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function keyFor(kind, payload, { now = Date.now() } = {}) {
  const minute = new Date(now).toISOString().slice(0, 16);
  const digest = crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex').slice(0, 20);
  return `${kind}:${minute}:${digest}`;
}

function enqueue(db, workspaceId, kind, payload = {}, options = {}) {
  const key = options.idempotencyKey || keyFor(kind, payload, options);
  const existing = db
    .prepare('SELECT * FROM manager_triggers WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, key);
  if (existing) return { trigger: hydrate(existing), created: false };

  const id = newId('mtr');
  db.prepare(
    `INSERT INTO manager_triggers
       (id, workspace_id, kind, payload, idempotency_key, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`
  ).run(id, workspaceId, kind, JSON.stringify(payload || {}), key, nowIso());
  return { trigger: get(db, workspaceId, id), created: true };
}

function get(db, workspaceId, id) {
  return hydrate(db.prepare('SELECT * FROM manager_triggers WHERE id = ? AND workspace_id = ?').get(id, workspaceId));
}

function claimNext(db) {
  return inTransaction(db, () => {
    const row = db
      .prepare("SELECT * FROM manager_triggers WHERE status = 'PENDING' ORDER BY created_at, rowid LIMIT 1")
      .get();
    if (!row) return null;
    db.prepare(
      "UPDATE manager_triggers SET status = 'RUNNING', attempts = attempts + 1, started_at = ? WHERE id = ? AND status = 'PENDING'"
    ).run(nowIso(), row.id);
    return hydrate(db.prepare('SELECT * FROM manager_triggers WHERE id = ?').get(row.id));
  });
}

function finish(db, id, error = null) {
  db.prepare(
    `UPDATE manager_triggers SET status = ?, error_message = ?, completed_at = ? WHERE id = ?`
  ).run(error ? 'FAILED' : 'COMPLETED', error ? String(error.message || error) : null, nowIso(), id);
}

function recover(db) {
  const result = db.prepare(
    "UPDATE manager_triggers SET status = 'PENDING', started_at = NULL WHERE status = 'RUNNING'"
  ).run();
  return result.changes;
}

function list(db, workspaceId, { statuses = null, limit = 50 } = {}) {
  const wanted = statuses ? (Array.isArray(statuses) ? statuses : [statuses]) : null;
  const clause = wanted ? ` AND status IN (${wanted.map(() => '?').join(',')})` : '';
  return db
    .prepare(`SELECT * FROM manager_triggers WHERE workspace_id = ?${clause} ORDER BY created_at DESC LIMIT ?`)
    .all(workspaceId, ...(wanted || []), limit)
    .map(hydrate);
}

module.exports = { hydrate, keyFor, enqueue, get, claimNext, finish, recover, list };
