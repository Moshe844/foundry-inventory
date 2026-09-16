'use strict';

const config = require('./config');
const { openDatabase } = require('./db');
const runtimeWorker = require('./operations/worker');

config.ensureDataDir();
const db = openDatabase(config.databasePath);
const worker = runtimeWorker.start(db);
console.log(`StockChief worker started (${config.env}); database ${config.databasePath}`);

function shutdown(signal) {
  console.log(`${signal} received, stopping StockChief worker.`);
  worker.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

