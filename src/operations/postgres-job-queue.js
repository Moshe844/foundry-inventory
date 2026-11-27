'use strict';

const documentRecovery = new Map([
  ['import.discover-filed-document.v1', () => require('../documents/agent-document-discovery')],
  ['import.variant-sheet.v1', () => require('../imports/agent-exact-variant-import')],
  ['import.physical-count-source.v1', () => require('../imports/physical-count-sources')],
  ['import.read-contract.v1', () => require('../documents/agent-contract-reader')],
  ['import.read-shipping-document.v1', () => require('../documents/agent-shipping-document-reader')],
  ['import.read-shelf-photo.v1', () => require('../warehouse/agent-shelf-photos')],
  ['import.read-sop.v1', () => require('../documents/agent-sop-sources')],
  ['import.read-voice-receipt.v1', () => require('../documents/agent-voice-receiving')],
  ['import.voice-paperwork.v1', () => require('../documents/agent-voice-paperwork')],
]);

const { newId } = require('../lib/util');
const MAINTENANCE_KINDS = Object.freeze(['autopilot.evaluate', 'system.reconcile-business']);
const GUARD_REQUIRED_KINDS = Object.freeze([
  ...MAINTENANCE_KINDS, 'assistant.run-goal', 'assistant.run-codex-goal', 'assistant.run-codex-read',
]);

function hydrate(row) {
  if (!row) return null;
  return { id: row.id, workspaceId: row.workspace_id, kind: row.kind, payload: row.payload,
    status: row.status, priority: row.priority, attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    availableAt: Number(row.available_at), leaseOwner: row.lease_owner, leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    createdAt: row.created_at, idempotencyKey: row.idempotency_key, result: row.result, lastError: row.last_error };
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
  const now = input.now === undefined ? null : time(input);
  const priority = input.priority ?? 100;
  const attempts = input.maxAttempts ?? 5;
  const availableAt = input.availableAt ?? null;
  if (!Number.isSafeInteger(priority) || !Number.isSafeInteger(attempts) || attempts < 1
    || (availableAt !== null && (!Number.isSafeInteger(availableAt) || availableAt < 0))) throw new TypeError('Invalid durable job scheduling values.');
  // The job and its first event commit in the same SQL statement. A caller
  // with a surrounding business transaction still supplies its own client.
  const inserted = await database.query(`WITH job_clock AS MATERIALIZED (
      SELECT COALESCE($9::bigint, floor(extract(epoch FROM clock_timestamp())*1000)::bigint) AS now_ms
    ), inserted AS (
      INSERT INTO stockchief_runtime.jobs
      (id, workspace_id, kind, payload, priority, max_attempts, available_at, idempotency_key, created_at, updated_at)
      SELECT $1,$2,$3,$4::jsonb,$5,$6,COALESCE($7::bigint,now_ms),$8,
        to_timestamp(now_ms/1000.0),to_timestamp(now_ms/1000.0) FROM job_clock
      ON CONFLICT DO NOTHING RETURNING *
    ), history AS (
      INSERT INTO stockchief_runtime.job_events(id,job_id,event_type,detail,created_at)
      SELECT $10,id,'ENQUEUED',jsonb_build_object('availableAt',available_at),created_at FROM inserted
    ) SELECT * FROM inserted`,
    [input.id || newId('rjob'), input.workspaceId || null, input.kind, JSON.stringify(input.payload || {}),
      priority, attempts, availableAt, input.idempotencyKey, now, newId('jobevt')]);
  if (inserted.rows.length) return { job: hydrate(inserted.rows[0]), created: true };
  // Bind every leading unique-index key. IS NOT DISTINCT FROM prevents
  // PostgreSQL from narrowing the middle workspace key in large histories.
  const scoped=Boolean(input.workspaceId);
  const prior = await database.query(`SELECT * FROM stockchief_runtime.jobs
    WHERE kind = $1 AND ${scoped?'workspace_id = $2':'workspace_id IS NULL'} AND idempotency_key = ${scoped?'$3':'$2'}`,
    scoped?[input.kind,input.workspaceId,input.idempotencyKey]:[input.kind,input.idempotencyKey]);
  if (!prior.rows.length) throw new Error('Job ID conflicts with a different idempotency key.');
  return { job: hydrate(prior.rows[0]), created: false };
}

async function recover(client, now) {
  const expired = await client.query(`SELECT * FROM stockchief_runtime.jobs
    WHERE status = 'RUNNING' AND lease_expires_at <= $1 FOR UPDATE SKIP LOCKED`, [now]);
  for (const row of expired.rows) {
    if(['import.analyse-source','import.analyse-source.aws','import.analyse-handwriting.v1'].includes(row.kind)){
      const receipt=(await client.query(`SELECT u.id,u.plan_id FROM import_source_uploads u JOIN import_plans p ON p.id=u.plan_id AND p.workspace_id=u.workspace_id AND p.source_hash=u.source_hash WHERE u.job_id=$1 AND u.workspace_id=$2 AND u.id=$3 AND u.actor_id=$4`,[row.id,row.workspace_id,row.payload?.uploadId,row.payload?.actorId])).rows[0];
      if(receipt){await client.query(`UPDATE stockchief_runtime.jobs SET status='COMPLETED',result=$2::jsonb,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,completed_at=$3,updated_at=$3 WHERE id=$1`,[row.id,JSON.stringify({uploadId:receipt.id,planId:receipt.plan_id,recovered:true}),new Date(now).toISOString()]);await event(client,row.id,'COMPLETION_RECOVERED',{planId:receipt.plan_id},now);continue;}
    }
    if(row.kind==='import.analyse-handwriting.v1'){
      const source=(await client.query('SELECT input_options,source_hash FROM import_source_uploads WHERE job_id=$1 AND workspace_id=$2 AND plan_id IS NULL',[row.id,row.workspace_id])).rows[0];
      if(source){const reader=require('../imports/handwritten-table'),readingAttempt=require('node:crypto').createHash('sha256').update(row.lease_token||row.id).digest('hex').slice(0,20);await reader.refund(client,{workspaceId:row.workspace_id,actorId:row.payload?.actorId},reader.creditPrefix({...source.input_options,readingAttempt},source.source_hash));}
    }
    const recoverDocument = documentRecovery.get(row.kind);
    if (recoverDocument) {
      const result=await recoverDocument().recover(client,hydrate(row));
      if(result){await client.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED',result=$2::jsonb,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,completed_at=$3,updated_at=$3 WHERE id=$1",[row.id,JSON.stringify(result),new Date(now).toISOString()]);await event(client,row.id,'COMPLETION_RECOVERED',result,now);continue;}
    }
    const dead = row.attempt_count >= row.max_attempts;
    await client.query(`UPDATE stockchief_runtime.jobs SET status = $2, available_at = $3,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
      last_error = $4::jsonb, completed_at = $5, updated_at = $6 WHERE id = $1`,
    [row.id, dead ? 'DEAD' : 'RETRY', now, JSON.stringify({ code: 'lease_expired', message: 'Worker stopped before completion.' }),
      dead ? new Date(now).toISOString() : null, new Date(now).toISOString()]);
    await event(client, row.id, dead ? 'DEAD_LETTERED' : 'LEASE_RECOVERED', { previousOwner: row.lease_owner }, now);
    if(dead)await require('./postgres-reconciliation').failedJob(client,hydrate(row),{code:'lease_expired'});
  }
  return expired.rows.length;
}

function recoverExpired(database, options = {}) {
  return database.transaction(async (client) => recover(client, await databaseTime(client, options)), { isolation: 'READ COMMITTED' });
}

const claimClock = `SELECT now_ms, EXISTS(SELECT 1 FROM stockchief_runtime.jobs
  WHERE status = 'RUNNING' AND lease_expires_at <= now_ms) AS expired FROM job_clock`;

// With `serial`, a job waits while the same business already has a job of the same
// kind running, so a worker that runs several jobs at once never runs two of one
// business's jobs of the same kind side by side (one slot never could).
const SERIAL_PER_BUSINESS_KIND = `
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs running WHERE running.status='RUNNING'
      AND running.kind=jobs.kind AND running.workspace_id=jobs.workspace_id)
    AND (jobs.workspace_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs running
      WHERE running.status='RUNNING' AND running.kind=jobs.kind AND running.workspace_id IS NULL))`;

function selectCandidate(ordering, availableBefore, serial = false) {
  return `SELECT id,kind,workspace_id FROM stockchief_runtime.jobs
    WHERE status IN ('PENDING','RETRY') AND available_at <= ${availableBefore}
    AND (workspace_id IS NULL OR EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=jobs.workspace_id AND w.deletion_requested_at IS NULL
      AND (w.owner_account_id IS NULL OR EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=w.owner_account_id
        AND NOT EXISTS(SELECT 1 FROM public.platform_account_access access WHERE access.account_id=a.id AND access.disabled_at IS NOT NULL) FOR KEY SHARE SKIP LOCKED)) FOR KEY SHARE SKIP LOCKED))
    AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
    AND (workspace_id IS NULL OR public.commercial_job_lane_available(workspace_id,kind))
    AND (kind NOT IN('import.execute-approved','assistant.run-codex-goal','assistant.run-codex-read') OR NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs active
      WHERE active.workspace_id=jobs.workspace_id AND (active.kind=jobs.kind OR
       jobs.kind IN('assistant.run-codex-goal','assistant.run-codex-read') AND active.kind IN('assistant.run-codex-goal','assistant.run-codex-read')) AND active.status='RUNNING'))
    AND (NOT(kind=ANY($3::text[])) OR NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs active
      WHERE active.workspace_id=jobs.workspace_id AND active.kind=ANY($3::text[]) AND active.status='RUNNING'))${serial ? SERIAL_PER_BUSINESS_KIND : ''}
    ORDER BY ${ordering}
    LIMIT 1 FOR UPDATE SKIP LOCKED`;
}

const recordClaim = `claimed AS (
  UPDATE stockchief_runtime.jobs SET status = 'RUNNING',
    attempt_count = attempt_count + 1, lease_owner = claim_input.owner, lease_token = claim_input.token,
    lease_expires_at = claim_input.now_ms + claim_input.lease_ms,
    started_at = COALESCE(started_at, to_timestamp(claim_input.now_ms/1000.0)),
    updated_at = to_timestamp(claim_input.now_ms/1000.0)
  FROM claim_input WHERE jobs.id = claim_input.job_id RETURNING jobs.*
), history AS (
  INSERT INTO stockchief_runtime.job_events(id,job_id,event_type,detail,created_at)
  SELECT claim_input.event_id,claimed.id,'CLAIMED',jsonb_build_object('owner',claim_input.event_owner,
    'leaseExpiresAt',claimed.lease_expires_at,
    'queueWaitMs',GREATEST(0,claim_input.now_ms-GREATEST(claimed.available_at,floor(extract(epoch FROM claimed.created_at)*1000)::bigint))),
    claimed.updated_at FROM claimed CROSS JOIN claim_input
)`;

async function claimOrdinary(database, options, { ordering, suppliedNow, kinds, leaseMs }) {
  // The scheduler selects the same first candidate as the guarded path.
  // Expired leases and candidates requiring advisory locks use that path.
  // For an ordinary job, its row lock, lease and history commit together.
  const result = await database.query(`WITH job_clock AS MATERIALIZED (
    SELECT COALESCE($1::bigint, floor(extract(epoch FROM clock_timestamp())*1000)::bigint) AS now_ms
  ), recovery_clock AS MATERIALIZED (
    ${claimClock}
  ), candidate AS MATERIALIZED (
    ${selectCandidate(ordering, '(SELECT now_ms FROM recovery_clock WHERE NOT expired)', options.serialPerBusinessKind === true)}
  ), claim_input AS MATERIALIZED (
    SELECT candidate.id AS job_id, $4::text AS owner, $5::text AS token, recovery_clock.now_ms,
      $6::bigint AS lease_ms, $7::text AS event_id, $8::jsonb AS event_owner
    FROM candidate CROSS JOIN recovery_clock
    WHERE candidate.kind NOT LIKE 'import.%' AND NOT(candidate.kind=ANY($9::text[]))
  ), ${recordClaim}
  SELECT claimed.*, recovery_clock.expired OR EXISTS(SELECT 1 FROM candidate) AS needs_guarded_claim
  FROM recovery_clock LEFT JOIN claimed ON true`,
  [suppliedNow, kinds, MAINTENANCE_KINDS, String(options.owner), newId('lease'),
    leaseMs, newId('jobevt'), JSON.stringify(options.owner), GUARD_REQUIRED_KINDS]);
  return result.rows[0];
}

async function claim(database, options = {}) {
  if (!options.owner) throw new TypeError('A PostgreSQL worker needs an explicit owner identity.');
  const leaseMs = lease(options);
  const kinds = Array.isArray(options.kinds)
    ? [...new Set(options.kinds.map((kind) => String(kind || '').trim()).filter(Boolean))]
    : null;
  if (Array.isArray(kinds) && !kinds.length) return null;
  // Ordinary lanes can use the existing runnable-priority index directly.
  // Preserve FIFO for maintenance and its synthetic priority in mixed lanes.
  const ordering = options.maintenanceOnly === true ? 'created_at, id'
    : kinds && kinds.every(kind => !MAINTENANCE_KINDS.includes(kind)) ? 'priority, created_at, id'
      : 'CASE WHEN kind=ANY($3::text[]) THEN 50 ELSE priority END, created_at, id';
  const suppliedNow = options.now === undefined ? null : time(options);
  if (!kinds || kinds.some(kind => !kind.startsWith('import.') && !GUARD_REQUIRED_KINDS.includes(kind))) {
    const ordinary = await claimOrdinary(database, options, { ordering, suppliedNow, kinds, leaseMs });
    if (ordinary.id) return hydrate(ordinary);
    if (!ordinary.needs_guarded_claim) return null;
  }
  return database.transaction(async (client) => {
    const clock = (await client.query(`WITH job_clock AS MATERIALIZED (
      SELECT COALESCE($1::bigint, floor(extract(epoch FROM clock_timestamp())*1000)::bigint) AS now_ms
    ) ${claimClock}`, [suppliedNow])).rows[0];
    const now = Number(clock.now_ms);
    if (clock.expired) await recover(client, now);
    const candidate = await client.query(selectCandidate(ordering, '$1', options.serialPerBusinessKind === true), [now, kinds, MAINTENANCE_KINDS]);
    if (!candidate.rows.length) return null;
    const selected=candidate.rows[0];
    if(selected.kind.startsWith('import.')||['assistant.run-goal','assistant.run-codex-goal','assistant.run-codex-read'].includes(selected.kind)){
      const owner=(await client.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[selected.workspace_id])).rows[0]?.owner_account_id;
      const lane=selected.kind.startsWith('import.')?'imports':'agents';
      if(owner){const locked=(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`jobs-account:${owner}:${lane}`])).rows[0].acquired;
        if(!locked||!(await client.query('SELECT public.commercial_job_lane_available($1,$2) AS available',[selected.workspace_id,selected.kind])).rows[0].available)return null;}
    }
    const maintenance=MAINTENANCE_KINDS.includes(selected.kind);
    if(['import.execute-approved','assistant.run-codex-goal','assistant.run-codex-read'].includes(selected.kind)||maintenance){
      // The transaction lock closes the race between independent workers
      // that both observed an inventory with no running import.
      const locked=(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
        ['jobs:'+(maintenance?'maintenance:':selected.kind.startsWith('assistant.')?'ask:':'import:')+selected.workspace_id])).rows[0].acquired;
      if(!locked)return null;
      const active=await client.query(`SELECT 1 FROM stockchief_runtime.jobs
        WHERE workspace_id=$1 AND kind=ANY($2::text[]) AND status='RUNNING' LIMIT 1`,
        [selected.workspace_id,maintenance?MAINTENANCE_KINDS:selected.kind.startsWith('assistant.')?['assistant.run-codex-goal','assistant.run-codex-read']:[selected.kind]]);
      if(active.rows.length)return null;
    }
    const result = await client.query(`WITH claim_input AS MATERIALIZED (
      SELECT $1::text AS job_id, $2::text AS owner, $3::text AS token, $4::bigint AS now_ms,
        $5::bigint AS lease_ms, $6::text AS event_id, $7::jsonb AS event_owner
    ), ${recordClaim} SELECT * FROM claimed`,
    [selected.id, String(options.owner), newId('lease'), now, leaseMs, newId('jobevt'), JSON.stringify(options.owner)]);
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
  return Boolean(await completeJob(database, id, token, outcome, options));
}

function completeJob(database, id, token, outcome, options) {
  return completeWithin(database, id, token, outcome, options);
}

async function completeWithin(client, id, token, outcome, options) {
  const now = options.now === undefined ? null : time(options);
  const result = await client.query(`WITH job_clock AS MATERIALIZED (
    SELECT COALESCE($4::bigint, floor(extract(epoch FROM clock_timestamp())*1000)::bigint) AS now_ms
  ), completed AS (
    UPDATE stockchief_runtime.jobs SET status = 'COMPLETED', result = $3::jsonb,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
      completed_at = to_timestamp(now_ms/1000.0), updated_at = to_timestamp(now_ms/1000.0)
    FROM job_clock WHERE id = $1 AND lease_token = $2
      AND status = 'RUNNING' AND lease_expires_at > now_ms RETURNING jobs.*
  ), history AS (
    INSERT INTO stockchief_runtime.job_events(id,job_id,event_type,detail,created_at)
    SELECT $5,id,'COMPLETED',jsonb_build_object('outcome',result),completed_at FROM completed
  ) SELECT * FROM completed`, [id, token, JSON.stringify(outcome), now, newId('jobevt')]);
  return hydrate(result.rows[0]);
}

async function fail(database, id, token, error, options = {}) {
  return database.transaction(async (client) => {
    const now = await databaseTime(client, options);
    const owned = await client.query(`SELECT * FROM stockchief_runtime.jobs WHERE id = $1 AND lease_token = $2
      AND status = 'RUNNING' AND lease_expires_at > $3 FOR UPDATE`, [id, token, now]);
    if (!owned.rows.length) return null;
    const row = owned.rows[0];
    // PostgreSQL disk_full needs operator recovery, not another immediate
    // write attempt. Keep the checkpoint and allow an explicit retry only
    // after capacity is restored. Connection/recovery errors remain retryable.
    const retryable = options.retryable !== false && error?.code !== '53100';
    const commercialPause=error?.code==='entitlement_required';
    const dead = !commercialPause&&(!retryable || row.attempt_count >= row.max_attempts);
    const delay = options.retryAfterMs ?? Math.min(900000, 1000 * (2 ** Math.min(20, row.attempt_count - 1)));
    if (!Number.isSafeInteger(delay) || delay < 0) throw new TypeError('Invalid job retry delay.');
    const detail = { code: error?.code || 'job_failed', message: String(error?.message || 'Job failed.'), retryable,
      details:commercialPause?error.details:undefined,
      // A provider's own status (for example 429 or 503) tells throttling from an outage.
      httpStatus:Number.isInteger(error?.httpStatus)?error.httpStatus:undefined };
    const result = await client.query(`UPDATE stockchief_runtime.jobs SET status = $2, available_at = $3,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_error = $4::jsonb,
      completed_at = $5, updated_at = $6 WHERE id = $1 RETURNING *`,
    [id, commercialPause?'PAUSED':dead ? 'DEAD' : 'RETRY', dead ? now : now + delay, JSON.stringify(detail),
      dead ? new Date(now).toISOString() : null, new Date(now).toISOString()]);
    if(commercialPause)await client.query('UPDATE stockchief_runtime.jobs SET attempt_count=GREATEST(attempt_count-1,0) WHERE id=$1',[id]);
    await event(client, id, commercialPause?'COMMERCIAL_PAUSED':dead ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED', detail, now);
    if(dead)await require('./postgres-reconciliation').failedJob(client,hydrate(row),error);
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

function renewWhileRunning(database, job, options) {
  // External handlers do not hold a transaction lock. Cleanup and provider
  // requests can legitimately outlive the initial claim, so renew only this
  // attempt's live lease until its outcome has been recorded.
  const leaseMs = lease(options), intervalMs = Math.max(100, Math.min(5000, Math.floor(leaseMs / 3)));
  let stopped = false, timer, failure = null, pending = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      pending = heartbeat(database, job.id, job.leaseToken, { ...options, leaseMs }).then(owned => {
        if (!owned) failure = Object.assign(new Error('The PostgreSQL worker lost its execution lease.'), { code: 'lease_lost' });
      }).catch(error => { failure = error; }).finally(() => {
        if (!stopped && !failure) schedule();
      });
    }, intervalMs);
    timer.unref();
  };
  schedule();
  return {
    async check() { await pending; if (failure) throw failure; },
    async stop() { stopped = true; clearTimeout(timer); await pending; },
  };
}

async function processOne(database, handlers, options = {}) {
  const requested=Array.isArray(options.kinds)?new Set(options.kinds.map(kind=>String(kind||'').trim()).filter(Boolean)):null;
  const kinds = Object.keys(handlers || {}).filter((kind) => typeof handlers[kind] === 'function' &&
    (!requested || requested.has(kind)));
  const maintenanceOnly = kinds.length > 0 && kinds.every(kind => handlers[kind].workerLane === 'maintenance');
  const job = await claim(database, { ...options, kinds, maintenanceOnly });
  if (!job) return null;
  const handler = handlers?.[job.kind];
  if (typeof handler !== 'function') {
    return fail(database, job.id, job.leaseToken, Object.assign(new Error('No native PostgreSQL handler is registered for this job kind.'),
      { code: 'handler_missing' }), { ...options, retryable: false });
  }
  if (handler.externalEffect === true) {
    const renewal = renewWhileRunning(database, job, options);
    try {
      const scope=job.workspaceId?await require('../commercial/entitlements').ownerScopeForWorkspace(database,job.workspaceId):null;
      const outcome = await require('../commercial/resource-metrics').measure(database,{runtimeKind:'worker',operation:job.kind,
        id:`${job.id}:${job.attemptCount}:${job.leaseToken}`,scope:scope||{accountId:job.payload?.accountId}},()=>
        require('../commercial/context').run({database,scope,requestId:job.id,attemptCount:Number(job.attemptCount)},()=>handler(job, database)));
      await renewal.check();
      const completed = await completeJob(database, job.id, job.leaseToken, outcome || {}, options);
      if (!completed) {
        throw Object.assign(new Error('The PostgreSQL job expired before its provider result was recorded.'), {
          code: 'lease_lost', retryable: true,
        });
      }
      return completed;
    } catch (error) {
      return fail(database, job.id, job.leaseToken, error, {
        ...options, retryable: error.retryable !== false,
        ...(Number.isFinite(error.retryAfterMs)&&error.retryAfterMs>0?{retryAfterMs:error.retryAfterMs}:{}),
      });
    } finally { await renewal.stop(); }
  }
  try {
    const suppliedNow = options.now === undefined ? null : time(options);
    return await require('../commercial/resource-metrics').measure(database,{runtimeKind:'worker',operation:job.kind,
      id:`${job.id}:${job.attemptCount}:${job.leaseToken}`,scope:{accountId:job.payload?.accountId}},()=>database.transaction(async (client) => {
      const owned = await client.query(`SELECT id FROM stockchief_runtime.jobs WHERE id = $1 AND lease_token = $2
        AND status = 'RUNNING' AND lease_expires_at >
        COALESCE($3::bigint, floor(extract(epoch FROM clock_timestamp())*1000)::bigint) FOR UPDATE`,
      [job.id, job.leaseToken, suppliedNow]);
      if (!owned.rows.length) throw Object.assign(new Error('The PostgreSQL worker lost its lease.'), { code: 'lease_lost' });
      const scope=job.workspaceId?await require('../commercial/entitlements').ownerScopeForWorkspace(client,job.workspaceId):null;
      const outcome = await require('../commercial/context').run({database:client,scope,requestId:job.id,attemptCount:Number(job.attemptCount)},()=>handler(job, client));
      const completed = await completeWithin(client, job.id, job.leaseToken, outcome || {}, options);
      if (!completed) {
        throw Object.assign(new Error('The PostgreSQL job expired before its effect could commit.'), { code: 'lease_lost' });
      }
      return completed;
    }, { isolation: options.isolation || 'READ COMMITTED', retrySafe: Boolean(options.retrySafe),
      statementTimeoutMs: Math.min(30000, lease(options)) }));
  } catch (error) {
    return fail(database, job.id, job.leaseToken, error, { ...options, retryable: error.retryable !== false });
  }
}

async function reconcileVerifiedEffectWithin(client,workspaceId,effectId){
 const now=Date.now(),result=await client.query("UPDATE stockchief_runtime.jobs job SET status='COMPLETED',result=$3::jsonb,last_error=NULL,completed_at=$4,updated_at=$4 FROM stockchief_runtime.provider_effects effect WHERE effect.workspace_id=$1 AND effect.id=$2 AND effect.status='SUCCEEDED' AND job.workspace_id=effect.workspace_id AND job.kind=ANY($5::text[]) AND job.payload->>'effectId'=effect.id AND job.status='DEAD' RETURNING job.id",[workspaceId,effectId,JSON.stringify({verified:true,effectId,readOnlyRecovery:true}),new Date(now).toISOString(),['provider.effect',require('./agent-return-refund-protocol').JOB,...require('./agent-mail-protocol').kinds]]);
 for(const row of result.rows)await event(client,row.id,'VERIFICATION_RECOVERED',{effectId,readOnlyRecovery:true},now);
 return result.rows.length;
}
module.exports = { MAINTENANCE_KINDS, enqueue, get, claim, heartbeat, complete, fail, recoverExpired, retryDead, listDead, processOne,reconcileVerifiedEffectWithin };
