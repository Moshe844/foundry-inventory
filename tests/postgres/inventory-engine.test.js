'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const inventory = require('../../src/domain/postgres-inventory-engine');

async function seed(database) {
  const at = '2026-09-23T00:00:00.000Z';
  await database.query(`INSERT INTO accounts(id,email,name,password_hash,created_at)
    VALUES ('acct','postgres-inventory@example.test','Postgres Owner','test',$1)`, [at]);
  await database.query(`INSERT INTO workspaces(id,name,owner_account_id,created_at)
    VALUES ('ws','PostgreSQL Inventory','acct',$1)`, [at]);
  await database.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
    VALUES ('user','ws','acct','Postgres Owner','owner',$1)`, [at]);
  await database.query(`INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at) VALUES
    ('main','ws','Main','warehouse',1,$1), ('overflow','ws','Overflow','warehouse',1,$1)`, [at]);
  for (const [id, mode] of [['quantity','quantity'],['lot','lot'],['serial','serial']]) {
    await database.query(`INSERT INTO items
      (id,workspace_id,name,base_code,tracking_mode,is_active,created_at,updated_at)
      VALUES ($1,'ws',$2,$3,$4,1,$5,$5)`, [`item-${id}`, `${id} item`, id.toUpperCase(), mode, at]);
    await database.query(`INSERT INTO skus
      (id,workspace_id,item_id,code,is_default,is_active,created_at)
      VALUES ($1,'ws',$2,$3,1,1,$4)`, [`sku-${id}`, `item-${id}`, id.toUpperCase(), at]);
  }
  return { workspaceId: 'ws', actorId: 'user' };
}

test('native PostgreSQL inventory preserves quantity, lot, serial and concurrency invariants', { timeout: 120000 }, async (context) => {
  const cluster = await startCluster();
  const database = openPostgres(cluster.connectionString, { applicationName: 'stockchief-postgres-inventory-test' });
  context.after(async () => { await database.close(); cluster.stop(); });
  await migratePostgres(database);
  const ctx = await seed(database);

  const received = await inventory.receive(database, ctx, { skuId:'sku-quantity', locationId:'main', quantity:10,
    reference:'OPEN', idempotencyKey:'receive:quantity' });
  assert.equal(received.balanceAfter, 10);
  const replayed = await inventory.receive(database, ctx, { skuId:'sku-quantity', locationId:'main', quantity:10,
    reference:'OPEN', idempotencyKey:'receive:quantity' });
  assert.equal(replayed.replayed, true);

  const competing = await Promise.allSettled([
    inventory.issue(database, ctx, { skuId:'sku-quantity', locationId:'main', quantity:7, reasonCode:'sale', idempotencyKey:'issue:a' }),
    inventory.issue(database, ctx, { skuId:'sku-quantity', locationId:'main', quantity:7, reasonCode:'sale', idempotencyKey:'issue:b' }),
  ]);
  assert.equal(competing.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(competing.filter((entry) => entry.status === 'rejected').length, 1);
  assert.match(competing.find((entry) => entry.status === 'rejected').reason.message, /Not enough stock/);
  assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE sku_id='sku-quantity' AND location_id='main'`)).rows[0].on_hand), 3);

  const transferred = await inventory.transfer(database, ctx, { skuId:'sku-quantity', sourceLocationId:'main',
    destinationLocationId:'overflow', quantity:2, idempotencyKey:'transfer:quantity' });
  assert.equal(transferred.sourceAfter, 1);
  assert.equal(transferred.destinationAfter, 2);
  const adjusted = await inventory.adjust(database, ctx, { skuId:'sku-quantity', locationId:'main', countedQuantity:4,
    reasonCode:'count_correction', idempotencyKey:'adjust:quantity' });
  assert.equal(adjusted.expected, 1);
  assert.equal(adjusted.balanceAfter, 4);
  const unchanged = await inventory.adjust(database, ctx, { skuId:'sku-quantity', locationId:'main', countedQuantity:4,
    reasonCode:'physical_count', idempotencyKey:'adjust:unchanged' });
  assert.equal(unchanged.unchanged, true);
  const unchangedReplay = await inventory.adjust(database, ctx, { skuId:'sku-quantity', locationId:'main', countedQuantity:4,
    reasonCode:'physical_count', idempotencyKey:'adjust:unchanged' });
  assert.equal(unchangedReplay.replayed, true);

  const lotReceipt = await inventory.receive(database, ctx, { skuId:'sku-lot', locationId:'main', quantity:12,
    lotCode:'LOT-2026', expiresAt:'2027-09-23', idempotencyKey:'receive:lot' });
  await inventory.transfer(database, ctx, { skuId:'sku-lot', sourceLocationId:'main', destinationLocationId:'overflow',
    quantity:5, lotId:lotReceipt.lotId, idempotencyKey:'transfer:lot' });
  await inventory.issue(database, ctx, { skuId:'sku-lot', locationId:'overflow', quantity:2,
    lotId:lotReceipt.lotId, reasonCode:'sale', idempotencyKey:'issue:lot' });
  assert.equal(Number((await database.query(`SELECT quantity FROM lot_balances
    WHERE lot_id=$1 AND location_id='overflow'`, [lotReceipt.lotId])).rows[0].quantity), 3);

  await inventory.receive(database, ctx, { skuId:'sku-serial', locationId:'main', quantity:2,
    serials:['SER-001','SER-002'], idempotencyKey:'receive:serial' });
  const serials = await database.query(`SELECT id,serial FROM serial_units WHERE sku_id='sku-serial' ORDER BY serial`);
  await inventory.transfer(database, ctx, { skuId:'sku-serial', sourceLocationId:'main', destinationLocationId:'overflow',
    quantity:1, serialUnitIds:[serials.rows[0].id], idempotencyKey:'transfer:serial' });
  await inventory.issue(database, ctx, { skuId:'sku-serial', locationId:'overflow', quantity:1,
    serialUnitIds:[serials.rows[0].id], reasonCode:'sale', idempotencyKey:'issue:serial' });
  const issueEvidence = await database.query(`SELECT serial_unit_id FROM stockchief_runtime.inventory_movement_serial_units
    WHERE workspace_id='ws' AND serial_unit_id=$1`, [serials.rows[0].id]);
  assert.equal(issueEvidence.rows.length, 4);
  const returned = await inventory.receive(database, ctx, { skuId:'sku-serial', locationId:'main', quantity:1,
    returnSerialUnitIds:[serials.rows[0].id], returnCondition:'unknown', idempotencyKey:'return:serial' });
  assert.deepEqual(returned.serialUnitIds, [serials.rows[0].id]);
  assert.deepEqual((await database.query(`SELECT serial,status,location_id FROM serial_units ORDER BY serial`)).rows,
    [{ serial:'SER-001', status:'in_stock', location_id:'main' }, { serial:'SER-002', status:'in_stock', location_id:'main' }]);
  await assert.rejects(inventory.receive(database, ctx, { skuId:'sku-serial', locationId:'main', quantity:1,
    returnSerialUnitIds:[serials.rows[0].id], idempotencyKey:'return:serial:twice' }), /already returned/i);

  const companyTotal = await database.query(`SELECT COALESCE(SUM(on_hand),0) AS total FROM balances WHERE workspace_id='ws'`);
  const ledgerTotal = await database.query(`SELECT COALESCE(SUM(quantity_delta),0) AS total FROM movements WHERE workspace_id='ws'`);
  assert.equal(companyTotal.rows[0].total, ledgerTotal.rows[0].total);
  await assert.rejects(database.query(`UPDATE movements SET quantity_delta=999 WHERE workspace_id='ws'`), /immutable/i);
});
