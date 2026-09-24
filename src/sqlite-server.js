'use strict';

// Local legacy launcher. Production startup is selected by src/server.js and
// cannot enter this process when NODE_ENV=production.

const config = require('./config');
const netTrust = require('./net-trust');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const reevaluate = require('./attention/reevaluate');
const autopilotScheduler = require('./autopilot/scheduler');
const mailboxScheduler = require('./connections/mailbox-scheduler');
const backupService = require('./operations/backup');
const runtimeWorker = require('./operations/worker');
const monitoring = require('./operations/monitoring');
const retention = require('./operations/retention');
const cutoverRunner = require('./onboarding/cutover-runner');
const preparationRunner = require('./onboarding/preparation-runner');

config.ensureDataDir();

// Before anything tries to leave the machine. This host reissues certificates
// through a locally installed root, and a runtime that does not read the system
// certificate store rejects every outbound call with an error naming neither
// the store nor the machine.
const trust = netTrust.installSystemCertificates();
if (trust.applied) {
  console.log(`TLS: trusting ${trust.added} certificate authorities from this machine's store`);
}

const db = openDatabase(config.databasePath);
const app = createApp({ db });

// Durable customer-requested work starts before broad scheduled analysis. A
// startup sweep across a very large inventory used to block the worker before
// it even read a queued inventory deletion, leaving the UI on “Deleting…” for
// minutes. The runtime claims its queue immediately; catch-up analysis waits
// until that queue is clear.
const runtime = config.operations.workerEnabled ? runtimeWorker.start(db, {
  handlers: {
    'workspace.delete': require('./operations/workspace-delete-job').handler(db),
    'supplier.purchase-order.dispatch': require('./purchasing/supplier-communications').dispatchJobHandler(db),
  },
}) : { stop() {} };

// Some conditions become true because the calendar moved, not because stock
// did — a lot approaching expiry, stock going idle. The periodic timers remain
// active, but their startup passes are coordinated below instead of blocking
// the durable queue during process boot.
const stopSweeper = config.operations.workerEnabled
  ? reevaluate.startScheduler(db, { immediate: false }) : () => {};
const stopAutopilot = config.operations.workerEnabled && config.autopilot.enabled
  ? autopilotScheduler.start(db, { intervalMs: config.autopilot.intervalMs, immediate: false })
  : () => {};
const stopMailboxes = config.operations.workerEnabled && config.autopilot.enabled ? mailboxScheduler.start(db) : () => {};
const stopBackups = config.operations.workerEnabled && config.backups.enabled ? backupService.startScheduler(db, {
  directory: config.backups.directory,
  retentionDays: config.backups.retentionDays,
  intervalMs: config.backups.intervalMs,
  runOnStart: false,
}) : () => {};

let startupCatchupTimer = null;
// A full attention + autonomy sweep may legitimately scan hundreds of
// thousands of SKUs. Starting that sweep automatically two seconds after
// every local restart made all interactive pages compete with it for CPU and
// SQLite pages for many minutes. Scheduled sweeps and event-driven work still
// run normally; deployments that explicitly want boot catch-up can opt in.
if (config.operations.workerEnabled && process.env.FOUNDRY_STARTUP_CATCHUP === 'true') {
  const runStartupCatchup = () => {
    const queued = db.prepare(`SELECT 1 FROM runtime_jobs
      WHERE status IN ('PENDING','RETRY','RUNNING') LIMIT 1`).get();
    if (queued) {
      startupCatchupTimer = setTimeout(runStartupCatchup, 2000);
      startupCatchupTimer.unref();
      return;
    }
    try { reevaluate.sweepAll(db, 'startup'); }
    catch (error) { console.error('[attention] startup sweep failed: %s', error.message); }
    if (config.autopilot.enabled) {
      try { autopilotScheduler.tick(db, { trigger: 'startup', intervalMs: config.autopilot.intervalMs }); }
      catch (error) { console.error('[autopilot] startup tick failed: %s', error.message); }
    }
  };
  startupCatchupTimer = setTimeout(runStartupCatchup, 2000);
  startupCatchupTimer.unref();
}
const stopRetention = config.operations.workerEnabled ? retention.start(db) : () => {};

const server = config.operations.webEnabled ? app.listen(config.port, () => {
  if (process.send) process.send({ type: 'stockchief.web.ready' });
  console.log(`StockChief Inventory listening on http://localhost:${config.port}  (${config.env})`);
  console.log(`Database: ${config.databasePath}`);
  console.log(
    config.operations.workerEnabled && config.autopilot.enabled
      ? `Autopilot: checking every ${Math.round(config.autopilot.intervalMs / 60000)} minutes`
      : config.operations.workerEnabled
        ? 'Autopilot: not scheduled — it acts only when asked'
        : 'Background work: running in the separate worker process'
  );
  // Accept browser traffic before resuming a large, already-authorized
  // migration. The worker uses its own database connection; starting it first
  // can let SQLite initialization delay the HTTP listener after a restart.
  if (config.operations.workerEnabled) {
    preparationRunner.resumeInterrupted(db,config.databasePath);
    cutoverRunner.resumeInterrupted(db, config.databasePath);
  }
}) : null;
if (!config.operations.webEnabled) {
  console.log(`StockChief worker running without an HTTP listener  (${config.env})`);
  console.log(`Database: ${config.databasePath}`);
  cutoverRunner.resumeInterrupted(db,config.databasePath);
  preparationRunner.resumeInterrupted(db,config.databasePath);
}
// Schedulers deliberately unref their timers so an ordinary web process can
// close cleanly. A worker-only process has no listening socket, so it needs one
// owned handle to remain alive until SIGTERM/SIGINT.
const workerKeepAlive = !config.operations.webEnabled ? setInterval(() => {}, 60 * 60_000) : null;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, closing down.`);
  stopSweeper();
  stopAutopilot();
  stopMailboxes();
  stopBackups();
  runtime.stop();
  if (startupCatchupTimer) clearTimeout(startupCatchupTimer);
  stopRetention();
  if (workerKeepAlive) clearInterval(workerKeepAlive);
  const closeDatabase = async () => {
    try {
      await app?.locals?.sessionStore?.close();
    } catch (error) {
      console.error('[stockchief] session store shutdown failed: %s', error.code || 'store_error');
    }
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  };
  if (server) server.close(closeDatabase);
  else closeDatabase();
  setTimeout(() => process.exit(0), 4000).unref();
}

let fatalRecorded = false;
function fatal(kind, error) {
  if (fatalRecorded) return;
  fatalRecorded = true;
  try {
    monitoring.raise(db, {
      severity: 'CRITICAL', kind,
      title: 'A StockChief process stopped unexpectedly',
      detail: String(error && (error.code || error.name || error.message) || 'Unknown process failure'),
      fingerprint: `${kind}:${config.operations.releaseRef}`,
    });
  } catch (monitoringError) {
    console.error('[foundry] could not record fatal alert', monitoringError);
  }
  console.error(`[foundry] ${kind}`, error);
  shutdown(kind);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => fatal('process.uncaught_exception', error));
process.on('unhandledRejection', (error) => fatal('process.unhandled_rejection', error));

module.exports = { app, server, db };
