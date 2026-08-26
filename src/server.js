'use strict';

const config = require('./config');
const netTrust = require('./net-trust');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const reevaluate = require('./attention/reevaluate');
const autopilotScheduler = require('./autopilot/scheduler');

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
const stopSweeper = reevaluate.startScheduler(db);

// And the loop itself: what should happen now, decided on a clock rather than
// when somebody remembers to ask. It calls exactly what the Check now button
// calls, so this adds timing and no new authority.
const stopAutopilot = config.autopilot.enabled
  ? autopilotScheduler.start(db, { intervalMs: config.autopilot.intervalMs })
  : () => {};

const server = app.listen(config.port, () => {
  console.log(`Foundry Inventory listening on http://localhost:${config.port}  (${config.env})`);
  console.log(`Database: ${config.databasePath}`);
  console.log(
    config.autopilot.enabled
      ? `Autopilot: checking every ${Math.round(config.autopilot.intervalMs / 60000)} minutes`
      : 'Autopilot: not scheduled — it acts only when asked'
  );
});

function shutdown(signal) {
  console.log(`\n${signal} received, closing down.`);
  stopSweeper();
  stopAutopilot();
  server.close(() => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, db };
