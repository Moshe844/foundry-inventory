'use strict';

process.env.NODE_ENV = 'test';
const clock = require('./business-clock');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../../src/db');
const { createApp } = require('../../src/app');
const { seedWorkspace, makeQuantityItem } = require('../helpers');
const { openPostgres } = require('../../src/db/postgres');
const { PostgresSessionStore } = require('../../src/web/postgres-session-store');
const { startCluster, copyFixtureTables } = require('./postgres-cluster');
const operationalReview = require('../../src/manager/operational-review');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const postgresJobs = require('../../src/operations/postgres-job-queue');
const ledger = require('../../src/accounting/ledger');
const payments = require('../../src/accounting/payments');
const suppliers = require('../../src/purchasing/supplier-service');
const sales = require('../../src/sales/sales-order-service');
const inventory = require('../../src/domain/inventory-engine');
const auth = require('../../src/domain/auth-service');
let cluster;
let db;
let postgres;
let stores = [];
let servers = [];
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
  for (const store of stores) await store.close();
  if (postgres) await postgres.close();
  if (db?.open) db.close();
  if (cluster) cluster.stop();
}

async function start() {
  cluster = await startCluster();
  const databasePath = process.env.DATABASE_PATH || path.join(cluster.directory, 'business.sqlite');
  db = openDatabase(databasePath);
  clock.advance('2026-03-01T12:00:00.000Z');
  const workspace = seedWorkspace(db, { workspaceName: 'Operations Review Acceptance', email: 'operations@example.test', password: 'operations-ui-acceptance-2026' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, { startDate: '2026-01-01', currency: 'USD' });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Weekend Evidence Stock', baseCode: 'WEEKEND' });
  const customer = sales.createCustomer(db, workspace.ctx, { name: 'Weekend Customer' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'Weekend Supplier' });
  for (const [date, count] of [['2026-09-17', 1], ['2026-09-18', 25], ['2026-09-19', 2], ['2026-09-20', 3], ['2026-09-21', 1], ['2026-09-22', 1]]) {
    clock.advance(`${date}T12:00:00.000Z`);
    for (let index = 0; index < count; index += 1) {
      inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 1, reference: `${date}:${index}` });
    }
    payments.record(db, workspace.ctx, membership, { direction: 'CUSTOMER_RECEIPT', customerId: customer.id,
      paymentDate: date, amountMinor: 1000, sourceKey: `review-payment:${date}` });
  }
  clock.advance('2026-09-21T12:00:00.000Z');
  const bill = require('../../src/accounting/payables').createDraft(db, workspace.ctx, membership, {
    supplierId: supplier.id, supplierInvoiceNumber: 'REVIEW-UNPOSTED', issueDate: '2026-09-21', sourceKey: 'review-unposted',
    lines: [{ description: 'Unposted evidence', quantity: 1, unitCostMinor: 100 }] });
  const other = seedWorkspace(db, { workspaceName: 'Other Private Business', email: 'private@example.test', password: 'private-ui-acceptance-2026' });
  const otherItem = makeQuantityItem(db, other.ctx, { name: 'Private stock', baseCode: 'PRIVATE' });
  inventory.receive(db, other.ctx, { skuId: otherItem.skuId, locationId: other.main.id, quantity: 987 });
  postgres = openPostgres(cluster.connectionString, { applicationName: 'stockchief-ui-fixture' });
  await copyFixtureTables(db, postgres, [...new Set(operationalReview.SOURCES.map((source) => source.table)), 'workspaces']);
  for (const source of operationalReview.SOURCES) {
    await postgres.query(`ALTER TABLE ${source.table} ALTER COLUMN ${source.time}
      TYPE ${source.dateOnly ? 'DATE' : 'TIMESTAMPTZ'} USING NULLIF(${source.time}, '')::${source.dateOnly ? 'DATE' : 'TIMESTAMPTZ'}`);
  }
  await migratePostgres(postgres);
  await migratePostgres(postgres);
  const queued = await postgresJobs.enqueue(postgres, { workspaceId: workspace.workspaceId,
    kind: 'migration.acceptance-probe', idempotencyKey: 'review:probe', maxAttempts: 1 });
  const claimed = await postgresJobs.claim(postgres, { owner: 'fixture-setup' });
  await postgresJobs.fail(postgres, claimed.id, claimed.leaseToken, new Error('Qualification probe stopped; no business action was attempted.'), { retryable: false });
  const privateJob = await postgresJobs.enqueue(postgres, { workspaceId: other.workspaceId,
    kind: 'private-workspace-probe', idempotencyKey: 'private:probe', maxAttempts: 1 });
  const privateClaim = await postgresJobs.claim(postgres, { owner: 'fixture-setup' });
  await postgresJobs.fail(postgres, privateJob.job.id, privateClaim.leaseToken, new Error('Private probe'), { retryable: false });
  const makeStore = () => new PostgresSessionStore(postgres);
  stores = [makeStore(), makeStore()];
  await stores[0].ready;
  await stores[1].ready;
  const aiProvider = { name: 'unavailable-fixture', model: 'fixture', complete: async () => { throw new Error('No external model calls in this fixture.'); } };
  const appOptions = { db, env: 'test', sessionSecret: 'postgres-session-browser-acceptance', operationalReviewDatabase: postgres, runtimeJobDatabase: postgres, aiProvider };
  servers = stores.map((store) => createApp({ ...appOptions, sessionStore: store }).listen(0, '127.0.0.1'));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.once('listening', resolve))));
  const state = { type: 'ready', ports: servers.map((server) => server.address().port), email: workspace.account.email,
    password: workspace.account.password, billId: bill.bill.id, workspaceId: workspace.workspaceId };
  if (process.send) process.send(state);
  else {
    const output = path.resolve(__dirname, '../../artifacts/operations-review-state.json');
    fs.writeFileSync(output, JSON.stringify(state));
    console.log(`Visible PostgreSQL migration frontend: http://127.0.0.1:${state.ports[0]}/login`);
  }
  process.on('message', async (message) => {
    if (message.type === 'shutdown') {
      await stop();
      process.exit(0);
    }
    if (message.type === 'history-source-failure') {
      await postgres.query('ALTER TABLE customer_communications RENAME TO customer_communications_unavailable');
      process.send({ type: 'history-source-failure-ready' });
    }
    if (message.type === 'queue-state') {
      process.send({ type: 'queue-state-ready', job: await postgresJobs.get(postgres, queued.job.id, workspace.workspaceId) });
    }
  });
  process.on('SIGTERM', async () => {
    await stop();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    await stop();
    process.exit(0);
  });
}

start().catch(async (error) => {
  console.error(error.message);
  try { await stop(); } catch (cleanupError) { console.error(cleanupError.message); }
  process.exit(1);
});
