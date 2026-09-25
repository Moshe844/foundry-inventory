'use strict';

const crypto = require('node:crypto');
const config = require('../src/config');
const { openPostgres } = require('../src/db/postgres');
const auth = require('../src/domain/postgres-auth-service');
const middleware = require('../src/web/postgres-auth-middleware');
const jobs = require('../src/operations/postgres-job-queue');
const checkpoints = require('../src/operations/postgres-checkpoints');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function invoke(handler, request) {
  const response = { locals: {} };
  return new Promise((resolve, reject) => handler(request, response, (error) => (
    error ? reject(error) : resolve({ request, response })
  )));
}

async function main() {
  const connectionString = process.env.FOUNDRY_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('FOUNDRY_DATABASE_URL is required.');
  const database = openPostgres(connectionString, { applicationName: 'stockchief-adversarial', max: 20 });
  const second = openPostgres(connectionString, { applicationName: 'stockchief-adversarial-second', max: 10 });
  const runId = crypto.randomUUID();
  const emailA = `cert-a-${runId}@example.test`;
  const emailB = `cert-b-${runId}@example.test`;
  let first;
  let secondBusiness;
  try {
    first = await auth.createBusiness(database, {
      name: 'Certification Owner A', businessName: `Certification A ${runId}`,
      email: emailA, password: `Cert-${runId}-A!`,
    });
    secondBusiness = await auth.createBusiness(database, {
      name: 'Certification Owner B', businessName: `Certification B ${runId}`,
      email: emailB, password: `Cert-${runId}-B!`,
    });

    const loaded = await invoke(middleware.loadUser(database), {
      session: { accountId: first.accountId, workspaceId: secondBusiness.workspaceId },
    });
    assert(loaded.request.ctx.accountId === first.accountId, 'The authenticated account changed.');
    assert(loaded.request.ctx.workspaceId === first.workspaceId, 'A foreign workspace was trusted.');
    assert(loaded.request.session.workspaceId === first.workspaceId, 'The unsafe tenant session was not repaired.');
    assert(loaded.response.locals.workspaces.length === 1, 'A foreign workspace leaked into the inventory list.');
    assert(await auth.resolveForAccount(database, first.accountId, secondBusiness.workspaceId) === null,
      'Account A resolved Account B inventory.');
    let permissionDenied = false;
    try {
      await auth.renameWorkspace(database, { workspaceId: secondBusiness.workspaceId, actorId: first.userId }, 'Unsafe rename');
    } catch (error) {
      permissionDenied = /not found|could not be renamed/i.test(String(error.message));
    }
    assert(permissionDenied, 'A foreign owner changed another inventory.');

    const kind = `certification.adversarial.${runId}`;
    const enqueued = await Promise.all(Array.from({ length: 20 }, (_, index) => jobs.enqueue(index % 2 ? second : database, {
      workspaceId: first.workspaceId, kind, idempotencyKey: `duplicate:${runId}`, payload: { original: true }, now: 1000,
    })));
    assert(enqueued.filter((entry) => entry.created).length === 1,
      'Concurrent duplicate enqueue created more than one job.');
    assert(new Set(enqueued.map((entry) => entry.job.id)).size === 1, 'Duplicate enqueue returned different jobs.');

    const claims = await Promise.all([
      jobs.claim(database, { owner: `first-${runId}`, kinds: [kind], now: 1000, leaseMs: 1000 }),
      jobs.claim(second, { owner: `second-${runId}`, kinds: [kind], now: 1000, leaseMs: 1000 }),
    ]);
    assert(claims.filter(Boolean).length === 1, 'Two workers claimed one job.');
    const stale = claims.find(Boolean);
    const recovered = await jobs.claim(second, { owner: stale.leaseOwner, kinds: [kind], now: 2001, leaseMs: 1000 });
    assert(recovered && recovered.id === stale.id, 'An expired job was not recovered after a worker crash.');
    assert(recovered.leaseToken !== stale.leaseToken, 'Crash recovery reused a stale fencing token.');
    assert(await jobs.complete(database, stale.id, stale.leaseToken, { stale: true }, { now: 2002 }) === false,
      'A crashed worker committed with a stale lease.');
    assert(await jobs.complete(second, recovered.id, recovered.leaseToken, { verified: true }, { now: 2002 }) === true,
      'The recovered worker could not commit exactly once.');
    const finalJob = await jobs.get(database, stale.id, first.workspaceId);
    assert(finalJob.status === 'COMPLETED' && finalJob.result.verified === true && !finalJob.result.stale,
      'Recovered job did not retain the verified result exactly once.');

    const rollbackMarker = `cert-rollback-${runId}`;
    await database.transaction(async (client) => {
      await client.query(`INSERT INTO operational_alerts
        (id,workspace_id,severity,kind,title,detail,fingerprint,status,first_seen_at,last_seen_at)
        VALUES($1,$2,'WARNING','certification.rollback','Rollback marker','Must roll back',$3,'OPEN',$4,$4)`,
      [rollbackMarker, first.workspaceId, rollbackMarker, new Date().toISOString()]);
      throw new Error('Intentional certification rollback');
    }).then(() => { throw new Error('The intentional rollback unexpectedly committed.'); }, (error) => {
      if (!/Intentional certification rollback/.test(error.message)) throw error;
    });
    assert(Number((await database.query('SELECT COUNT(*) AS count FROM operational_alerts WHERE id=$1',
      [rollbackMarker])).rows[0].count) === 0, 'A failed transaction left partial state.');

    const detail = {
      runId,
      tenantIsolation: true,
      permissions: true,
      concurrency: true,
      duplicateDelivery: true,
      crashMidAction: true,
      managedPostgres: true,
      releaseRef: config.operations.releaseRef,
    };
    await checkpoints.record(database, 'adversarial.runtime', 'PASS', detail);
    console.log(JSON.stringify(detail, null, 2));
  } finally {
    const accountIds = [first?.accountId, secondBusiness?.accountId].filter(Boolean);
    const workspaceIds = [first?.workspaceId, secondBusiness?.workspaceId].filter(Boolean);
    if (accountIds.length) await database.query('UPDATE accounts SET last_workspace_id=NULL WHERE id = ANY($1::text[])',
      [accountIds]);
    if (workspaceIds.length) await database.query('DELETE FROM workspaces WHERE id = ANY($1::text[])', [workspaceIds]);
    if (accountIds.length) await database.query('DELETE FROM accounts WHERE id = ANY($1::text[])', [accountIds]);
    await Promise.all([database.close(), second.close()]);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
