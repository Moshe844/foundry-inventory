'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const ledger = require('../../src/accounting/postgres-ledger');
const workflows = require('../../src/operations/postgres-business-workflows');

async function seed(database) {
  const at = '2026-09-23T00:00:00.000Z';
  await database.query(`INSERT INTO accounts(id,email,name,password_hash,created_at)
    VALUES('account','reservation-stress@example.test','Owner','test',$1)`, [at]);
  await database.query(`INSERT INTO workspaces(id,name,owner_account_id,created_at)
    VALUES('workspace','Reservation Stress','account',$1)`, [at]);
  await database.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
    VALUES('owner','workspace','account','Owner','owner',$1)`, [at]);
  await database.query(`INSERT INTO locations(id,workspace_id,name,kind,address,is_active,created_at)
    VALUES('main','workspace','Main warehouse','warehouse','1 Main St',1,$1)`, [at]);
  await database.query(`INSERT INTO items
    (id,workspace_id,name,base_code,tracking_mode,is_active,created_at,updated_at)
    VALUES('item','workspace','Concurrent widget','WIDGET','quantity',1,$1,$1)`, [at]);
  await database.query(`INSERT INTO skus
    (id,workspace_id,item_id,code,is_default,is_active,created_at)
    VALUES('sku','workspace','item','WIDGET-1',1,1,$1)`, [at]);
  await database.query(`INSERT INTO suppliers
    (id,workspace_id,name,status,currency,created_at,updated_at)
    VALUES('supplier','workspace','Widget Supply','active','USD',$1,$1)`, [at]);
  await database.query(`INSERT INTO supplier_items
    (id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,units_per_purchase_unit,last_unit_cost,
     is_preferred,is_active,created_at,updated_at)
    VALUES('supplier-item','workspace','supplier','sku','V-WIDGET','each',1,8.00,1,1,$1,$1)`, [at]);
  await database.query(`INSERT INTO customers
    (id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('customer','workspace','Concurrent Buyer','buyer@example.test','10 Buyer Rd','ACTIVE','owner',$1,$1)`, [at]);
  const ctx = { workspaceId: 'workspace', actorId: 'owner' };
  await ledger.configure(database, ctx, { startDate: '2026-01-01', currency: 'USD' });
  const purchase = await workflows.createPurchaseOrder(database, ctx, {
    supplierId: 'supplier', destinationLocationId: 'main', idempotencyKey: 'stress:purchase',
    lines: [{ skuId: 'sku', quantityUnits: 100, unitCost: 8 }],
  });
  await workflows.approvePurchaseOrder(database, ctx, purchase.purchaseOrderId,
    { idempotencyKey: 'stress:purchase:approve' });
  await workflows.placePurchaseOrder(database, ctx, purchase.purchaseOrderId,
    { idempotencyKey: 'stress:purchase:place' });
  await workflows.receivePurchaseOrder(database, ctx, purchase.purchaseOrderId, {
    idempotencyKey: 'stress:purchase:receive',
    lines: [{ lineId: purchase.lineIds[0], quantity: 100, locationId: 'main' }],
  });
  return ctx;
}

async function accountBalance(database, systemKey) {
  const result = await database.query(`SELECT COALESCE(SUM(line.debit_minor-line.credit_minor),0) AS balance
    FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id
    WHERE line.workspace_id='workspace' AND account.system_key=$1`, [systemKey]);
  return Number(result.rows[0].balance);
}

test('competing PostgreSQL reservations and fulfillments never oversell or corrupt accounting',
  { timeout: 180000 }, async (context) => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString,
      { applicationName: 'stockchief-reservation-concurrency', max: 30 });
    context.after(async () => { await database.close(); cluster.stop(); });
    await migratePostgres(database);
    const ctx = await seed(database);

    const orders = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      workflows.createSalesOrder(database, ctx, {
        customerId: 'customer', deliveryMethod: 'PICKUP', idempotencyKey: `stress:order:${index}`,
        lines: [{ skuId: 'sku', quantity: 7, unitPriceMinor: 1500 }],
      })));
    const confirmations = await Promise.all(orders.map((order, index) =>
      workflows.confirmSalesOrder(database, ctx, order.salesOrderId,
        { idempotencyKey: `stress:confirm:${index}` })));

    const allocated = confirmations.flatMap((confirmation, index) => confirmation.allocations.map((allocation) => ({
      order: orders[index], index, allocation,
    })));
    assert.equal(allocated.reduce((sum, entry) => sum + entry.allocation.quantity, 0), 100);
    const statusCounts = confirmations.reduce((counts, confirmation) => {
      counts[confirmation.status] = (counts[confirmation.status] || 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(statusCounts, { CONFIRMED: 14, BACKORDERED: 10 });
    assert.equal(Number((await database.query(`SELECT COALESCE(SUM(quantity),0) AS quantity
      FROM sales_order_allocations WHERE workspace_id='workspace'`)).rows[0].quantity), 100);

    const fulfillmentResults = await Promise.allSettled(allocated.map(({ order, index, allocation }) =>
      workflows.fulfillSalesOrder(database, ctx, order.salesOrderId, {
        idempotencyKey: `stress:fulfill:${index}`,
        lines: [{ lineId: allocation.lineId, quantity: allocation.quantity, locationId: allocation.locationId }],
      })));
    assert.equal(fulfillmentResults.filter((result) => result.status === 'rejected').length, 0,
      fulfillmentResults.filter((result) => result.status === 'rejected').map((result) => result.reason?.message).join('; '));

    const inventoryState = (await database.query(`SELECT
      (SELECT on_hand FROM balances WHERE workspace_id='workspace' AND sku_id='sku' AND location_id='main') AS on_hand,
      (SELECT quantity_units FROM accounting_inventory_cost_balances
        WHERE workspace_id='workspace' AND sku_id='sku' AND location_id='main') AS cost_quantity,
      (SELECT total_cost_minor FROM accounting_inventory_cost_balances
        WHERE workspace_id='workspace' AND sku_id='sku' AND location_id='main') AS cost_minor,
      (SELECT COALESCE(SUM(quantity),0) FROM sales_order_allocations WHERE workspace_id='workspace') AS allocated,
      (SELECT COALESCE(SUM(quantity_fulfilled),0) FROM sales_order_lines WHERE workspace_id='workspace') AS fulfilled,
      (SELECT COALESCE(SUM(balance_minor),0) FROM accounting_customer_invoices WHERE workspace_id='workspace') AS receivable`)).rows[0];
    assert.deepEqual({
      onHand: Number(inventoryState.on_hand),
      costQuantity: Number(inventoryState.cost_quantity),
      costMinor: Number(inventoryState.cost_minor),
      allocated: Number(inventoryState.allocated),
      fulfilled: Number(inventoryState.fulfilled),
      receivable: Number(inventoryState.receivable),
    }, { onHand: 0, costQuantity: 0, costMinor: 0, allocated: 0, fulfilled: 100, receivable: 150000 });
    assert.equal(await accountBalance(database, 'INVENTORY_ASSET'), 0);
    assert.equal(await accountBalance(database, 'COST_OF_GOODS_SOLD'), 80000);
    assert.equal(await accountBalance(database, 'ACCOUNTS_RECEIVABLE'), 150000);
    assert.equal(await accountBalance(database, 'SALES_REVENUE'), -150000);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM accounting_journal_entries entry
      JOIN accounting_journal_lines line ON line.entry_id=entry.id
      GROUP BY entry.id HAVING SUM(line.debit_minor)<>SUM(line.credit_minor)`)).rows.length, 0);
  });
