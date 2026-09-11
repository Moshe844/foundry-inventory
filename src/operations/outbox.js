'use strict';

const os = require('node:os');
const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');
const { backoffMs } = require('./job-queue');

const parse = (value, fallback = {}) => {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); }
  catch { return fallback; }
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, destination: row.destination,
    messageType: row.message_type, payload: parse(row.payload), status: row.status,
    attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    availableAt: row.available_at, leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at, idempotencyKey: row.idempotency_key,
    lastError: row.last_error, createdAt: row.created_at, deliveredAt: row.delivered_at,
  };
}

function get(db, id) {
  return hydrate(db.prepare('SELECT * FROM runtime_outbox WHERE id = ?').get(id));
}

function enqueue(db, input = {}) {
  if (!input.destination || !input.messageType || !input.idempotencyKey) {
    throw new TypeError('An outbox message requires destination, type and idempotency key.');
  }
  return inTransaction(db, () => {
    const prior = db.prepare(`SELECT * FROM runtime_outbox
      WHERE destination = ? AND idempotency_key = ?`).get(input.destination, input.idempotencyKey);
    if (prior) return { message: hydrate(prior), created: false };
    const id = input.id || newId('outbox');
    const now = Number(input.now || Date.now());
    const iso = new Date(now).toISOString();
    db.prepare(`INSERT INTO runtime_outbox
      (id, workspace_id, destination, message_type, payload, status, attempt_count,
       max_attempts, available_at, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?, ?)`)
      .run(id, input.workspaceId || null, input.destination, input.messageType,
        JSON.stringify(input.payload || {}), Number(input.maxAttempts || 8),
        Number(input.availableAt || now), input.idempotencyKey, iso, iso);
    return { message: get(db, id), created: true };
  });
}

function recoverExpired(db, options = {}) {
  const now = Number(options.now || Date.now());
  const rows = db.prepare(`SELECT * FROM runtime_outbox WHERE status = 'RUNNING'
    AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).all(now);
  for (const row of rows) {
    const next = row.attempt_count >= row.max_attempts ? 'DEAD' : 'RETRY';
    db.prepare(`UPDATE runtime_outbox SET status = ?, available_at = ?, lease_owner = NULL,
      lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING'`)
      .run(next, now, 'Delivery worker stopped before confirmation.', new Date(now).toISOString(), row.id);
  }
  return rows.length;
}

function claim(db, options = {}) {
  const now = Number(options.now || Date.now());
  const leaseMs = Math.max(1000, Number(options.leaseMs || 60_000));
  const owner = String(options.owner || `${process.pid}@${os.hostname()}`);
  return inTransaction(db, () => {
    recoverExpired(db, { now });
    const row = db.prepare(`SELECT * FROM runtime_outbox
      WHERE status IN ('PENDING','RETRY') AND available_at <= ?
      ORDER BY created_at ASC LIMIT 1`).get(now);
    if (!row) return null;
    const changed = db.prepare(`UPDATE runtime_outbox SET status = 'RUNNING',
      attempt_count = attempt_count + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('PENDING','RETRY')`)
      .run(owner, now + leaseMs, new Date(now).toISOString(), row.id);
    return changed.changes ? get(db, row.id) : null;
  });
}

function complete(db, id, owner, options = {}) {
  const now = Number(options.now || Date.now());
  const changed = db.prepare(`UPDATE runtime_outbox SET status = 'DELIVERED',
    lease_owner = NULL, lease_expires_at = NULL, delivered_at = ?, updated_at = ?
    WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?`)
    .run(new Date(now).toISOString(), new Date(now).toISOString(), id, owner);
  return changed.changes === 1;
}

function fail(db, id, owner, error, options = {}) {
  return inTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM runtime_outbox WHERE id = ? AND status = 'RUNNING'
      AND lease_owner = ?`).get(id, owner);
    if (!row) return null;
    const now = Number(options.now || Date.now());
    const retryable = options.retryable !== false;
    const dead = !retryable || row.attempt_count >= row.max_attempts;
    db.prepare(`UPDATE runtime_outbox SET status = ?, available_at = ?, lease_owner = NULL,
      lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(dead ? 'DEAD' : 'RETRY', dead ? now : now + Number(options.retryAfterMs || backoffMs(row.attempt_count)),
        String(error && error.message || error || 'Delivery failed.'), new Date(now).toISOString(), id);
    return get(db, id);
  });
}

async function processOne(db, dispatchers, options = {}) {
  const owner = String(options.owner || `${process.pid}@${os.hostname()}`);
  const message = claim(db, { ...options, owner });
  if (!message) return null;
  const dispatcher = dispatchers && dispatchers[message.destination];
  if (typeof dispatcher !== 'function') {
    return fail(db, message.id, owner,
      new Error(`No outbox dispatcher is registered for ${message.destination}.`),
      { ...options, retryable: false });
  }
  try {
    const result = await dispatcher(message);
    complete(db, message.id, owner, options);
    return { ...get(db, message.id), deliveryResult: result || null };
  } catch (error) {
    return fail(db, message.id, owner, error, {
      ...options, retryable: error && error.retryable !== false,
    });
  }
}

function listDead(db, limit = 100) {
  return db.prepare(`SELECT * FROM runtime_outbox WHERE status = 'DEAD'
    ORDER BY updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, Number(limit)))).map(hydrate);
}

function retryDead(db, id, options = {}) {
  const now = Number(options.now || Date.now());
  const changed = db.prepare(`UPDATE runtime_outbox SET status = 'RETRY', attempt_count = 0,
    available_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL,
    delivered_at = NULL, updated_at = ? WHERE id = ? AND status = 'DEAD'`)
    .run(now, new Date(now).toISOString(), id);
  return changed.changes === 1 ? get(db, id) : null;
}

module.exports = { hydrate, get, enqueue, recoverExpired, claim, complete, fail, processOne, listDead, retryDead };
