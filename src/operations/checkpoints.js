'use strict';

const { nowIso } = require('../lib/util');

function record(db, key, status, detail = {}, options = {}) {
  const checkedAt = options.checkedAt || nowIso();
  db.prepare(`INSERT INTO runtime_checkpoints (check_key, status, detail, checked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(check_key) DO UPDATE SET status = excluded.status,
      detail = excluded.detail, checked_at = excluded.checked_at`)
    .run(key, status, JSON.stringify(detail || {}), checkedAt);
  return get(db, key);
}

function get(db, key) {
  const row = db.prepare('SELECT * FROM runtime_checkpoints WHERE check_key = ?').get(key);
  if (!row) return null;
  let detail = {};
  try { detail = JSON.parse(row.detail || '{}'); } catch { /* retained as empty */ }
  return { key: row.check_key, status: row.status, detail, checkedAt: row.checked_at };
}

function list(db) {
  return db.prepare('SELECT * FROM runtime_checkpoints ORDER BY check_key').all().map((row) => get(db, row.check_key));
}

function merge(db, key, status, detail = {}, options = {}) {
  const prior = get(db, key);
  return record(db, key, status, { ...(prior?.detail || {}), ...(detail || {}) }, options);
}

module.exports = { record, merge, get, list };
