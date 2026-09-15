'use strict';

const os = require('node:os');
const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');

const ACTIVE = ['PENDING', 'RETRY'];
const terminal = (status) => ['COMPLETED', 'DEAD', 'CANCELLED'].includes(status);
const parse = (value, fallback = {}) => {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); }
  catch { return fallback; }
};

function event(db, jobId, eventType, detail = {}) {
  db.prepare(`INSERT INTO runtime_job_events (id, job_id, event_type, detail, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(newId('jobevt'), jobId, eventType, JSON.stringify(detail), nowIso());
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    payload: parse(row.payload),
    status: row.status,
    priority: row.priority,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    idempotencyKey: row.idempotency_key,
    result: parse(row.result, null),
    lastError: parse(row.last_error, null),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function get(db, id) {
  return hydrate(db.prepare('SELECT * FROM runtime_jobs WHERE id = ?').get(id));
}

function enqueue(db, input = {}) {
  if (!input.kind || !input.idempotencyKey) {
    throw new TypeError('A durable job requires a kind and idempotency key.');
  }
  return inTransaction(db, () => {
    const prior = db.prepare(`SELECT * FROM runtime_jobs
      WHERE kind = ? AND IFNULL(workspace_id, '') = IFNULL(?, '') AND idempotency_key = ?`)
      .get(input.kind, input.workspaceId || null, input.idempotencyKey);
    if (prior) return { job: hydrate(prior), created: false };

    const id = input.id || newId('rjob');
    const now = input.now || Date.now();
    const iso = new Date(now).toISOString();
    db.prepare(`INSERT INTO runtime_jobs
      (id, workspace_id, kind, payload, status, priority, attempt_count, max_attempts,
       available_at, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?, 0, ?, ?, ?, ?, ?)`)
      .run(id, input.workspaceId || null, input.kind, JSON.stringify(input.payload || {}),
        Number(input.priority || 100), Number(input.maxAttempts || 5),
        Number(input.availableAt || now), input.idempotencyKey, iso, iso);
    event(db, id, 'ENQUEUED', { availableAt: Number(input.availableAt || now) });
    return { job: get(db, id), created: true };
  });
}

function recoverExpired(db, options = {}) {
  const now = Number(options.now || Date.now());
  return inTransaction(db, () => {
    const rows = db.prepare(`SELECT * FROM runtime_jobs
      WHERE status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).all(now);
    let retried = 0;
    let dead = 0;
    for (const row of rows) {
      const next = row.attempt_count >= row.max_attempts ? 'DEAD' : 'RETRY';
      db.prepare(`UPDATE runtime_jobs SET status = ?, available_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING'`)
        .run(next, now, JSON.stringify({ code: 'lease_expired', message: 'Worker stopped before completion.' }),
          new Date(now).toISOString(), row.id);
      event(db, row.id, next === 'DEAD' ? 'DEAD_LETTERED' : 'LEASE_RECOVERED', {
        previousOwner: row.lease_owner, attempt: row.attempt_count,
      });
      if (next === 'DEAD') dead += 1; else retried += 1;
    }
    return { recovered: rows.length, retried, dead };
  });
}

function claim(db, options = {}) {
  const now = Number(options.now || Date.now());
  const leaseMs = Math.max(1000, Number(options.leaseMs || 60_000));
  const owner = String(options.owner || `${process.pid}@${os.hostname()}`);
  return inTransaction(db, () => {
    recoverExpired(db, { now });
    const row = db.prepare(`SELECT * FROM runtime_jobs
      WHERE status IN ('PENDING','RETRY') AND available_at <= ?
      ORDER BY priority ASC, created_at ASC LIMIT 1`).get(now);
    if (!row) return null;
    const changed = db.prepare(`UPDATE runtime_jobs SET status = 'RUNNING', attempt_count = attempt_count + 1,
      lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('PENDING','RETRY')`)
      .run(owner, now + leaseMs, new Date(now).toISOString(), new Date(now).toISOString(), row.id);
    if (!changed.changes) return null;
    event(db, row.id, 'CLAIMED', { owner, leaseExpiresAt: now + leaseMs });
    return get(db, row.id);
  });
}

function heartbeat(db, id, owner, options = {}) {
  const now = Number(options.now || Date.now());
  const leaseMs = Math.max(1000, Number(options.leaseMs || 60_000));
  const changed = db.prepare(`UPDATE runtime_jobs SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?`)
    .run(now + leaseMs, new Date(now).toISOString(), id, owner);
  return changed.changes === 1;
}

function complete(db, id, owner, result = {}, options = {}) {
  return inTransaction(db, () => {
    const now = Number(options.now || Date.now());
    const changed = db.prepare(`UPDATE runtime_jobs SET status = 'COMPLETED', result = ?, last_error = NULL,
      lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?`)
      .run(JSON.stringify(result || {}), new Date(now).toISOString(), new Date(now).toISOString(), id, owner);
    if (changed.changes) event(db, id, 'COMPLETED', { result });
    return changed.changes === 1;
  });
}

function backoffMs(attempt) {
  return Math.min(15 * 60_000, 1000 * (2 ** Math.max(0, attempt - 1)));
}

function fail(db, id, owner, error, options = {}) {
  return inTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM runtime_jobs
      WHERE id = ? AND status = 'RUNNING' AND lease_owner = ?`).get(id, owner);
    if (!row) return null;
    const now = Number(options.now || Date.now());
    const retryable = options.retryable !== false;
    const dead = !retryable || row.attempt_count >= row.max_attempts;
    const status = dead ? 'DEAD' : 'RETRY';
    const availableAt = dead ? now : now + Number(options.retryAfterMs || backoffMs(row.attempt_count));
    const detail = {
      code: error && error.code || 'job_failed',
      message: String(error && error.message || error || 'Job failed.'),
      retryable,
    };
    db.prepare(`UPDATE runtime_jobs SET status = ?, available_at = ?, lease_owner = NULL,
      lease_expires_at = NULL, last_error = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, availableAt, JSON.stringify(detail), dead ? new Date(now).toISOString() : null,
        new Date(now).toISOString(), id);
    event(db, id, dead ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED', { ...detail, availableAt });
    return get(db, id);
  });
}

function retryDead(db, id, options = {}) {
  return inTransaction(db, () => {
    const now = Number(options.now || Date.now());
    const changed = db.prepare(`UPDATE runtime_jobs SET status = 'RETRY', available_at = ?,
      attempt_count = 0, completed_at = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'DEAD'`)
      .run(now, new Date(now).toISOString(), id);
    if (changed.changes) event(db, id, 'MANUAL_RETRY', { by: options.by || 'operator' });
    return changed.changes === 1 ? get(db, id) : null;
  });
}

async function processOne(db, handlers, options = {}) {
  const owner = String(options.owner || `${process.pid}@${os.hostname()}`);
  const job = claim(db, { ...options, owner });
  if (!job) return null;
  const handler = handlers && handlers[job.kind];
  if (typeof handler !== 'function') {
    return fail(db, job.id, owner, Object.assign(new Error(`No handler is registered for ${job.kind}.`),
      { code: 'handler_missing' }), { retryable: false, now: options.now });
  }
  try {
    const result = await handler(job, {
      heartbeat: (heartbeatOptions = {}) => heartbeat(db, job.id, owner, { ...options, ...heartbeatOptions }),
    });
    if (!complete(db, job.id, owner, result, options)) {
      throw Object.assign(new Error('The worker lost its lease before completion.'), { code: 'lease_lost' });
    }
    return get(db, job.id);
  } catch (error) {
    return fail(db, job.id, owner, error, {
      ...options,
      retryable: error && error.retryable !== false,
    });
  }
}

function listDead(db, limit = 100) {
  return db.prepare(`SELECT * FROM runtime_jobs WHERE status = 'DEAD'
    ORDER BY completed_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, Number(limit)))).map(hydrate);
}

module.exports = {
  ACTIVE, terminal, enqueue, get, claim, heartbeat, complete, fail, retryDead,
  recoverExpired, processOne, listDead, backoffMs,
};
