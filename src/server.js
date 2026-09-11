'use strict';

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

// Some conditions become true because the calendar moved, not because stock
// did — a lot approaching expiry, stock going idle. Movements are handled by
// the hooks in the route layer; this is the other half.
const stopSweeper = config.operations.workerEnabled ? reevaluate.startScheduler(db) : () => {};

// And the loop itself: what should happen now, decided on a clock rather than
// when somebody remembers to ask. It calls exactly what the Check now button
// calls, so this adds timing and no new authority.
const stopAutopilot = config.operations.workerEnabled && config.autopilot.enabled
  ? autopilotScheduler.start(db, { intervalMs: config.autopilot.intervalMs })
  : () => {};
const stopMailboxes = config.operations.workerEnabled && config.autopilot.enabled ? mailboxScheduler.start(db) : () => {};
const stopBackups = config.operations.workerEnabled && config.backups.enabled ? backupService.startScheduler(db, {
  directory: config.backups.directory,
  retentionDays: config.backups.retentionDays,
  intervalMs: config.backups.intervalMs,
  runOnStart: true,
}) : () => {};
const runtime = config.operations.workerEnabled ? runtimeWorker.start(db) : { stop() {} };
const stopRetention = config.operations.workerEnabled ? retention.start(db) : () => {};

const server = config.operations.webEnabled ? app.listen(config.port, () => {
  console.log(`Foundry Inventory listening on http://localhost:${config.port}  (${config.env})`);
  console.log(`Database: ${config.databasePath}`);
  console.log(
    config.autopilot.enabled
      ? `Autopilot: checking every ${Math.round(config.autopilot.intervalMs / 60000)} minutes`
      : 'Autopilot: not scheduled — it acts only when asked'
  );
}) : null;
if (!config.operations.webEnabled) {
  console.log(`Foundry worker running without an HTTP listener  (${config.env})`);
  console.log(`Database: ${config.databasePath}`);
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
  stopRetention();
  if (workerKeepAlive) clearInterval(workerKeepAlive);
  const closeDatabase = () => {
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
      title: 'A Foundry process stopped unexpectedly',
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
