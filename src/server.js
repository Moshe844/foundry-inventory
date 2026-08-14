'use strict';

const config = require('./config');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const reevaluate = require('./attention/reevaluate');

config.ensureDataDir();

const db = openDatabase(config.databasePath);
const app = createApp({ db });

// Some conditions become true because the calendar moved, not because stock
// did — a lot approaching expiry, stock going idle. Movements are handled by
// the hooks in the route layer; this is the other half.
const stopSweeper = reevaluate.startScheduler(db);

const server = app.listen(config.port, () => {
  console.log(`Foundry Inventory listening on http://localhost:${config.port}  (${config.env})`);
  console.log(`Database: ${config.databasePath}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, closing down.`);
  stopSweeper();
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
