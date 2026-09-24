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

test('real Chromium separates PostgreSQL supplier-return shipment from credit and exposes mismatches',
  { timeout: 180000 }, async (context) => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString, { applicationName: 'stockchief-postgres-supplier-return-ui' });
    await migratePostgres(database);
    const app = createPostgresApp({ database, env: 'test', sessionSecret: 'postgres-supplier-return-secret' });
    const server = await new Promise((resolve) => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    const browser = await chromium.launch();
    context.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve));
      await app.locals.sessionStore.close(); await database.close(); cluster.stop(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message)); page.setDefaultTimeout(15000);
    const base = `http://127.0.0.1:${server.address().port}`;

    await page.goto(`${base}/register`); await page.getByLabel('Business name').fill('Supplier Return Business');
    await page.getByLabel('Your name').fill('Supplier Return Owner');
    await page.getByLabel('Work email').fill('supplier-returns-ui@example.test');
    await page.getByLabel('Password').fill('supplier-returns-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`), page.getByRole('button', { name: 'Create account' }).click()]);
    const identity = (await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id
      WHERE a.email='supplier-returns-ui@example.test'`)).rows[0];
    const ctx = { workspaceId: identity.workspace_id, actorId: identity.actor_id };
    const main = await locations.createLocation(database, ctx, { name: 'Supplier Return Warehouse', kind: 'warehouse' });
    const item = await catalog.createItem(database, ctx, { name: 'Supplier Return Boot', baseCode: 'SRTN',
      trackingMode: 'quantity', unitLabel: 'pair' });
    const supplier = await commerce.createSupplier(database, ctx, { name: 'Credit Memo Supply', email: 'credits@example.test' });
    await ledger.configure(database, ctx, { startDate: '2026-01-01', currency: 'USD' });
    const purchase = await workflows.createPurchaseOrder(database, ctx, { supplierId: supplier.id,
      destinationLocationId: main.id, orderDate: '2026-09-20', idempotencyKey: 'supplier-return-ui:po:create',
      lines: [{ skuId: item.skuIds[0], quantityUnits: 10, unitCost: 8, destinationLocationId: main.id }] });
    await workflows.approvePurchaseOrder(database, ctx, purchase.purchaseOrderId,
      { idempotencyKey: 'supplier-return-ui:po:approve' });
    await workflows.placePurchaseOrder(database, ctx, purchase.purchaseOrderId,
      { idempotencyKey: 'supplier-return-ui:po:place' });
    await workflows.receivePurchaseOrder(database, ctx, purchase.purchaseOrderId, {
      idempotencyKey: 'supplier-return-ui:po:receive', reference: 'SUPPLIER-RETURN-OPENING',
      lines: [{ lineId: purchase.lineIds[0], quantity: 10, locationId: main.id }] });
    const invoice = await workflows.recordSupplierInvoice(database, ctx, { supplierId: supplier.id,
      purchaseOrderId: purchase.purchaseOrderId, supplierInvoiceNumber: 'SUP-RETURN-1', issueDate: '2026-09-21',
      idempotencyKey: 'supplier-return-ui:invoice', lines: [{ purchaseOrderLineId: purchase.lineIds[0],
        skuId: item.skuIds[0], quantity: 10, unitCostMinor: 800, description: 'Supplier return boots' }] });

    async function completeReturn({ quantity, expected, actual, creditNumber }) {
      await page.goto(`${base}/purchasing/orders/${purchase.purchaseOrderId}`);
      await page.getByText('Start a controlled supplier return', { exact: true }).click();
      await page.getByLabel('Bill the supplier credit will reduce').selectOption(invoice.billId);
      await page.getByLabel('Expected supplier credit').fill(expected);
      await page.getByLabel('Return Supplier Return Boot to supplier quantity').fill(String(quantity));
      await page.getByLabel('Reason').fill('Supplier approved return');
      await Promise.all([page.waitForURL(/\/supplier-returns\/rtv_/),
        page.getByRole('button', { name: 'Request supplier return' }).click()]);
      const supplierReturnId = page.url().split('/').pop();
      assert.match(await page.locator('main').innerText(), /is requested/);
      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Authorize supplier return' }).click()]);
      assert.match(await page.locator('main').innerText(), /is authorized/);
      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Record goods shipped to supplier' }).click()]);
      assert.match(await page.locator('main').innerText(), /is awaiting credit/);
      await page.getByLabel('Actual supplier credit').fill(actual);
      await page.getByLabel('Credit memo number').fill(creditNumber);
      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Record and reconcile credit' }).click()]);
      return supplierReturnId;
    }

    const firstReturnId = await completeReturn({ quantity: 2, expected: '16.00', actual: '16.00', creditNumber: 'CM-16' });
    assert.match(await page.locator('main').innerText(), /is reconciled/);
    let state = (await database.query(`SELECT r.status,b.balance_minor FROM supplier_returns r
      JOIN accounting_supplier_bills b ON b.id=r.supplier_bill_id WHERE r.id=$1`, [firstReturnId])).rows[0];
    assert.deepEqual({ status: state.status, balance: Number(state.balance_minor) }, { status: 'RECONCILED', balance: 6400 });
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE sku_id=$1 AND location_id=$2',
      [item.skuIds[0], main.id])).rows[0].on_hand), 8);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'INVENTORY_ASSET'), 6400);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'SUPPLIER_CREDITS_RECEIVABLE'), 0);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'ACCOUNTS_PAYABLE'), -6400);

    const mismatchReturnId = await completeReturn({ quantity: 1, expected: '8.00', actual: '7.00', creditNumber: 'CM-7' });
    assert.match(await page.locator('main').innerText(), /differs from the expected amount/i);
    assert.equal(await page.locator('a[href="/needs-you"] .nav-count').innerText(), '1');
    await page.locator('.rm-rail__nav a[href="/needs-you"]').click();
    assert.match(await page.locator('main').innerText(), /Resolve supplier credit mismatch/);
    await page.goto(`${base}/supplier-returns/${mismatchReturnId}`);
    state = (await database.query(`SELECT r.status,r.expected_credit_minor,r.actual_credit_minor,b.balance_minor
      FROM supplier_returns r JOIN accounting_supplier_bills b ON b.id=r.supplier_bill_id WHERE r.id=$1`,
    [mismatchReturnId])).rows[0];
    assert.deepEqual({ status: state.status, expected: Number(state.expected_credit_minor),
      actual: Number(state.actual_credit_minor), balance: Number(state.balance_minor) },
    { status: 'CREDIT_MISMATCH', expected: 800, actual: 700, balance: 5700 });
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE sku_id=$1 AND location_id=$2',
      [item.skuIds[0], main.id])).rows[0].on_hand), 7);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'INVENTORY_ASSET'), 5600);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'SUPPLIER_CREDITS_RECEIVABLE'), 0);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'PURCHASE_PRICE_VARIANCE'), 100);
    assert.equal(await controlBalance(database, ctx.workspaceId, 'ACCOUNTS_PAYABLE'), -5700);
    const journals = await database.query(`SELECT je.id FROM accounting_journal_entries je
      JOIN accounting_journal_lines jl ON jl.entry_id=je.id WHERE je.workspace_id=$1
      GROUP BY je.id HAVING SUM(jl.debit_minor)<>SUM(jl.credit_minor)`, [ctx.workspaceId]);
    assert.equal(journals.rows.length, 0);
    const movementCount = Number((await database.query(`SELECT COUNT(*) AS count FROM movements WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0].count);
    assert.equal(movementCount, 3);
    assert.deepEqual(errors, []);
  });
