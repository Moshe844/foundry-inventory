'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const checkpoints = require('./checkpoints');

function newestBackup(directory) {
  if (!directory || !fs.existsSync(directory)) return null;
  const rows = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:foundry|keeper)-.*\.sqlite$/.test(entry.name))
    .map((entry) => {
      const target = path.join(directory, entry.name);
      const manifestPath = `${target}.json`;
      if (!fs.existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest?.verification?.ok !== true
            || !/^[a-f0-9]{64}$/.test(String(manifest.verification.sha256 || ''))
            || Number(manifest.verification.bytes || 0) <= 0
            || Number(manifest.verification.bytes) !== fs.statSync(target).size) return null;
        return { path: target, manifestPath, modifiedMs: fs.statSync(target).mtimeMs,
          verification: manifest.verification };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.modifiedMs - a.modifiedMs);
  return rows[0] || null;
}

function check(key, ok, message, evidence = {}, required = true) {
  return { key, status: ok ? 'PASS' : required ? 'BLOCKED' : 'WARN', message, evidence, required };
}

function reconciliationState(db) {
  const inventory = require('../domain/inventory-engine');
  const brain = require('../manager/business-brain');
  const workspaces = db.prepare('SELECT id, name FROM workspaces ORDER BY id').all();
  const differences = [];
  for (const workspace of workspaces) {
    const integrity = inventory.verifyIntegrity(db, workspace.id);
    if (!integrity.ok) differences.push({ workspaceId: workspace.id, workspace: workspace.name,
      kind: 'inventory_integrity', problems: integrity.problems.length });
    for (const item of brain.build(db, workspace.id).consistency || []) {
      if (item.passed === false) differences.push({ workspaceId: workspace.id, workspace: workspace.name,
        kind: item.key, detail: item.detail });
    }
  }
  return { ok: differences.length === 0, workspaceCount: workspaces.length, differences };
}

function snapshot(db, options = {}) {
  const env = options.env || config.env;
  const production = env === 'production';
  const topology = options.databaseTopology || db.foundryTopology
    || { engine:'unknown',shared:false,multiWriter:false };
  const now = Number(options.now || Date.now());
  let databaseOk = false;
  let schemaVersion = null;
  try {
    databaseOk = db.pragma('quick_check').every((row) => Object.values(row)[0] === 'ok');
    schemaVersion = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value || null;
  } catch { databaseOk = false; }

  const deadJobs = databaseOk ? db.prepare("SELECT COUNT(*) AS n FROM runtime_jobs WHERE status = 'DEAD'").get().n : null;
  const deadOutbox = databaseOk ? db.prepare("SELECT COUNT(*) AS n FROM runtime_outbox WHERE status = 'DEAD'").get().n : null;
  const staleRunning = databaseOk ? db.prepare(`SELECT COUNT(*) AS n FROM runtime_jobs
    WHERE status = 'RUNNING' AND lease_expires_at <= ?`).get(now).n : null;
  const overdueJobs = databaseOk ? db.prepare(`SELECT COUNT(*) AS n FROM runtime_jobs
    WHERE status IN ('PENDING','RETRY') AND available_at <= ?`).get(now - config.operations.maxQueueLagMs).n : null;
  const overdueOutbox = databaseOk ? db.prepare(`SELECT COUNT(*) AS n FROM runtime_outbox
    WHERE status IN ('PENDING','RETRY') AND available_at <= ?`).get(now - config.operations.maxQueueLagMs).n : null;
  const openIncidents = databaseOk ? db.prepare(`SELECT COUNT(*) AS n FROM operational_alerts
    WHERE status != 'RESOLVED' AND severity IN ('ERROR', 'CRITICAL')`).get().n : null;
  const backup = newestBackup(options.backupDirectory || config.backups.directory);
  const backupFresh = Boolean(backup && now - backup.modifiedMs <= config.operations.backupFreshHours * 3600000);
  const resetEvidence = checkpoints.get(db, 'password_recovery.delivery');
  const alertEvidence = checkpoints.get(db, 'alert.acknowledged');
  const restoreEvidence = checkpoints.get(db, 'backup.restore');
  const rollbackEvidence = checkpoints.get(db, 'deployment.rollback');
  const browserEvidence = checkpoints.get(db, 'browser.regression');
  const loadEvidence = checkpoints.get(db, 'load.soak');
  const workerEvidence = checkpoints.get(db, 'worker.throughput');
  const zeroTrainingEvidence = checkpoints.get(db, 'zero_training.walkthrough');
  const supportEvidence = checkpoints.get(db, 'support.mailbox');
  const retentionEvidence = checkpoints.get(db, 'retention.policy');
  const sameRelease = (evidence) => evidence?.detail?.releaseRef === config.operations.releaseRef;
  const restoreOk = restoreEvidence?.status === 'PASS'
    && restoreEvidence.detail?.productionLike === true
    && restoreEvidence.detail?.hostingVerified === true;
  const rollbackOk = rollbackEvidence?.status === 'PASS' && rollbackEvidence.detail?.hostingVerified === true;
  const browserOk = browserEvidence?.status === 'PASS' && sameRelease(browserEvidence)
    && browserEvidence.detail?.fullSuite === true
    && Number(browserEvidence.detail?.consecutivePasses || 0) >= 2;
  const zeroTrainingOk = zeroTrainingEvidence?.status === 'PASS'
    && zeroTrainingEvidence.detail?.independentUser === true;
  const loadOk = loadEvidence?.status === 'PASS' && sameRelease(loadEvidence)
    && loadEvidence.detail?.budgetsPassed === true
    && Number(loadEvidence.detail?.durationSeconds || 0) >= Number(options.minimumSoakSeconds || 900);
  const workerOk = workerEvidence?.status === 'PASS' && sameRelease(workerEvidence)
    && workerEvidence.detail?.budgetPassed === true
    && Number(workerEvidence.detail?.jobs || 0) >= Number(options.minimumWorkerJobs || 1000);
  const integrationKeys = [
    ['oauth_popup', 'integration.oauth_popup', (d) => d.releaseRef === config.operations.releaseRef
      && d.popupReturned === true
      && d.sessionPreserved === true && d.liveMode === true,
      'OAuth popup return and signed-in StockChief session'],
    ['token_refresh', 'integration.token_refresh', (d) => d.releaseRef === config.operations.releaseRef
      && d.refreshed === true && d.liveMode === true,
      'OAuth token refresh'],
    ['webhook_fallback', 'integration.webhook_fallback', (d) => d.releaseRef === config.operations.releaseRef
      && d.webhookVerified === true
      && d.pollFallbackVerified === true && d.liveMode === true,
      'webhook delivery and polling fallback'],
    ['payment_settlement', 'integration.payment_settlement', (d) => d.releaseRef === config.operations.releaseRef
      && d.settled === true
      && d.reconciled === true && d.liveMode === true,
      'payment settlement reconciliation'],
    ['shipping_onboarding', 'integration.shipping_onboarding',
      (d) => d.releaseRef === config.operations.releaseRef
        && d.connected === true && d.customerFunded === true
        && d.platformCharged === false && d.liveMode === true,
      'customer-funded shipping onboarding'],
    ['adversarial', 'adversarial.runtime',
      (d) => d.releaseRef === config.operations.releaseRef
        && ['tenantIsolation','permissions','concurrency','duplicateDelivery','crashMidAction'].every((key) => d[key] === true),
      'tenant, permission, concurrency, duplicate and crash adversarial tests'],
  ].map(([key, checkpointKey, predicate, label]) => {
    const evidence = checkpoints.get(db, checkpointKey);
    const ok = evidence?.status === 'PASS' && predicate(evidence.detail || {});
    return check(key, !production || ok,
      ok ? `${label} passed.` : `${label} has no qualifying certification evidence.`, evidence || {}, production);
  });
  let reconciliation = { ok: false, workspaceCount: 0, differences: [{ kind: 'audit_failed' }] };
  if (databaseOk) {
    try { reconciliation = reconciliationState(db); } catch (error) {
      reconciliation = { ok: false, workspaceCount: 0, differences: [{ kind: 'audit_failed', detail: error.message }] };
    }
  }

  const checks = [
    check('database', databaseOk, databaseOk ? 'Database quick-check passed.' : 'Database is unavailable or corrupt.', { schemaVersion }),
    check('database_topology', !production || (topology.shared === true && topology.multiWriter === true),
      topology.shared === true && topology.multiWriter === true
        ? `${topology.engine || 'Shared relational'} database is certified for shared multi-writer operation.`
        : `${topology.engine || 'This'} database is not a certified shared multi-writer production topology.`,
      topology,production),
    check('schema', Number(schemaVersion) >= 18, `Schema version ${schemaVersion || 'unknown'} is installed.`, { schemaVersion }),
    check('release_identity', !production || (config.operations.releaseRef && config.operations.releaseRef !== 'development'),
      config.operations.releaseRef && config.operations.releaseRef !== 'development'
        ? `Immutable release ${config.operations.releaseRef} is identified.`
        : 'FOUNDRY_RELEASE_REF must identify the immutable deployed release.',
      { releaseRef: config.operations.releaseRef }, production),
    check('durable_jobs', deadJobs === 0 && staleRunning === 0 && overdueJobs === 0,
      deadJobs || staleRunning || overdueJobs
        ? `${deadJobs} dead jobs, ${staleRunning} expired leases and ${overdueJobs} overdue jobs require review.`
        : 'No dead, expired or overdue jobs.',
      { deadJobs, staleRunning, overdueJobs, maxQueueLagMs: config.operations.maxQueueLagMs }),
    check('outbox', deadOutbox === 0 && overdueOutbox === 0,
      deadOutbox || overdueOutbox
        ? `${deadOutbox} messages are dead-lettered and ${overdueOutbox} are overdue.`
        : 'No dead-lettered or overdue external messages.',
      { deadOutbox, overdueOutbox, maxQueueLagMs: config.operations.maxQueueLagMs }),
    check('incidents', openIncidents === 0,
      openIncidents ? `${openIncidents} unresolved error or critical incident(s) require review.`
        : 'No unresolved error or critical incidents.', { openIncidents }),
    check('public_origin', !production || /^https:\/\//.test(config.connections.publicOrigin || ''),
      config.connections.publicOrigin ? 'Public callback origin is configured.' : 'FOUNDRY_PUBLIC_URL is missing.', {}, production),
    check('support', !production || Boolean(config.supportEmail) && supportEvidence?.status === 'PASS'
      && supportEvidence.detail?.monitored === true,
      config.supportEmail && supportEvidence?.detail?.monitored === true
        ? `Support is owned and monitored by ${config.supportEmail}.`
        : 'A monitored support mailbox and tested ownership are not recorded.', supportEvidence || {}, production),
    check('retention', !production || retentionEvidence?.status === 'PASS',
      retentionEvidence?.status === 'PASS' ? 'The operational retention policy ran successfully.'
        : 'The retention policy has not completed successfully.', retentionEvidence || {}, production),
    check('email', !production || config.email.configured,
      config.email.configured ? 'Production email sender is configured.' : 'Password-recovery email delivery is not configured.', {}, production),
    check('password_recovery', !production || resetEvidence?.status === 'PASS',
      resetEvidence?.status === 'PASS' ? 'A password-recovery message was delivered.' : 'No successful password-recovery delivery is recorded.', resetEvidence || {}, production),
    check('alerting', !production || Boolean(config.operations.alertWebhookUrl && config.operations.alertAckToken),
      config.operations.alertWebhookUrl ? 'External alert endpoint is configured.' : 'External alert delivery is not configured.', {}, production),
    check('alert_ack', !production || alertEvidence?.status === 'PASS',
      alertEvidence?.status === 'PASS' ? 'A monitored responder acknowledged an injected alert.' : 'No responder acknowledgement is recorded.', alertEvidence || {}, production),
    check('backup', !production || (config.backups.enabled && backupFresh && config.backups.storageClass === 'offsite'),
      backupFresh && config.backups.storageClass === 'offsite'
        ? 'A recent verified off-site backup is present.'
        : 'No sufficiently recent verified off-site backup is present.',
      { ...(backup || {}), storageClass: config.backups.storageClass }, production),
    check('restore', !production || restoreOk,
      restoreOk ? 'A production-like hosting-platform restore rehearsal is recorded.'
        : 'No production-like hosting-platform restore rehearsal is recorded.', restoreEvidence || {}, production),
    check('rollback', !production || rollbackOk,
      rollbackOk ? 'A hosting deployment rollback is verified.' : 'No hosting-platform rollback verification is recorded.', rollbackEvidence || {}, production),
    check('browser_regression', !production || browserOk,
      browserOk ? 'The full browser suite passed at least twice consecutively.' : 'Two consecutive full browser passes are not certified.', browserEvidence || {}, production),
    check('zero_training', !production || zeroTrainingOk,
      zeroTrainingOk ? 'An independent zero-training walkthrough passed.' : 'No independent zero-training walkthrough is recorded.', zeroTrainingEvidence || {}, production),
    check('load_soak', !production || loadOk,
      loadOk ? 'Load/soak budgets passed for the minimum duration.' : 'A qualifying load/soak run is not certified.', loadEvidence || {}, production),
    check('worker_throughput', !production || workerOk,
      workerOk ? 'Durable worker throughput met its recorded budget.'
        : 'A qualifying durable-worker throughput run is not certified.', workerEvidence || {}, production),
    check('reconciliation', reconciliation.ok,
      reconciliation.ok ? `All ${reconciliation.workspaceCount} inventories reconcile.`
        : `${reconciliation.differences.length} material consistency difference(s) remain.`, reconciliation, true),
    ...integrationKeys,
  ];
  const blockers = checks.filter((row) => row.required && row.status !== 'PASS');
  return { ok: blockers.length === 0, environment: env, checks, blockers: blockers.map((row) => row.key) };
}

module.exports = { newestBackup, reconciliationState, snapshot };
