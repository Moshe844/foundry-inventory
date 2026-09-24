'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const { migrateSqliteToPostgres, openCutoverSource } = require('../../src/db/sqlite-to-postgres');
const { openDatabase } = require('../../src/db');
const { seedWorkspace, makeQuantityItem } = require('../helpers');
const inventory = require('../../src/domain/inventory-engine');
const auth = require('../../src/domain/auth-service');
const ledger = require('../../src/accounting/ledger');

test('the complete SQLite business moves atomically into constrained PostgreSQL', { timeout: 180000 }, async (context) => {
  const cluster = await startCluster();
  const postgres = openPostgres(cluster.connectionString, { applicationName: 'stockchief-business-migration-test' });
  const sqlitePath = path.join(cluster.directory, 'source.sqlite');
  const sqlite = openDatabase(sqlitePath);
  context.after(async () => {
    if (sqlite.open) sqlite.close();
    await postgres.close();
    cluster.stop();
  });

  const workspace = seedWorkspace(sqlite, { workspaceName: 'Cutover Business', email: 'cutover@example.test', password: 'cutover-password-2026' });
  const membership = auth.getMembership(sqlite, workspace.workspaceId, workspace.accountId);
  ledger.configure(sqlite, workspace.ctx, membership, { startDate: '2026-01-01', currency: 'USD' });
  const item = makeQuantityItem(sqlite, workspace.ctx, { name: 'Cutover Widget', baseCode: 'CUTOVER' });
  inventory.receive(sqlite, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 50,
    unitCostMinor: 725, reference: 'CUTOVER-OPENING' });
  inventory.issue(sqlite, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 7,
    reason: 'sale', reference: 'CUTOVER-SALE' });
  sqlite.prepare('DELETE FROM item_catalog_rollups WHERE item_id=?').run(item.itemId);
  sqlite.prepare('DELETE FROM item_location_balances WHERE item_id=?').run(item.itemId);
  sqlite.prepare("DELETE FROM search_documents WHERE entity_type='sku' AND entity_id=?").run(item.skuId);
  sqlite.pragma('wal_checkpoint(TRUNCATE)');

  const applied = await migratePostgres(postgres);
  assert.deepEqual(applied, ['000-business-schema.js', '001-runtime.sql',
    '002-business-operations.sql', '003-runtime-sessions.sql', '004-legacy-synthetic-evidence.sql',
    '005-complete-search-projections.sql', '006-assistant-runtime.sql', '007-job-event-order.sql',
    '008-email-reply-outbox.sql', '009-customer-return-evidence.sql', '010-supplier-return-account.sql',
    '011-provider-effects.sql','012-email-provider-effects.sql','013-payment-provider-effects.sql',
    '014-payment-deposits-refunds.sql', '015-operational-scope.sql', '016-assistant-pricing-actions.sql',
    '017-assistant-communication-actions.sql', '018-assistant-order-actions.sql',
    '019-assistant-receiving-payment-actions.sql']);
  await postgres.query(`CREATE FUNCTION reject_cutover_row() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic cutover failure'; END; $$`);
  await postgres.query(`CREATE TRIGGER reject_cutover_row BEFORE INSERT ON items
    FOR EACH ROW EXECUTE FUNCTION reject_cutover_row()`);
  await assert.rejects(migrateSqliteToPostgres({ sqlitePath, postgres, migrationId: 'cutover-failed' }),
    /synthetic cutover failure/);
  assert.equal((await postgres.query('SELECT COUNT(*) AS count FROM accounts')).rows[0].count, '0');
  assert.equal((await postgres.query('SELECT COUNT(*) AS count FROM movements')).rows[0].count, '0');
  assert.equal((await postgres.query(`SELECT status FROM stockchief_migration_runs
    WHERE id = 'cutover-failed'`)).rows[0].status, 'FAILED');
  await postgres.query('DROP TRIGGER reject_cutover_row ON items');
  await postgres.query('DROP FUNCTION reject_cutover_row()');

  const cutoverLock = openCutoverSource(sqlitePath);
  sqlite.pragma('busy_timeout = 1');
  assert.throws(() => sqlite.prepare(`INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at)
    VALUES('late-location',?,'Late write','warehouse',1,'2026-09-23T01:00:00.000Z')`).run(workspace.workspaceId),
  /locked/i);
  cutoverLock.exec('ROLLBACK');
  cutoverLock.close();
  sqlite.pragma('busy_timeout = 10000');

  let migrated;
  try {
    migrated = await migrateSqliteToPostgres({ sqlitePath, postgres, migrationId: 'cutover-one' });
  } catch (error) {
    context.diagnostic(`${error.message || error.code}\n${error.stack || ''}`);
    throw error;
  }
  assert.equal(migrated.reused, false);
  assert.equal(migrated.reconciliation.matches, true);
  assert.equal(migrated.reconciliation.business.on_hand.target, '43');
  assert.equal(migrated.reconciliation.business.movement_count.target, '2');
  assert.equal(migrated.reconciliation.balancedJournal, true);
  assert.equal(migrated.reconciliation.tables.item_catalog_rollups.sourceStored, '0');
  assert.equal(migrated.reconciliation.tables.item_catalog_rollups.target, '1');
  assert.equal(migrated.reconciliation.tables.item_location_balances.sourceStored, '0');
  assert.equal(migrated.reconciliation.tables.item_location_balances.target, '1');
  assert.equal(migrated.reconciliation.tables.search_documents.sourceStored, '1');
  assert.equal(migrated.reconciliation.tables.search_documents.target, '2');

  const balance = await postgres.query(`SELECT b.on_hand, i.name FROM balances b
    JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
    WHERE b.workspace_id = $1`, [workspace.workspaceId]);
  assert.deepEqual(balance.rows.map((row) => ({ name: row.name, onHand: Number(row.on_hand) })),
    [{ name: 'Cutover Widget', onHand: 43 }]);

  const replay = await migrateSqliteToPostgres({ sqlitePath, postgres, migrationId: 'cutover-replay' });
  assert.equal(replay.reused, true);
  assert.equal((await postgres.query('SELECT COUNT(*) AS count FROM movements')).rows[0].count, '2');

  await assert.rejects(postgres.query(`INSERT INTO balances(workspace_id, sku_id, location_id, on_hand, updated_at)
    VALUES ('missing-workspace', 'missing-sku', 'missing-location', 1, '2026-09-23T00:00:00.000Z')`), /foreign key/i);
  await assert.rejects(postgres.query('UPDATE movements SET quantity_delta = 999'), /immutable/i);
});
