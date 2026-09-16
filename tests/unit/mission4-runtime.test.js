'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll } = require('../helpers');
const jobs = require('../../src/operations/job-queue');
const inbox = require('../../src/operations/inbox');
const outbox = require('../../src/operations/outbox');
const monitoring = require('../../src/operations/monitoring');
const recovery = require('../../src/domain/password-recovery');
const email = require('../../src/operations/email');
const foundryJobs = require('../../src/foundry/job-runner');
const retention = require('../../src/operations/retention');
const readiness = require('../../src/operations/readiness');
const checkpoints = require('../../src/operations/checkpoints');
const backups = require('../../src/operations/backup');
const config = require('../../src/config');

test.after(() => cleanupAll());

test('durable jobs are idempotent, exclusively leased and recover after a crash', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Mission 4 queue' });
  const first = jobs.enqueue(db, {
    workspaceId: workspace.workspaceId,
    kind: 'test.effect', idempotencyKey: 'effect:1', payload: { value: 7 }, maxAttempts: 3, now: 1_000,
  });
  const duplicate = jobs.enqueue(db, {
    workspaceId: workspace.workspaceId,
    kind: 'test.effect', idempotencyKey: 'effect:1', payload: { value: 99 }, now: 1_000,
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, first.job.id);

  const claimed = jobs.claim(db, { owner: 'worker-a', now: 1_000, leaseMs: 1_000 });
  assert.equal(claimed.id, first.job.id);
  assert.equal(jobs.claim(db, { owner: 'worker-b', now: 1_000 }), null);

  const recovered = jobs.recoverExpired(db, { now: 2_001 });
  assert.deepEqual(recovered, { recovered: 1, retried: 1, dead: 0 });
  const reclaimed = jobs.claim(db, { owner: 'worker-b', now: 2_001, leaseMs: 1_000 });
  assert.equal(reclaimed.attemptCount, 2);
  assert.equal(jobs.complete(db, reclaimed.id, 'worker-a', {}), false, 'the stale worker cannot commit');
  assert.equal(jobs.complete(db, reclaimed.id, 'worker-b', { applied: true }, { now: 2_002 }), true);
  assert.equal(jobs.get(db, first.job.id).status, 'COMPLETED');
});

test('a crash-mid-action retry cannot duplicate an idempotent domain effect', async () => {
  const { db } = makeDatabase();
  db.exec('CREATE TABLE test_effects (effect_key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  const queued = jobs.enqueue(db, {
    kind: 'test.crash', idempotencyKey: 'crash:1', payload: { key: 'one' }, maxAttempts: 3, now: 10_000,
  }).job;
  let calls = 0;
  const handler = async (job) => {
    db.prepare('INSERT OR IGNORE INTO test_effects (effect_key, value) VALUES (?, ?)').run(job.payload.key, 1);
    calls += 1;
    if (calls === 1) throw new Error('simulated process failure after effect');
    return { verified: true };
  };
  const failed = await jobs.processOne(db, { 'test.crash': handler }, {
    owner: 'worker-a', now: 10_000, retryAfterMs: 1,
  });
  assert.equal(failed.status, 'RETRY');
  const completed = await jobs.processOne(db, { 'test.crash': handler }, {
    owner: 'worker-b', now: 10_002,
  });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_effects').get().n, 1);
  assert.equal(jobs.get(db, queued.id).attemptCount, 2);
});

test('inbox processes a provider event exactly once and detects payload conflicts', () => {
  const { db } = makeDatabase();
  assert.equal(inbox.receive(db, 'stripe', 'evt_1', { amount: 25 }).duplicate, false);
  assert.equal(inbox.receive(db, 'stripe', 'evt_1', { amount: 25 }).duplicate, true);
  assert.equal(inbox.receive(db, 'stripe', 'evt_1', { amount: 30 }).conflict, true);
  let effects = 0;
  const one = inbox.process(db, 'stripe', 'evt_1', (payload) => { effects += 1; return payload; });
  const two = inbox.process(db, 'stripe', 'evt_1', () => { effects += 1; });
  assert.equal(one.duplicate, false);
  assert.equal(two.duplicate, true);
  assert.equal(effects, 1);
});

test('outbox retries transient delivery and dead-letters permanent delivery', async () => {
  const { db } = makeDatabase();
  const transient = outbox.enqueue(db, {
    destination: 'test', messageType: 'notice', idempotencyKey: 'notice:1', maxAttempts: 2, now: 20_000,
  }).message;
  let calls = 0;
  const dispatcher = async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary');
    return { accepted: true };
  };
  assert.equal((await outbox.processOne(db, { test: dispatcher }, {
    owner: 'worker-a', now: 20_000, retryAfterMs: 1,
  })).status, 'RETRY');
  assert.equal((await outbox.processOne(db, { test: dispatcher }, {
    owner: 'worker-b', now: 20_002,
  })).status, 'DELIVERED');
  assert.equal(outbox.get(db, transient.id).attemptCount, 2);

  const permanent = outbox.enqueue(db, {
    destination: 'missing', messageType: 'notice', idempotencyKey: 'notice:2', now: 30_000,
  }).message;
  assert.equal((await outbox.processOne(db, {}, { owner: 'worker-c', now: 30_000 })).status, 'DEAD');
  assert.equal(outbox.retryDead(db, permanent.id, { now: 30_001 }).status, 'RETRY');
});

test('an alert is externally deliverable and responder acknowledgement is evidence', async () => {
  const { db } = makeDatabase();
  const alert = monitoring.raise(db, {
    severity: 'CRITICAL', kind: 'test.injected', title: 'Injected Mission 4 failure', detail: 'Expected test alert.',
  }, { webhookUrl: 'https://alerts.example.test/hook', now: 40_000 });
  let deliveredBody;
  const originalFetch = global.fetch;
  global.fetch = async (_url, request) => {
    deliveredBody = JSON.parse(request.body);
    return { ok: true, status: 202 };
  };
  try {
    const message = await outbox.processOne(db, {
      'monitoring.webhook': monitoring.webhookDispatcher(db, { url: 'https://alerts.example.test/hook' }),
    }, { owner: 'alerts', now: 40_000 });
    assert.equal(message.status, 'DELIVERED');
  } finally { global.fetch = originalFetch; }
  assert.equal(deliveredBody.id, alert.id);
  assert.equal(monitoring.get(db, alert.id).status, 'DELIVERED');
  assert.equal(monitoring.acknowledge(db, alert.id, 'on-call@example.test').status, 'ACKNOWLEDGED');
  assert.equal(db.prepare("SELECT status FROM runtime_checkpoints WHERE check_key = 'alert.acknowledged'").get().status, 'PASS');
});

test('password reset is account-neutral, encrypted in the outbox and one-time', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { email: 'owner@reset.example' });
  const unknown = recovery.request(db, 'missing@reset.example', { origin: 'https://foundry.example' });
  assert.deepEqual(unknown, { accepted: true, queued: false });
  const accepted = recovery.request(db, 'owner@reset.example', { origin: 'https://foundry.example', now: 50_000 });
  assert.deepEqual(accepted, { accepted: true, queued: true });
  const row = db.prepare("SELECT * FROM runtime_outbox WHERE message_type = 'password_reset'").get();
  assert.ok(row.payload.includes('ciphertext'));
  assert.equal(row.payload.includes('owner@reset.example'), false);
  const message = outbox.get(db, row.id);
  const clear = email.unseal(message.payload);
  const token = new URL(clear.text.match(/https:\/\/\S+/)[0]).searchParams.get('token');
  db.prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)')
    .run('session_reset', JSON.stringify({ accountId: workspace.accountId }), Date.now() + 60_000);
  assert.equal(recovery.consume(db, token, 'new-password-123', { now: 50_001 }).accountId, workspace.accountId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('session_reset').n, 0);
  assert.throws(() => recovery.consume(db, token, 'another-password-123', { now: 50_002 }), /invalid or has expired/i);
});

test('StockChief progress survives memory loss and interrupted work becomes retryable', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Durable progress' });
  const id = foundryJobs.createJob(workspace.workspaceId, 'understanding', 'My real business description', {
    db, track: 'description', subject: 'My business',
  });
  foundryJobs.setStage(id, 'reading', db);
  foundryJobs.reset();
  assert.equal(foundryJobs.getJob(id, workspace.workspaceId, db).stage, 'reading');
  assert.equal(foundryJobs.getJob(id, 'another-workspace', db), null);
  db.prepare('UPDATE foundry_ui_jobs SET deadline_at = ? WHERE id = ?').run(Date.now() - 1, id);
  foundryJobs.reset();
  const interrupted = foundryJobs.getJob(id, workspace.workspaceId, db);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.error.code, 'job_interrupted');
  assert.match(interrupted.error.message, /nothing was changed/i);
});

test('retention removes expired operational envelopes but never business truth', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Retention safety' });
  const item = makeQuantityItem(db, workspace.ctx);
  const message = outbox.enqueue(db, {
    destination: 'test', messageType: 'old', idempotencyKey: 'old:1', now: 1_000,
  }).message;
  db.prepare("UPDATE runtime_outbox SET status = 'DELIVERED', updated_at = ? WHERE id = ?")
    .run('2020-01-01T00:00:00.000Z', message.id);
  const removed = retention.apply(db, { now: Date.parse('2026-01-01T00:00:00Z'), policy: {
    deliveredMessagesDays: 30, inboxDays: 90, resolvedAlertsDays: 365,
    resetTokensDays: 7, certificationDays: 730,
  } });
  assert.equal(removed.deliveredMessages, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get(item.itemId).n, 1);
  assert.equal(db.prepare("SELECT status FROM runtime_checkpoints WHERE check_key = 'retention.policy'").get().status, 'PASS');
});

test('readiness ignores partial backups and accepts only a verified manifest commit record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-backup-evidence-'));
  try {
    const partial = path.join(directory, 'foundry-2026-09-09T12-00-00.sqlite');
    fs.writeFileSync(partial, 'incomplete');
    assert.equal(readiness.newestBackup(directory), null);

    const verified = path.join(directory, 'foundry-2026-09-09T12-01-00.sqlite');
    fs.writeFileSync(verified, 'complete-enough-for-this-metadata-test');
    fs.writeFileSync(`${verified}.json`, JSON.stringify({ verification: {
      ok: true, bytes: fs.statSync(verified).size, sha256: 'a'.repeat(64),
    } }));
    assert.equal(readiness.newestBackup(directory).path, verified);

    const rejected = path.join(directory, 'foundry-2026-09-09T12-02-00.sqlite');
    fs.writeFileSync(rejected, 'failed');
    fs.writeFileSync(`${rejected}.json`, JSON.stringify({ verification: { ok: false } }));
    assert.equal(readiness.newestBackup(directory).path, verified);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a local restore cannot certify the hosting-platform restore gate', () => {
  const { db } = makeDatabase();
  seedWorkspace(db, { workspaceName: 'Restore evidence' });
  checkpoints.record(db, 'backup.restore', 'PASS', { productionLike: true, hostingVerified: false });
  let restore = readiness.snapshot(db, { env: 'production' }).checks.find((row) => row.key === 'restore');
  assert.equal(restore.status, 'BLOCKED');

  checkpoints.record(db, 'backup.restore', 'PASS', {
    productionLike: true, hostingVerified: true, hostingProvider: 'test-host', hostingEvidence: 'run-123',
  });
  restore = readiness.snapshot(db, { env: 'production' }).checks.find((row) => row.key === 'restore');
  assert.equal(restore.status, 'PASS');
});

test('an interrupted online backup removes every partial artifact', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-interrupted-backup-'));
  try {
    await assert.rejects(() => backups.create({
      backup: async (destination) => {
        fs.writeFileSync(destination, 'partial');
        fs.writeFileSync(`${destination}-journal`, 'partial-journal');
        throw new Error('simulated interruption');
      },
    }, { directory, now: Date.parse('2026-09-09T12:03:00Z') }), /simulated interruption/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an unresolved material incident blocks readiness until an operator resolves it', () => {
  const { db } = makeDatabase();
  seedWorkspace(db, { workspaceName: 'Incident readiness' });
  const alert = monitoring.raise(db, {
    severity: 'CRITICAL', kind: 'database.unavailable', title: 'Injected outage', detail: 'Expected test.',
  });
  let incident = readiness.snapshot(db, { env: 'production' }).checks.find((row) => row.key === 'incidents');
  assert.equal(incident.status, 'BLOCKED');
  monitoring.resolve(db, alert.id);
  incident = readiness.snapshot(db, { env: 'production' }).checks.find((row) => row.key === 'incidents');
  assert.equal(incident.status, 'PASS');
});

test('restore rejects a backup whose committed manifest no longer matches', async () => {
  const { db, dir } = makeDatabase();
  seedWorkspace(db, { workspaceName: 'Manifest integrity' });
  const created = await backups.create(db, { directory: path.join(dir, 'backups') });
  const manifest = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'));
  manifest.verification.sha256 = '0'.repeat(64);
  fs.writeFileSync(created.manifestPath, JSON.stringify(manifest));
  assert.throws(() => backups.restoreTo(created.path, path.join(dir, 'restored.sqlite')),
    /does not match its verified manifest/i);
});

test('production readiness requires an immutable release identity', () => {
  const previous = process.env.FOUNDRY_RELEASE_REF;
  try {
    delete process.env.FOUNDRY_RELEASE_REF;
    const { db } = makeDatabase();
    seedWorkspace(db, { workspaceName: 'Release identity' });
    let identity = readiness.snapshot(db, { env: 'production' }).checks
      .find((row) => row.key === 'release_identity');
    assert.equal(identity.status, 'BLOCKED');
    process.env.FOUNDRY_RELEASE_REF = 'release-2026-09-09';
    identity = readiness.snapshot(db, { env: 'production' }).checks
      .find((row) => row.key === 'release_identity');
    assert.equal(identity.status, 'PASS');
  } finally {
    if (previous === undefined) delete process.env.FOUNDRY_RELEASE_REF;
    else process.env.FOUNDRY_RELEASE_REF = previous;
  }
});

test('production readiness cannot certify the local single-writer database topology', () => {
  const { db } = makeDatabase();
  seedWorkspace(db,{ workspaceName:'Topology readiness' });
  const local = readiness.snapshot(db,{ env:'production' }).checks
    .find((row) => row.key === 'database_topology');
  assert.equal(local.status,'BLOCKED');
  assert.match(local.message,/not a certified shared multi-writer/);

  const shared = readiness.snapshot(db,{ env:'production',databaseTopology:{
    engine:'postgresql',shared:true,multiWriter:true,certification:'staging-concurrency',
  } }).checks.find((row) => row.key === 'database_topology');
  assert.equal(shared.status,'PASS');
});

test('due work that has stopped moving is reported before it reaches dead letter', () => {
  const { db } = makeDatabase();
  jobs.enqueue(db, { kind: 'stuck.test', idempotencyKey: 'stuck:1', now: 1_000 });
  outbox.enqueue(db, {
    destination: 'test', messageType: 'stuck', idempotencyKey: 'stuck:outbox', now: 1_000,
  });
  const state = readiness.snapshot(db, {
    env: 'production', now: 1_000 + 5 * 60_000 + 1,
  });
  const durable = state.checks.find((row) => row.key === 'durable_jobs');
  const outbound = state.checks.find((row) => row.key === 'outbox');
  assert.equal(durable.status, 'BLOCKED');
  assert.equal(durable.evidence.overdueJobs, 1);
  assert.equal(outbound.status, 'BLOCKED');
  assert.equal(outbound.evidence.overdueOutbox, 1);
});

test('sandbox or prior-release provider evidence cannot certify a live deployment', () => {
  const previous = process.env.FOUNDRY_RELEASE_REF;
  process.env.FOUNDRY_RELEASE_REF = 'current-release';
  try {
    const { db } = makeDatabase();
    seedWorkspace(db, { workspaceName: 'Live provider evidence' });
    checkpoints.record(db, 'integration.oauth_popup', 'PASS', {
      popupReturned: true, sessionPreserved: true, liveMode: false, releaseRef: 'current-release',
    });
    let oauth = readiness.snapshot(db, { env: 'production' }).checks.find((row) => row.key === 'oauth_popup');
    assert.equal(oauth.status, 'BLOCKED');
    checkpoints.record(db, 'integration.oauth_popup', 'PASS', {
      popupReturned: true, sessionPreserved: true, liveMode: true, releaseRef: 'older-release',
    });
    oauth = readiness.snapshot(db, { env: 'production' }).checks.find((row) => row.key === 'oauth_popup');
    assert.equal(oauth.status, 'BLOCKED');
    checkpoints.record(db, 'integration.oauth_popup', 'PASS', {
      popupReturned: true, sessionPreserved: true, liveMode: true, releaseRef: 'current-release',
    });
    oauth = readiness.snapshot(db, { env: 'production' }).checks.find((row) => row.key === 'oauth_popup');
    assert.equal(oauth.status, 'PASS');
  } finally {
    if (previous === undefined) delete process.env.FOUNDRY_RELEASE_REF;
    else process.env.FOUNDRY_RELEASE_REF = previous;
  }
});

test('web and worker process roles are explicit and invalid values fail safe to the single process', () => {
  const previous = process.env.FOUNDRY_PROCESS_ROLE;
  try {
    process.env.FOUNDRY_PROCESS_ROLE = 'web';
    assert.equal(config.operations.webEnabled, true);
    assert.equal(config.operations.workerEnabled, false);
    process.env.FOUNDRY_PROCESS_ROLE = 'worker';
    assert.equal(config.operations.webEnabled, false);
    assert.equal(config.operations.workerEnabled, true);
    process.env.FOUNDRY_PROCESS_ROLE = 'misspelled';
    assert.equal(config.operations.processRole, 'all');
    assert.equal(config.operations.webEnabled, true);
    assert.equal(config.operations.workerEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.FOUNDRY_PROCESS_ROLE;
    else process.env.FOUNDRY_PROCESS_ROLE = previous;
  }
});
