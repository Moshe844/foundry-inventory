'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const jobs = require('../../src/operations/postgres-job-queue');
const { PostgresSessionStore } = require('../../src/web/postgres-session-store');
const { fork } = require('node:child_process');
const path = require('node:path');

test('native PostgreSQL transactions and queue fencing', { timeout: 120000 }, async (context) => {
  const cluster = await startCluster();
  const database = openPostgres(cluster.connectionString);
  const second = openPostgres(cluster.connectionString);
  context.after(async () => {
    await Promise.all([database.close(), second.close()]);
    cluster.stop();
  });
  assert.deepEqual(await migratePostgres(database), ['000-business-schema.js', '001-runtime.sql',
    '002-business-operations.sql', '003-runtime-sessions.sql', '004-legacy-synthetic-evidence.sql',
    '005-complete-search-projections.sql', '006-assistant-runtime.sql', '007-job-event-order.sql',
    '008-email-reply-outbox.sql', '009-customer-return-evidence.sql', '010-supplier-return-account.sql',
    '011-provider-effects.sql','012-email-provider-effects.sql','013-payment-provider-effects.sql',
    '014-payment-deposits-refunds.sql', '015-operational-scope.sql', '016-assistant-pricing-actions.sql',
    '017-assistant-communication-actions.sql', '018-assistant-order-actions.sql',
    '019-assistant-receiving-payment-actions.sql']);
  assert.deepEqual(await migratePostgres(second), []);
  await database.query(`INSERT INTO accounts(id, email, name, password_hash, created_at)
    VALUES ('account-one', 'one@example.test', 'One', 'test', '2026-09-23T00:00:00.000Z'),
           ('account-two', 'two@example.test', 'Two', 'test', '2026-09-23T00:00:00.000Z')`);
  await database.query(`INSERT INTO workspaces(id, name, owner_account_id, created_at)
    VALUES ('workspace-one', 'One', 'account-one', '2026-09-23T00:00:00.000Z'),
           ('workspace-two', 'Two', 'account-two', '2026-09-23T00:00:00.000Z')`);
  await context.test('concurrent duplicate enqueues retain one job and its original payload', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (unused, index) => jobs.enqueue(index % 2 ? second : database,
      { workspaceId: 'workspace-one', kind: 'qualification', idempotencyKey: 'concurrent', payload: { original: true }, now: 1000 })));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.job.id)).size, 1);
    assert.equal(results[0].job.payload.original, true);
  });
  let claimed;
  await context.test('two connections cannot claim the same job', async () => {
    const results = await Promise.all([jobs.claim(database, { owner: 'worker-one', now: 1000, leaseMs: 1000 }),
      jobs.claim(second, { owner: 'worker-two', now: 1000, leaseMs: 1000 })]);
    assert.equal(results.filter(Boolean).length, 1);
    claimed = results.find(Boolean);
  });
  await context.test('expired holders cannot renew, complete or fail before recovery', async () => {
    assert.equal(await jobs.heartbeat(database, claimed.id, claimed.leaseToken, { now: 2000 }), false);
    assert.equal(await jobs.complete(database, claimed.id, claimed.leaseToken, {}, { now: 2000 }), false);
    assert.equal(await jobs.fail(database, claimed.id, claimed.leaseToken, new Error('Expired'), { now: 2000 }), null);
  });
  await context.test('recovery fences a stale attempt even when the owner name is reused', async () => {
    const recovered = await jobs.claim(second, { owner: claimed.leaseOwner, now: 2001, leaseMs: 1000 });
    assert.equal(recovered.id, claimed.id);
    assert.notEqual(recovered.leaseToken, claimed.leaseToken);
    assert.equal(await jobs.complete(database, claimed.id, claimed.leaseToken, {}, { now: 2002 }), false);
    assert.equal(await jobs.complete(second, recovered.id, recovered.leaseToken, { verified: true }, { now: 2002 }), true);
  });
  await context.test('terminal retry is workspace scoped and retains event history', async () => {
    const queued = await jobs.enqueue(database, { workspaceId: 'workspace-two', kind: 'qualification', idempotencyKey: 'dead', maxAttempts: 1, now: 3000 });
    const owned = await jobs.claim(second, { owner: 'worker-two', now: 3000 });
    await jobs.fail(second, owned.id, owned.leaseToken, new Error('Qualification only'), { now: 3001 });
    assert.equal(await jobs.retryDead(database, queued.job.id, 'workspace-one', { now: 3002 }), null);
    assert.equal((await jobs.listDead(database, 'workspace-one')).length, 0);
    assert.equal((await jobs.listDead(database, 'workspace-two')).length, 1);
    assert.equal((await jobs.retryDead(database, queued.job.id, 'workspace-two', { now: 3002, by: 'operator' })).status, 'RETRY');
    const events = await database.query('SELECT event_type FROM stockchief_runtime.job_events WHERE job_id = $1', [queued.job.id]);
    assert.deepEqual(new Set(events.rows.map((row) => row.event_type)), new Set(['ENQUEUED','CLAIMED','DEAD_LETTERED','MANUAL_RETRY']));
  });
  await context.test('rollback and immutable history prevent partial or rewritten evidence', async () => {
    await assert.rejects(database.transaction(async (client) => {
      await client.query(`INSERT INTO workspaces(id, name, created_at)
        VALUES ('must-roll-back', 'Must roll back', '2026-09-23T00:00:00.000Z')`);
      throw new Error('Abort this transaction.');
    }), /Abort/);
    assert.equal((await database.query("SELECT id FROM workspaces WHERE id = 'must-roll-back'")).rows.length, 0);
    await assert.rejects(database.query("UPDATE stockchief_runtime.job_events SET event_type = 'FAKE'"), /immutable/);
  });
  await context.test('sessions are shared, touchable, expiring and destroyable across app instances', async () => {
    const firstStore = new PostgresSessionStore(database, { sweepIntervalMs: 86400000 });
    const secondStore = new PostgresSessionStore(second, { sweepIntervalMs: 86400000 });
    const call = (store, method, ...args) => new Promise((resolve, reject) => {
      store[method](...args, (error, value) => error ? reject(error) : resolve(value));
    });
    try {
      await call(firstStore, 'set', 'shared-session', {
        accountId: 'account-one', currentWorkspaceId: 'workspace-one', cookie: { maxAge: 60000 },
      });
      assert.deepEqual(await call(secondStore, 'get', 'shared-session'), {
        accountId: 'account-one', currentWorkspaceId: 'workspace-one', cookie: { maxAge: 60000 },
      });
      const before = Number((await database.query(`SELECT expires_at FROM stockchief_runtime.sessions
        WHERE sid='shared-session'`)).rows[0].expires_at);
      await new Promise((resolve) => setTimeout(resolve, 2));
      await call(secondStore, 'touch', 'shared-session', { accountId: 'account-one', cookie: { maxAge: 120000 } });
      const after = Number((await database.query(`SELECT expires_at FROM stockchief_runtime.sessions
        WHERE sid='shared-session'`)).rows[0].expires_at);
      assert.ok(after > before);
      await database.query(`UPDATE stockchief_runtime.sessions SET expires_at=0 WHERE sid='shared-session'`);
      assert.equal(await call(firstStore, 'get', 'shared-session'), null);
      await firstStore.sweep();
      assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.sessions
        WHERE sid='shared-session'`)).rows[0].count, '0');
      await call(firstStore, 'set', 'destroy-session', { cookie: { maxAge: 60000 } });
      await call(secondStore, 'destroy', 'destroy-session');
      assert.equal(await call(firstStore, 'get', 'destroy-session'), null);
    } finally {
      await Promise.all([firstStore.close(), secondStore.close()]);
    }
  });
  await context.test('specialized workers only claim job kinds they can execute', async () => {
    const foreign = await jobs.enqueue(database, { workspaceId: 'workspace-one', kind: 'qualification.foreign',
      priority: 1, idempotencyKey: 'foreign-worker-kind' });
    const supported = await jobs.enqueue(database, { workspaceId: 'workspace-one', kind: 'qualification.supported',
      priority: 2, idempotencyKey: 'supported-worker-kind' });
    const completed = await jobs.processOne(database, {
      'qualification.supported': async () => ({ handled: true }),
    }, { owner: 'specialized-worker' });
    assert.equal(completed.id, supported.job.id);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal((await jobs.get(database, foreign.job.id, 'workspace-one')).status, 'PENDING');
  });
  await context.test('independent worker processes commit one fenced effect with its job result', async () => {
    await database.query('CREATE TABLE qualification_effects(job_id TEXT PRIMARY KEY REFERENCES stockchief_runtime.jobs(id))');
    const queued = await jobs.enqueue(database, { workspaceId: 'workspace-one', kind: 'qualification.effect', priority: 1, idempotencyKey: 'processes' });
    const run = () => new Promise((resolve, reject) => {
      const child = fork(path.resolve(__dirname, '../helpers/postgres-job-worker.js'), [], {
        env: { ...process.env, NODE_ENV: 'test', STOCKCHIEF_TEST_POSTGRES_URL: cluster.connectionString }, silent: true,
      });
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native worker qualification timed out.')); }, 30000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Native worker exited ${code}.`)); });
    });
    await Promise.all([run(), run()]);
    assert.equal((await jobs.get(database, queued.job.id, 'workspace-one')).status, 'COMPLETED');
    assert.equal((await database.query('SELECT count(*) AS count FROM qualification_effects WHERE job_id = $1', [queued.job.id])).rows[0].count, '1');
    const failed = await jobs.enqueue(database, { workspaceId: 'workspace-one', kind: 'qualification.rollback', priority: 1, idempotencyKey: 'atomic-rollback' });
    await jobs.processOne(database, { 'qualification.rollback': async (job, client) => {
      await client.query('INSERT INTO qualification_effects(job_id) VALUES ($1)', [job.id]);
      throw Object.assign(new Error('Abort domain effect.'), { retryable: false });
    } }, { owner: 'rollback-worker' });
    assert.equal((await jobs.get(database, failed.job.id, 'workspace-one')).status, 'DEAD');
    assert.equal((await database.query('SELECT job_id FROM qualification_effects WHERE job_id = $1', [failed.job.id])).rows.length, 0);
  });
});
