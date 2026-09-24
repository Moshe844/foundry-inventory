'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const ledger = require('../../src/accounting/postgres-ledger');
const workflows = require('../../src/operations/postgres-business-workflows');
const jobs = require('../../src/operations/postgres-job-queue');
const businessHandlers = require('../../src/operations/postgres-business-handlers');

async function seed(database) {
  const at = '2026-09-23T00:00:00.000Z';
  await database.query(`INSERT INTO accounts(id,email,name,password_hash,created_at)
    VALUES('account','business-workflows@example.test','Owner','test',$1)`, [at]);
  await database.query(`INSERT INTO workspaces(id,name,owner_account_id,created_at)
    VALUES('workspace','PostgreSQL Business','account',$1)`, [at]);
  await database.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
    VALUES('owner','workspace','account','Owner','owner',$1)`, [at]);
  await database.query(`INSERT INTO accounts(id,email,name,password_hash,created_at)
    VALUES('staff-account','staff-business-workflows@example.test','Staff','test',$1)`, [at]);
  await database.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
    VALUES('staff','workspace','staff-account','Staff','staff',$1)`, [at]);
  await database.query(`INSERT INTO locations(id,workspace_id,name,kind,address,is_active,created_at)
    VALUES('main','workspace','Main warehouse','warehouse','1 Main St',1,$1)`, [at]);
  await database.query(`INSERT INTO items
    (id,workspace_id,name,base_code,tracking_mode,is_active,created_at,updated_at)
    VALUES('item','workspace','Safety shoe','SHOE','quantity',1,$1,$1)`, [at]);
  await database.query(`INSERT INTO skus
    (id,workspace_id,item_id,code,is_default,is_active,created_at)
    VALUES('sku','workspace','item','SHOE-9',1,1,$1)`, [at]);
  await database.query(`INSERT INTO suppliers
    (id,workspace_id,name,status,currency,created_at,updated_at)
    VALUES('supplier','workspace','Safe Supply','active','USD',$1,$1)`, [at]);
  await database.query(`INSERT INTO supplier_items
    (id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,units_per_purchase_unit,last_unit_cost,
     is_preferred,is_active,created_at,updated_at)
    VALUES('supplier-item','workspace','supplier','sku','SAFE-9','case',5,8.00,1,1,$1,$1)`, [at]);
  await database.query(`INSERT INTO customers
    (id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('customer','workspace','Builder Co','buyer@example.test','10 Jobsite Rd','ACTIVE','owner',$1,$1)`, [at]);
  const ctx = { workspaceId: 'workspace', actorId: 'owner' };
  await ledger.configure(database, ctx, { startDate: '2026-01-01', currency: 'USD' });
  return ctx;
}

async function accountBalance(database, key) {
  const result = await database.query(`SELECT COALESCE(SUM(jl.debit_minor-jl.credit_minor),0) AS balance
    FROM accounting_journal_lines jl JOIN accounting_accounts a ON a.id=jl.account_id
    WHERE jl.workspace_id='workspace' AND a.system_key=$1`, [key]);
  return Number(result.rows[0].balance);
}

test('PostgreSQL purchasing, receiving, sales and payments remain one reconciled business story',
  { timeout: 120000 }, async (context) => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString, { applicationName: 'stockchief-business-workflows-test' });
    context.after(async () => { await database.close(); cluster.stop(); });
    await migratePostgres(database);
    const ctx = await seed(database);

    await assert.rejects(workflows.createPurchaseOrder(database,
      { workspaceId: 'workspace', actorId: 'staff' }, {
        supplierId: 'supplier', destinationLocationId: 'main', idempotencyKey: 'staff:po:create',
        lines: [{ skuId: 'sku', quantityUnits: 5, unitCost: 8 }],
      }), /permission/i);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM purchase_orders`)).rows[0].count, '0');

    const createdPo = await workflows.createPurchaseOrder(database, ctx, {
      supplierId: 'supplier', destinationLocationId: 'main', idempotencyKey: 'po:create:1',
      lines: [{ skuId: 'sku', quantityUnits: 10, unitCost: 8 }],
    });
    assert.equal(createdPo.status, 'DRAFT');
    assert.equal((await workflows.createPurchaseOrder(database, ctx, {
      supplierId: 'supplier', destinationLocationId: 'main', idempotencyKey: 'po:create:1',
      lines: [{ skuId: 'sku', quantityUnits: 10, unitCost: 8 }],
    })).replayed, true);
    await workflows.approvePurchaseOrder(database, ctx, createdPo.purchaseOrderId, { idempotencyKey: 'po:approve:1' });
    await workflows.placePurchaseOrder(database, ctx, createdPo.purchaseOrderId, { idempotencyKey: 'po:place:1' });

    const firstReceipt = await workflows.receivePurchaseOrder(database, ctx, createdPo.purchaseOrderId, {
      idempotencyKey: 'po:receive:1', reference: 'DN-1',
      lines: [{ lineId: createdPo.lineIds[0], quantity: 6, locationId: 'main' }],
    });
    assert.equal(firstReceipt.status, 'PARTIALLY_RECEIVED');
    assert.equal((await workflows.receivePurchaseOrder(database, ctx, createdPo.purchaseOrderId, {
      idempotencyKey: 'po:receive:1', reference: 'DN-1',
      lines: [{ lineId: createdPo.lineIds[0], quantity: 6, locationId: 'main' }],
    })).replayed, true);
    const finalReceipt = await workflows.receivePurchaseOrder(database, ctx, createdPo.purchaseOrderId, {
      idempotencyKey: 'po:receive:2', reference: 'DN-2',
      lines: [{ lineId: createdPo.lineIds[0], quantity: 4, locationId: 'main' }],
    });
    assert.equal(finalReceipt.status, 'RECEIVED');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE sku_id='sku' AND location_id='main'`)).rows[0].on_hand), 10);
    assert.equal(Number((await database.query(`SELECT quantity_units FROM accounting_inventory_cost_balances
      WHERE sku_id='sku' AND location_id='main'`)).rows[0].quantity_units), 10);
    assert.equal(Number((await database.query(`SELECT total_cost_minor FROM accounting_inventory_cost_balances
      WHERE sku_id='sku' AND location_id='main'`)).rows[0].total_cost_minor), 8000);
    assert.equal(await accountBalance(database, 'INVENTORY_ASSET'), 8000);
    assert.equal(await accountBalance(database, 'RECEIVED_NOT_INVOICED'), -8000);

    const movementCountBeforeInvoice = Number((await database.query(`SELECT COUNT(*) AS count FROM movements`)).rows[0].count);
    const disputedInvoice = await workflows.recordSupplierInvoice(database, ctx, {
      supplierId: 'supplier', purchaseOrderId: createdPo.purchaseOrderId,
      supplierInvoiceNumber: 'BAD-1', issueDate: '2026-09-23', idempotencyKey: 'supplier-invoice:bad',
      lines: [{ purchaseOrderLineId: createdPo.lineIds[0], skuId: 'sku', quantity: 11,
        unitCostMinor: 800, description: 'Too many shoes' }],
    });
    assert.equal(disputedInvoice.status, 'DISPUTED');
    assert.equal(disputedInvoice.matchStatus, 'EXCEPTION');
    assert.equal(disputedInvoice.journalEntryId, null);
    assert.equal(disputedInvoice.differences[0].kind, 'invoice_ahead_of_receipt');
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM accounting_supplier_bills`)).rows[0].count), 1);
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM movements`)).rows[0].count), movementCountBeforeInvoice);

    const supplierInvoice = await workflows.recordSupplierInvoice(database, ctx, {
      supplierId: 'supplier', purchaseOrderId: createdPo.purchaseOrderId,
      supplierInvoiceNumber: 'SUP-100', issueDate: '2026-09-23', idempotencyKey: 'supplier-invoice:1',
      lines: [{ purchaseOrderLineId: createdPo.lineIds[0], skuId: 'sku', quantity: 10,
        unitCostMinor: 800, description: 'Safety shoes' }],
    });
    assert.equal(supplierInvoice.totalMinor, 8000);
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM movements`)).rows[0].count), movementCountBeforeInvoice);
    assert.equal(await accountBalance(database, 'RECEIVED_NOT_INVOICED'), 0);
    assert.equal(await accountBalance(database, 'ACCOUNTS_PAYABLE'), -8000);

    const supplierPartPayment = await workflows.recordSupplierPayment(database, ctx, {
      supplierId: 'supplier', supplierBillId: supplierInvoice.billId, amountMinor: 3000,
      paymentDate: '2026-09-23', method: 'ACH', idempotencyKey: 'supplier-payment:1',
    });
    assert.equal(supplierPartPayment.balanceMinor, 5000);
    assert.equal(supplierPartPayment.status, 'PARTIALLY_PAID');

    const order = await workflows.createSalesOrder(database, ctx, {
      customerId: 'customer', deliveryMethod: 'SHIP', idempotencyKey: 'sales:create:1',
      lines: [{ skuId: 'sku', quantity: 8, unitPriceMinor: 1500 }],
    });
    const confirmed = await workflows.confirmSalesOrder(database, ctx, order.salesOrderId,
      { idempotencyKey: 'sales:confirm:1' });
    assert.equal(confirmed.status, 'CONFIRMED');
    assert.equal(confirmed.allocations[0].quantity, 8);

    await database.query(`UPDATE accounting_accounts SET active=0
      WHERE workspace_id='workspace' AND system_key='SALES_REVENUE'`);
    const movementCountBeforeFailure = Number((await database.query(`SELECT COUNT(*) AS count FROM movements`)).rows[0].count);
    await assert.rejects(workflows.fulfillSalesOrder(database, ctx, order.salesOrderId, {
      idempotencyKey: 'sales:fulfill:forced-failure',
      lines: [{ lineId: order.lineIds[0], quantity: 1, locationId: 'main' }],
    }), /control accounts are missing/i);
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM movements`)).rows[0].count), movementCountBeforeFailure);
    assert.equal(Number((await database.query(`SELECT quantity_fulfilled FROM sales_order_lines WHERE id=$1`, [order.lineIds[0]])).rows[0].quantity_fulfilled), 0);
    assert.equal(Number((await database.query(`SELECT quantity FROM sales_order_allocations WHERE sales_order_line_id=$1`, [order.lineIds[0]])).rows[0].quantity), 8);
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE sku_id='sku' AND location_id='main'`)).rows[0].on_hand), 10);
    await database.query(`UPDATE accounting_accounts SET active=1
      WHERE workspace_id='workspace' AND system_key='SALES_REVENUE'`);

    const competing = await Promise.allSettled([
      workflows.fulfillSalesOrder(database, ctx, order.salesOrderId, {
        idempotencyKey: 'sales:fulfill:a', lines: [{ lineId: order.lineIds[0], quantity: 5, locationId: 'main' }],
      }),
      workflows.fulfillSalesOrder(database, ctx, order.salesOrderId, {
        idempotencyKey: 'sales:fulfill:b', lines: [{ lineId: order.lineIds[0], quantity: 5, locationId: 'main' }],
      }),
    ]);
    assert.equal(competing.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(competing.filter((entry) => entry.status === 'rejected').length, 1);
    assert.equal(Number((await database.query(`SELECT quantity_fulfilled FROM sales_order_lines WHERE id=$1`, [order.lineIds[0]])).rows[0].quantity_fulfilled), 5);
    const firstFulfillment = competing.find((entry) => entry.status === 'fulfilled').value;
    const finalFulfillment = await workflows.fulfillSalesOrder(database, ctx, order.salesOrderId, {
      idempotencyKey: 'sales:fulfill:final', lines: [{ lineId: order.lineIds[0], quantity: 3, locationId: 'main' }],
    });
    assert.equal(finalFulfillment.status, 'FULFILLED');
    assert.equal(finalFulfillment.invoiceId, firstFulfillment.invoiceId);
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE sku_id='sku' AND location_id='main'`)).rows[0].on_hand), 2);
    const cost = (await database.query(`SELECT quantity_units,total_cost_minor FROM accounting_inventory_cost_balances
      WHERE sku_id='sku' AND location_id='main'`)).rows[0];
    assert.deepEqual({ quantity: Number(cost.quantity_units), cost: Number(cost.total_cost_minor) }, { quantity: 2, cost: 1600 });
    const invoice = (await database.query(`SELECT * FROM accounting_customer_invoices WHERE id=$1`, [finalFulfillment.invoiceId])).rows[0];
    assert.equal(Number(invoice.total_minor), 12000);
    assert.equal(Number(invoice.balance_minor), 12000);
    assert.equal(await accountBalance(database, 'ACCOUNTS_RECEIVABLE'), 12000);
    assert.equal(await accountBalance(database, 'SALES_REVENUE'), -12000);
    assert.equal(await accountBalance(database, 'COST_OF_GOODS_SOLD'), 6400);
    assert.equal(await accountBalance(database, 'INVENTORY_ASSET'), 1600);

    const customerPartPayment = await workflows.recordCustomerPayment(database, ctx, {
      customerId: 'customer', customerInvoiceId: invoice.id, salesOrderId: order.salesOrderId,
      amountMinor: 5000, paymentDate: '2026-09-23', method: 'card', idempotencyKey: 'customer-payment:1',
    });
    assert.equal(customerPartPayment.balanceMinor, 7000);
    await workflows.recordCustomerPayment(database, ctx, {
      customerId: 'customer', customerInvoiceId: invoice.id, salesOrderId: order.salesOrderId,
      amountMinor: 7000, paymentDate: '2026-09-23', method: 'ACH', idempotencyKey: 'customer-payment:2',
    });
    await workflows.recordSupplierPayment(database, ctx, {
      supplierId: 'supplier', supplierBillId: supplierInvoice.billId, amountMinor: 5000,
      paymentDate: '2026-09-23', method: 'ACH', idempotencyKey: 'supplier-payment:2',
    });
    assert.equal((await database.query(`SELECT status FROM accounting_customer_invoices WHERE id=$1`, [invoice.id])).rows[0].status, 'PAID');
    assert.equal((await database.query(`SELECT status FROM accounting_supplier_bills WHERE id=$1`, [supplierInvoice.billId])).rows[0].status, 'PAID');
    assert.equal(await accountBalance(database, 'ACCOUNTS_RECEIVABLE'), 0);
    assert.equal(await accountBalance(database, 'ACCOUNTS_PAYABLE'), 0);

    const journals = await database.query(`SELECT je.id,SUM(jl.debit_minor) AS debit,SUM(jl.credit_minor) AS credit
      FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl.entry_id=je.id
      GROUP BY je.id HAVING SUM(jl.debit_minor)<>SUM(jl.credit_minor)`);
    assert.equal(journals.rows.length, 0);
    const physical = await database.query(`SELECT COALESCE(SUM(quantity_delta),0) AS quantity FROM movements WHERE workspace_id='workspace'`);
    const balance = await database.query(`SELECT COALESCE(SUM(on_hand),0) AS quantity FROM balances WHERE workspace_id='workspace'`);
    assert.equal(physical.rows[0].quantity, balance.rows[0].quantity);

    const queued = await jobs.enqueue(database, { workspaceId: 'workspace', kind: 'purchase-order.create',
      idempotencyKey: 'worker:po:create', payload: { actorId: 'owner', input: {
        supplierId: 'supplier', destinationLocationId: 'main',
        lines: [{ skuId: 'sku', quantityUnits: 5, unitCost: 8 }],
      } } });
    const completed = await jobs.processOne(database, businessHandlers.create(), { owner: 'business-worker', leaseMs: 10000 });
    assert.equal(completed.id, queued.job.id);
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(completed.result.purchaseOrderId);
    assert.equal((await database.query(`SELECT status FROM purchase_orders WHERE id=$1`,
      [completed.result.purchaseOrderId])).rows[0].status, 'DRAFT');
  });
