'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const { createPostgresApp } = require('../../src/postgres-app');
const ledger = require('../../src/accounting/postgres-ledger');
const locations = require('../../src/domain/postgres-location-service');
const catalog = require('../../src/domain/postgres-catalog-service');
const commerce = require('../../src/operations/postgres-commerce');
const workflows = require('../../src/operations/postgres-business-workflows');

async function controlBalance(database, workspaceId, key) {
  const result = await database.query(`SELECT COALESCE(SUM(jl.debit_minor-jl.credit_minor),0)::bigint AS balance
    FROM accounting_journal_lines jl JOIN accounting_accounts a ON a.id=jl.account_id
    WHERE jl.workspace_id=$1 AND a.system_key=$2`, [workspaceId, key]);
  return Number(result.rows[0].balance);
}

test('real Chromium completes a PostgreSQL customer return without splitting inventory, cost, refund or accounting truth',
  { timeout: 180000 }, async (context) => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString, { applicationName: 'stockchief-postgres-customer-return-ui' });
    await migratePostgres(database);
    const app = createPostgresApp({ database, env: 'test', sessionSecret: 'postgres-customer-return-secret' });
    const server = await new Promise((resolve) => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    const browser = await chromium.launch();
    context.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve));
      await app.locals.sessionStore.close(); await database.close(); cluster.stop(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message)); page.setDefaultTimeout(15000);
    const base = `http://127.0.0.1:${server.address().port}`;

    await page.goto(`${base}/register`); await page.getByLabel('Business name').fill('Return Certification Business');
    await page.getByLabel('Your name').fill('Return Owner');
    await page.getByLabel('Work email').fill('returns-ui@example.test');
    await page.getByLabel('Password').fill('returns-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`), page.getByRole('button', { name: 'Create account' }).click()]);
    const identity = (await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id
      WHERE a.email='returns-ui@example.test'`)).rows[0];
    const ctx = { workspaceId: identity.workspace_id, actorId: identity.actor_id };
    const main = await locations.createLocation(database, ctx, { name: 'Main Warehouse', kind: 'warehouse' });
    const quarantine = await locations.createLocation(database, ctx, { name: 'Returns Quarantine', kind: 'warehouse' });
    const restock = await locations.createLocation(database, ctx, { name: 'Sellable Stock', kind: 'warehouse' });
    const item = await catalog.createItem(database, ctx, { name: 'Returnable Boot', baseCode: 'RBOOT',
      trackingMode: 'quantity', unitLabel: 'pair' });
    const supplier = await commerce.createSupplier(database, ctx, { name: 'Return Supply', email: 'supply@example.test' });
    const customer = await commerce.createCustomer(database, ctx, { name: 'Return Customer', email: 'buyer@example.test' });
    await ledger.configure(database, ctx, { startDate: '2026-01-01', currency: 'USD' });
    const purchase = await workflows.createPurchaseOrder(database, ctx, { supplierId: supplier.id,
      destinationLocationId: main.id, orderDate: '2026-09-20', idempotencyKey: 'return-ui:po:create',
      lines: [{ skuId: item.skuIds[0], quantityUnits: 10, unitCost: 8, destinationLocationId: main.id }] });
    await workflows.approvePurchaseOrder(database, ctx, purchase.purchaseOrderId, { idempotencyKey: 'return-ui:po:approve' });
    await workflows.placePurchaseOrder(database, ctx, purchase.purchaseOrderId, { idempotencyKey: 'return-ui:po:place' });
    await workflows.receivePurchaseOrder(database, ctx, purchase.purchaseOrderId, { idempotencyKey: 'return-ui:po:receive',
      reference: 'RETURN-OPENING', lines: [{ lineId: purchase.lineIds[0], quantity: 10, locationId: main.id }] });
    const order = await workflows.createSalesOrder(database, ctx, { customerId: customer.id, orderDate: '2026-09-21',
      deliveryMethod: 'PICKUP', fulfillmentLocationId: main.id, idempotencyKey: 'return-ui:sale:create',
      lines: [{ skuId: item.skuIds[0], quantity: 4, unitPriceMinor: 1500 }] });
    await workflows.confirmSalesOrder(database, ctx, order.salesOrderId, { idempotencyKey: 'return-ui:sale:confirm' });
    const fulfilled = await workflows.fulfillSalesOrder(database, ctx, order.salesOrderId, {
      idempotencyKey: 'return-ui:sale:fulfill', lines: [{ lineId: order.lineIds[0], quantity: 4, locationId: main.id }] });
    await workflows.recordCustomerPayment(database, ctx, { customerId: customer.id,
      customerInvoiceId: fulfilled.invoiceId, salesOrderId: order.salesOrderId, amountMinor: 6000,
      paymentDate: '2026-09-22', method: 'card', idempotencyKey: 'return-ui:payment' });

    await page.goto(`${base}/orders/${order.salesOrderId}`);
    await page.getByText('Start a controlled return', { exact: true }).click();
    await page.getByLabel('Quarantine location').selectOption(quarantine.id);
    await page.getByLabel('Return Returnable Boot quantity').fill('2');
    await page.getByLabel('Reason').fill('Customer changed size');
    await Promise.all([page.waitForURL(/\/returns\/rma_/), page.getByRole('button', { name: 'Request return' }).click()]);
    const returnId = page.url().split('/').pop();
    assert.match(await page.locator('main').innerText(), /No stock or money moved|does not alter inventory or money/i);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE sku_id=$1 AND location_id=$2',
      [item.skuIds[0], main.id])).rows[0].on_hand), 6);
    assert.equal(Number((await database.query('SELECT balance_minor FROM accounting_customer_invoices WHERE id=$1',
      [fulfilled.invoiceId])).rows[0].balance_minor), 0);

    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Authorize this return' }).click()]);
    assert.match(await page.locator('main').innerText(), /Inventory still has not changed/);
    await page.getByLabel('Returnable Boot received quantity').fill('2');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Record physical receipt into quarantine' }).click()]);
    assert.match(await page.locator('main').innerText(), /RMA-\d+ is received/);
    assert.match(await page.locator('main').innerText(), /Every received unit must be assigned once/);
    const receivedBalances = await database.query(`SELECT location_id,on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2 ORDER BY location_id`, [ctx.workspaceId, item.skuIds[0]]);
    assert.equal(Number(receivedBalances.rows.find((row) => row.location_id === main.id).on_hand), 6);
    assert.equal(Number(receivedBalances.rows.find((row) => row.location_id === quarantine.id).on_hand), 2);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'COST_OF_GOODS_SOLD'), 1600);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'INVENTORY_ASSET'), 6400);
    assert.equal(Number((await database.query('SELECT balance_minor FROM accounting_customer_invoices WHERE id=$1',
      [fulfilled.invoiceId])).rows[0].balance_minor), 0);

    await page.getByLabel('Returnable Boot restock quantity').fill('1');
    await page.getByLabel('Restock location').selectOption(restock.id);
    await page.locator('input[name^="scrap_"]').fill('1');
    await page.getByLabel('Condition note').fill('One sellable, one damaged');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Record inspection and disposition' }).click()]);
    assert.match(await page.locator('main').innerText(), /RMA-\d+ is awaiting refund/);
    const disposition = await database.query(`SELECT location_id,on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2 ORDER BY location_id`, [ctx.workspaceId, item.skuIds[0]]);
    assert.equal(Number(disposition.rows.find((row) => row.location_id === quarantine.id).on_hand), 0);
    assert.equal(Number(disposition.rows.find((row) => row.location_id === restock.id).on_hand), 1);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'INVENTORY_ASSET'), 5600);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'INVENTORY_ADJUSTMENTS'), 800);

    assert.match(await page.locator('main').innerText(), /Verified refund:\s*\$30\.00/);
    await page.getByLabel('Refund destination').selectOption('CASH');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Approve exact refund' }).click()]);
    assert.match(await page.locator('main').innerText(), /is complete/i);
    const finalState = (await database.query(`SELECT r.status,r.refund_id,i.status AS invoice_status,
        i.total_minor,i.balance_minor,ar.inventory_journal_entry_id,ar.journal_entry_id
      FROM customer_returns r JOIN accounting_customer_invoices i ON i.sales_order_id=r.sales_order_id
      JOIN accounting_sale_refunds ar ON ar.id=r.refund_id WHERE r.id=$1`, [returnId])).rows[0];
    assert.deepEqual({ returnStatus: finalState.status, invoiceStatus: finalState.invoice_status,
      totalMinor: Number(finalState.total_minor), balanceMinor: Number(finalState.balance_minor) },
    { returnStatus: 'COMPLETED', invoiceStatus: 'PAID', totalMinor: 3000, balanceMinor: 0 });
    assert.ok(finalState.inventory_journal_entry_id); assert.ok(finalState.journal_entry_id);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'SALES_RETURNS'), 3000);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'CASH'), 3000);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'COST_OF_GOODS_SOLD'), 1600);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'INVENTORY_ASSET'), 5600);

    await page.goto(`${base}/orders/${order.salesOrderId}`);
    await page.getByText('Start a controlled return', { exact: true }).click();
    await page.getByLabel('Quarantine location').selectOption(quarantine.id);
    await page.getByLabel('Expected outcome').selectOption('EXCHANGE');
    await page.getByLabel('Return Returnable Boot quantity').fill('1');
    await page.getByLabel('Reason').fill('Exchange for another pair');
    await Promise.all([page.waitForURL(/\/returns\/rma_/), page.getByRole('button', { name: 'Request return' }).click()]);
    const exchangeReturnId = page.url().split('/').pop();
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Authorize this return' }).click()]);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Record physical receipt into quarantine' }).click()]);
    await page.getByLabel('Returnable Boot restock quantity').fill('1');
    await page.getByLabel('Restock location').selectOption(main.id);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Record inspection and disposition' }).click()]);
    await page.getByLabel('Returnable Boot replacement quantity').fill('1');
    await page.getByLabel('Fulfillment location').selectOption(main.id);
    await Promise.all([page.waitForURL(/\/orders\/so_/), page.getByRole('button', { name: 'Prepare replacement order' }).click()]);
    const replacementOrderId = page.url().split('/').pop();
    assert.notEqual(replacementOrderId, order.salesOrderId);
    assert.match(await page.locator('main').innerText(), /\$0\.00 each/);
    const exchangeState = (await database.query(`SELECT r.status,r.return_number,r.exchange_order_id,so.status AS order_status,
        so.reference,sol.quantity_ordered,sol.unit_price_minor
      FROM customer_returns r JOIN sales_orders so ON so.id=r.exchange_order_id
      JOIN sales_order_lines sol ON sol.sales_order_id=so.id WHERE r.id=$1`, [exchangeReturnId])).rows[0];
    assert.deepEqual({ returnStatus: exchangeState.status, exchangeOrderId: exchangeState.exchange_order_id,
      orderStatus: exchangeState.order_status, reference: exchangeState.reference,
      quantity: Number(exchangeState.quantity_ordered), price: Number(exchangeState.unit_price_minor) },
    { returnStatus: 'COMPLETED', exchangeOrderId: replacementOrderId, orderStatus: 'DRAFT',
      reference: `Exchange for ${exchangeState.return_number}`, quantity: 1, price: 0 });
    assert.equal(await controlBalance(database, ctx.workspaceId, 'SALES_RETURNS'), 3000);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'CASH'), 3000);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'COST_OF_GOODS_SOLD'), 800);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'INVENTORY_ASSET'), 6400);
    const journals = await database.query(`SELECT je.id FROM accounting_journal_entries je
      JOIN accounting_journal_lines jl ON jl.entry_id=je.id WHERE je.workspace_id=$1
      GROUP BY je.id HAVING SUM(jl.debit_minor)<>SUM(jl.credit_minor)`, [ctx.workspaceId]);
    assert.equal(journals.rows.length, 0);
    const physical = await database.query(`SELECT COALESCE(SUM(quantity_delta),0)::bigint AS quantity
      FROM movements WHERE workspace_id=$1`, [ctx.workspaceId]);
    const balances = await database.query(`SELECT COALESCE(SUM(on_hand),0)::bigint AS quantity
      FROM balances WHERE workspace_id=$1`, [ctx.workspaceId]);
    assert.equal(Number(physical.rows[0].quantity), Number(balances.rows[0].quantity));
    assert.deepEqual(errors, []);
  });
