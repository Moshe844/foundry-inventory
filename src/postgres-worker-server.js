'use strict';

const { openPostgres } = require('./db/postgres');
const { migratePostgres } = require('./db/migrate-postgres');
const worker = require('./operations/postgres-worker');
const businessHandlers = require('./operations/postgres-business-handlers');
const runtimeHandlers = require('./operations/postgres-runtime-handlers');
const scheduler = require('./operations/postgres-scheduler');
const { validateProductionEnvironment } = require('./operations/postgres-production-environment');

const connectionString = process.env.FOUNDRY_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('FOUNDRY_DATABASE_URL is required for the PostgreSQL worker.');
validateProductionEnvironment({ requireSession: false });

const database = openPostgres(connectionString, {
  applicationName: process.env.FOUNDRY_WORKER_NAME || 'stockchief-business-worker',
  max: Number(process.env.FOUNDRY_WORKER_DB_POOL_SIZE || 5),
});

let runtime = null;
let scheduleRuntime = null;
let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[stockchief] ${signal}; stopping PostgreSQL worker.`);
  try {
    if (scheduleRuntime) await scheduleRuntime.stop();
    if (runtime) await runtime.stop();
    await database.close();
  } finally {
    process.exit(exitCode);
  }
}

async function start() {
  const applied = await migratePostgres(database);
  runtime = worker.start(database, {
    handlers: {...businessHandlers.create(),...runtimeHandlers.create()},
    intervalMs: Number(process.env.FOUNDRY_WORKER_INTERVAL_MS || 500),
    leaseMs: Number(process.env.FOUNDRY_WORKER_LEASE_MS || 60000),
    isolation: 'SERIALIZABLE',
    retrySafe: true,
    onError(error) {
      console.error('[stockchief] PostgreSQL worker iteration failed:', error.code || error.message);
    },
  });
  scheduleRuntime=scheduler.start(database,{intervalMs:Number(process.env.FOUNDRY_SCHEDULER_INTERVAL_MS || 60000),
    onError(error){console.error('[stockchief] PostgreSQL scheduler iteration failed:',error.code || error.message);}});
  console.log(`[stockchief] PostgreSQL worker ${runtime.owner} ready; migrations applied: ${applied.length}.`);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  console.error('[stockchief] PostgreSQL worker uncaught exception:', error);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  console.error('[stockchief] PostgreSQL worker unhandled rejection:', error);
  shutdown('unhandledRejection', 1);
});

start().catch((error) => {
  console.error('[stockchief] PostgreSQL worker startup failed:', error);
  shutdown('startupFailure', 1);
});

module.exports = { database, start, shutdown };
