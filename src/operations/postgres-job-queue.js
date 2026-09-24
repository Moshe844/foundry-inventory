'use strict';

const { newId } = require('../lib/util');

function hydrate(row) {
  if (!row) return null;
  return { id: row.id, workspaceId: row.workspace_id, kind: row.kind, payload: row.payload,
    status: row.status, priority: row.priority, attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    availableAt: Number(row.available_at), leaseOwner: row.lease_owner, leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    idempotencyKey: row.idempotency_key, result: row.result, lastError: row.last_error };
}

function time(options) {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Job time must be a nonnegative integer.');
  return now;
}

async function databaseTime(client, options) {
  if (options.now !== undefined) return time(options);
  const result = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS milliseconds');
  return time({ now: Number(result.rows[0].milliseconds) });
}

function lease(options) {
  const value = options.leaseMs ?? 60000;
  if (!Number.isSafeInteger(value) || value < 1000) throw new TypeError('A job lease must be at least 1000 milliseconds.');
  return value;
}

function event(client, id, type, detail, now) {
  return client.query(`INSERT INTO stockchief_runtime.job_events(id, job_id, event_type, detail, created_at)
    VALUES ($1, $2, $3, $4::jsonb, $5)`, [newId('jobevt'), id, type, JSON.stringify(detail), new Date(now).toISOString()]);
}

async function get(database, id, workspaceId) {
  const result = await database.query('SELECT * FROM stockchief_runtime.jobs WHERE id = $1 AND workspace_id IS NOT DISTINCT FROM $2', [id, workspaceId || null]);
  return hydrate(result.rows[0]);
}

async function enqueue(database, input = {}) {
  if (!input.kind || !input.idempotencyKey) throw new TypeError('A durable job requires a kind and idempotency key.');
  const now = await databaseTime(database, input);
  const priority = input.priority ?? 100;
  const attempts = input.maxAttempts ?? 5;
  const availableAt = input.availableAt ?? now;
  if (!Number.isSafeInteger(priority) || !Number.isSafeInteger(attempts) || attempts < 1
    || !Number.isSafeInteger(availableAt) || availableAt < 0) throw new TypeError('Invalid durable job scheduling values.');
  return database.transaction(async (client) => {
    const inserted = await client.query(`INSERT INTO stockchief_runtime.jobs
      (id, workspace_id, kind, payload, priority, max_attempts, available_at, idempotency_key, created_at, updated_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING RETURNING *`,
    [input.id || newId('rjob'), input.workspaceId || null, input.kind, JSON.stringify(input.payload || {}),
      priority, attempts, availableAt, input.idempotencyKey, new Date(now).toISOString()]);
    if (inserted.rows.length) {
      await event(client, inserted.rows[0].id, 'ENQUEUED', { availableAt }, now);
      return { job: hydrate(inserted.rows[0]), created: true };
    }
    const prior = await client.query(`SELECT * FROM stockchief_runtime.jobs
      WHERE kind = $1 AND workspace_id IS NOT DISTINCT FROM $2 AND idempotency_key = $3`,
    [input.kind, input.workspaceId || null, input.idempotencyKey]);
    if (!prior.rows.length) throw new Error('Job ID conflicts with a different idempotency key.');
    return { job: hydrate(prior.rows[0]), created: false };
  }, { isolation: 'READ COMMITTED' });
}

async function recover(client, now) {
  const expired = await client.query(`SELECT * FROM stockchief_runtime.jobs
    WHERE status = 'RUNNING' AND lease_expires_at <= $1 FOR UPDATE SKIP LOCKED`, [now]);
  for (const row of expired.rows) {
    const dead = row.attempt_count >= row.max_attempts;
    await client.query(`UPDATE stockchief_runtime.jobs SET status = $2, available_at = $3,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
      last_error = $4::jsonb, completed_at = $5, updated_at = $6 WHERE id = $1`,
    [row.id, dead ? 'DEAD' : 'RETRY', now, JSON.stringify({ code: 'lease_expired', message: 'Worker stopped before completion.' }),
      dead ? new Date(now).toISOString() : null, new Date(now).toISOString()]);
    await event(client, row.id, dead ? 'DEAD_LETTERED' : 'LEASE_RECOVERED', { previousOwner: row.lease_owner }, now);
  }
  return expired.rows.length;
}

function recoverExpired(database, options = {}) {
  return database.transaction(async (client) => recover(client, await databaseTime(client, options)), { isolation: 'READ COMMITTED' });
}

async function claim(database, options = {}) {
  if (!options.owner) throw new TypeError('A PostgreSQL worker needs an explicit owner identity.');
  const leaseMs = lease(options);
  const kinds = Array.isArray(options.kinds)
    ? [...new Set(options.kinds.map((kind) => String(kind || '').trim()).filter(Boolean))]
    : null;
  if (Array.isArray(kinds) && !kinds.length) return null;
  return database.transaction(async (client) => {
    const now = await databaseTime(client, options);
    const expires = now + leaseMs;
    await recover(client, now);
    const candidate = await client.query(`SELECT id FROM stockchief_runtime.jobs
      WHERE status IN ('PENDING','RETRY') AND available_at <= $1
      AND ($2::text[] IS NULL OR kind = ANY($2::text[])) ORDER BY priority, created_at, id
      LIMIT 1 FOR UPDATE SKIP LOCKED`, [now, kinds]);
    if (!candidate.rows.length) return null;
    const token = newId('lease');
    const result = await client.query(`UPDATE stockchief_runtime.jobs SET status = 'RUNNING',
      attempt_count = attempt_count + 1, lease_owner = $2, lease_token = $3, lease_expires_at = $4,
      started_at = COALESCE(started_at, $5), updated_at = $5 WHERE id = $1 RETURNING *`,
    [candidate.rows[0].id, String(options.owner), token, expires, new Date(now).toISOString()]);
    await event(client, result.rows[0].id, 'CLAIMED', { owner: options.owner, leaseExpiresAt: expires }, now);
    return hydrate(result.rows[0]);
  }, { isolation: 'READ COMMITTED' });
}

async function heartbeat(database, id, token, options = {}) {
  const now = await databaseTime(database, options);
  const result = await database.query(`UPDATE stockchief_runtime.jobs SET lease_expires_at = $3, updated_at = $4
    WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING' AND lease_expires_at > $5`,
  [id, token, now + lease(options), new Date(now).toISOString(), now]);
  return result.rowCount === 1;
}

async function complete(database, id, token, outcome = {}, options = {}) {
  return database.transaction(async (client) => completeWithin(client, id, token, outcome, await databaseTime(client, options)), { isolation: 'READ COMMITTED' });
}

async function completeWithin(client, id, token, outcome, now) {
    const result = await client.query(`UPDATE stockchief_runtime.jobs SET status = 'COMPLETED', result = $3::jsonb,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
      completed_at = $4, updated_at = $4 WHERE id = $1 AND lease_token = $2
      AND status = 'RUNNING' AND lease_expires_at > $5 RETURNING id`,
    [id, token, JSON.stringify(outcome), new Date(now).toISOString(), now]);
    if (result.rowCount) await event(client, id, 'COMPLETED', { outcome }, now);
    return result.rowCount === 1;
}

async function fail(database, id, token, error, options = {}) {
  return database.transaction(async (client) => {
    const now = await databaseTime(client, options);
    const owned = await client.query(`SELECT * FROM stockchief_runtime.jobs WHERE id = $1 AND lease_token = $2
      AND status = 'RUNNING' AND lease_expires_at > $3 FOR UPDATE`, [id, token, now]);
    if (!owned.rows.length) return null;
    const row = owned.rows[0];
    const retryable = options.retryable !== false;
    const dead = !retryable || row.attempt_count >= row.max_attempts;
    const delay = options.retryAfterMs ?? Math.min(900000, 1000 * (2 ** Math.min(20, row.attempt_count - 1)));
    if (!Number.isSafeInteger(delay) || delay < 0) throw new TypeError('Invalid job retry delay.');
    const detail = { code: error?.code || 'job_failed', message: String(error?.message || 'Job failed.'), retryable };
    const result = await client.query(`UPDATE stockchief_runtime.jobs SET status = $2, available_at = $3,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = $4::jsonb,
      completed_at = $5, updated_at = $6 WHERE id = $1 RETURNING *`,
    [id, dead ? 'DEAD' : 'RETRY', dead ? now : now + delay, JSON.stringify(detail),
      dead ? new Date(now).toISOString() : null, new Date(now).toISOString()]);
    await event(client, id, dead ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED', detail, now);
    return hydrate(result.rows[0]);
  }, { isolation: 'READ COMMITTED' });
}

async function retryDead(database, id, workspaceId, options = {}) {
  return database.transaction(async (client) => {
    const now = await databaseTime(client, options);
    const result = await client.query(`UPDATE stockchief_runtime.jobs SET status = 'RETRY', available_at = $3,
      attempt_count = 0, completed_at = NULL, last_error = NULL, updated_at = $4
      WHERE id = $1 AND workspace_id IS NOT DISTINCT FROM $2 AND status = 'DEAD' RETURNING *`,
    [id, workspaceId || null, now, new Date(now).toISOString()]);
    if (!result.rows.length) return null;
    await event(client, id, 'MANUAL_RETRY', { by: options.by || 'operator' }, now);
    return hydrate(result.rows[0]);
  }, { isolation: 'READ COMMITTED' });
}

async function listDead(database, workspaceId) {
  const result = await database.query(`SELECT * FROM stockchief_runtime.jobs WHERE workspace_id = $1
    AND status = 'DEAD' ORDER BY completed_at DESC, id`, [workspaceId]);
  return result.rows.map(hydrate);
}

async function processOne(database, handlers, options = {}) {
  const kinds = Object.keys(handlers || {}).filter((kind) => typeof handlers[kind] === 'function');
  const job = await claim(database, { ...options, kinds });
  if (!job) return null;
  const handler = handlers?.[job.kind];
  if (typeof handler !== 'function') {
    return fail(database, job.id, job.leaseToken, Object.assign(new Error('No native PostgreSQL handler is registered for this job kind.'),
      { code: 'handler_missing' }), { ...options, retryable: false });
  }
  if (handler.externalEffect === true) {
    try {
      const outcome = await handler(job, database);
      if (!await complete(database, job.id, job.leaseToken, outcome || {}, options)) {
        throw Object.assign(new Error('The PostgreSQL job expired before its provider result was recorded.'), {
          code: 'lease_lost', retryable: true,
        });
      }
      return get(database, job.id, job.workspaceId);
    } catch (error) {
      return fail(database, job.id, job.leaseToken, error, {
        ...options, retryable: error.retryable !== false,
      });
    }
  }
  try {
    await database.transaction(async (client) => {
      const now = await databaseTime(client, options);
      const owned = await client.query(`SELECT id FROM stockchief_runtime.jobs WHERE id = $1 AND lease_token = $2
        AND status = 'RUNNING' AND lease_expires_at > $3 FOR UPDATE`, [job.id, job.leaseToken, now]);
      if (!owned.rows.length) throw Object.assign(new Error('The PostgreSQL worker lost its lease.'), { code: 'lease_lost' });
      const outcome = await handler(job, client);
      if (!await completeWithin(client, job.id, job.leaseToken, outcome || {}, await databaseTime(client, options))) {
        throw Object.assign(new Error('The PostgreSQL job expired before its effect could commit.'), { code: 'lease_lost' });
      }
    }, { isolation: options.isolation || 'READ COMMITTED', retrySafe: Boolean(options.retrySafe),
      statementTimeoutMs: Math.min(30000, lease(options)) });
    return get(database, job.id, job.workspaceId);
  } catch (error) {
    return fail(database, job.id, job.leaseToken, error, { ...options, retryable: error.retryable !== false });
  }
}

module.exports = { enqueue, get, claim, heartbeat, complete, fail, recoverExpired, retryDead, listDead, processOne };
