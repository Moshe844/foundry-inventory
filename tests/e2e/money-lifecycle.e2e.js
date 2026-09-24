'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createApp } = require('../../src/app');
const { fakeProvider } = require('../helpers/fake-provider');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repository = require('../../src/domain/repository');
const ledger = require('../../src/accounting/ledger');
const payables = require('../../src/accounting/payables');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const prices = require('../../src/pricing/price-service');
const sales = require('../../src/sales/sales-order-service');
const reactions = require('../../src/manager/reactions');

test.after(cleanupAll);

async function submit(page, button) {
  await Promise.all([page.waitForNavigation(), button.click()]);
}

test('customer and supplier payments and a refund reconcile through Money screens', { timeout:120000 }, async (context) => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'UI Money Lifecycle' });
  const membership = auth.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const today = new Date().toISOString().slice(0, 10);
  ledger.configure(store.db, workspace.ctx, membership, {
    startDate:today,
    currency:'USD',
    costingMethod:'WEIGHTED_AVERAGE',
  });
  ledger.post(store.db, workspace.ctx, {
    postingDate:today,
    description:'Opening cash for UI certification',
    sourceKey:'ui-money-opening-cash',
    lines:[
      { accountKey:'CASH', debitMinor:500_000 },
      { accountKey:'OPENING_BALANCE_EQUITY', creditMinor:500_000 },
    ],
  });
  const item = makeQuantityItem(store.db, workspace.ctx, { name:'Money Lifecycle Item', baseCode:'MONEY-1' });
  prices.setPrice(store.db, workspace.ctx, { skuId:item.skuId, amount:'20.00', currency:'USD' });
  const supplier = suppliers.createSupplier(store.db, workspace.ctx, membership, { name:'Money Lifecycle Supplier' });
  suppliers.linkItem(store.db, workspace.ctx, membership, {
    supplierId:supplier.id,
    skuId:item.skuId,
    supplierSku:'MONEY-SUP-1',
    purchaseUnit:'unit',
    unitsPerPurchaseUnit:1,
    lastUnitCost:10,
  });
  let purchaseOrder = purchaseOrders.createOrder(store.db, workspace.ctx, membership, {
    supplierId:supplier.id,
    destinationLocationId:workspace.main.id,
    lines:[{ skuId:item.skuId, quantityUnits:100, unitCost:10 }],
  });
  purchaseOrder = purchaseOrders.approve(store.db, workspace.ctx, membership, purchaseOrder.id);
  receiving.receive(store.db, workspace.ctx, membership, purchaseOrder.id, {
    idempotencyKey:'ui-money-receipt',
    lines:[{ lineId:purchaseOrder.lines[0].id, quantityUnits:100 }],
  });
  reactions.drainWorkspace(store.db, workspace.workspaceId);
  const draftBill = payables.createDraft(store.db, workspace.ctx, membership, {
    supplierId:supplier.id,
    purchaseOrderId:purchaseOrder.id,
    supplierInvoiceNumber:'UI-MONEY-BILL',
    issueDate:today,
    dueDate:today,
    sourceKey:'ui-money-bill',
    lines:[{
      description:'100 Money Lifecycle Items',
      quantity:100,
      unitCostMinor:1000,
      itemId:item.itemId,
      skuId:item.skuId,
      purchaseOrderLineId:purchaseOrder.lines[0].id,
    }],
  });
  const bill = payables.open(store.db, workspace.ctx, membership, draftBill.bill.id);
  let order = sales.createOrder(store.db, workspace.ctx, {
    customerName:'Money Lifecycle Customer',
    deliveryMethod:'PICKUP',
    fulfillmentLocationId:workspace.main.id,
    lines:[{ skuId:item.skuId, quantity:10 }],
  });
  order = sales.confirm(store.db, workspace.ctx, order.id);
  sales.fulfill(store.db, workspace.ctx, order.id, {}, { idempotencyKey:'ui-money-sale' });
  reactions.drainWorkspace(store.db, workspace.workspaceId);
  const invoice = store.db.prepare(`SELECT * FROM accounting_customer_invoices
    WHERE workspace_id = ? AND sales_order_id = ?`).get(workspace.workspaceId, order.id);
  assert.ok(invoice, 'the deterministic sale workflow must create the customer invoice used by the UI');
  assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 90);

  const app = createApp({
    db:store.db,
    env:'test',
    sessionSecret:'ui-money-lifecycle',
    aiProvider:fakeProvider({}),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  context.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact:true }).fill(workspace.account.email);
  await page.getByLabel('Password', { exact:true }).fill(workspace.account.password);
  await submit(page, page.getByRole('button', { name:'Sign in', exact:true }));

  await context.test('a supplier partial payment leaves exactly six hundred payable', async () => {
    await page.goto(`${base}/accounting/payables`);
    const row = page.locator('.bill-row').filter({ hasText:'Money Lifecycle Supplier' });
    await row.getByText('Record payment', { exact:true }).click();
    await row.getByLabel('Amount paid', { exact:true }).fill('400.00');
    await row.getByLabel('Reference', { exact:true }).fill('UI supplier payment one');
    await submit(page, row.getByRole('button', { name:'Record it', exact:true }));
    const updated = page.locator('.bill-row').filter({ hasText:'Money Lifecycle Supplier' });
    assert.match(await updated.innerText(), /partly paid/i);
    assert.match(await updated.innerText(), /\$600\.00\s+of \$1,000\.00/i);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 90);
  });

  await context.test('the final supplier payment clears the payable without moving stock', async () => {
    const row = page.locator('.bill-row').filter({ hasText:'Money Lifecycle Supplier' });
    await row.getByText('Record payment', { exact:true }).click();
    await row.getByLabel('Amount paid', { exact:true }).fill('600.00');
    await row.getByLabel('Reference', { exact:true }).fill('UI supplier payment two');
    await submit(page, row.getByRole('button', { name:'Record it', exact:true }));
    await page.getByText(/Settled · 1/).click();
    assert.match(await page.locator('.bill-row').filter({ hasText:'Money Lifecycle Supplier' }).innerText(), /paid/i);
    assert.equal(store.db.prepare('SELECT balance_minor FROM accounting_supplier_bills WHERE id = ?').get(bill.id).balance_minor, 0);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 90);
  });

  await context.test('a customer partial payment leaves exactly one hundred fifty receivable', async () => {
    await page.goto(`${base}/accounting/receivables`);
    const row = page.locator('.bill-row').filter({ hasText:'Money Lifecycle Customer' });
    await row.getByText('Record payment', { exact:true }).click();
    await row.getByLabel('Amount received', { exact:true }).fill('50.00');
    await row.getByLabel('Reference', { exact:true }).fill('UI customer payment one');
    await submit(page, row.getByRole('button', { name:'Record it', exact:true }));
    const updated = page.locator('.bill-row').filter({ hasText:'Money Lifecycle Customer' });
    assert.match(await updated.innerText(), /partly paid/i);
    assert.match(await updated.innerText(), /\$150\.00\s+of \$200\.00/i);
  });

  await context.test('the final customer payment clears the receivable', async () => {
    const row = page.locator('.bill-row').filter({ hasText:'Money Lifecycle Customer' });
    await row.getByText('Record payment', { exact:true }).click();
    await row.getByLabel('Amount received', { exact:true }).fill('150.00');
    await row.getByLabel('Reference', { exact:true }).fill('UI customer payment two');
    await submit(page, row.getByRole('button', { name:'Record it', exact:true }));
    await page.getByText(/Settled · 1/).click();
    assert.match(await page.locator('.bill-row').filter({ hasText:'Money Lifecycle Customer' }).innerText(), /paid/i);
    assert.equal(store.db.prepare('SELECT balance_minor FROM accounting_customer_invoices WHERE id = ?').get(invoice.id).balance_minor, 0);
  });

  await context.test('a cash refund is visible, traceable and never changes physical inventory', async () => {
    await page.goto(`${base}/accounting/refunds/new?invoiceId=${invoice.id}`);
    await page.getByLabel('Refund amount', { exact:true }).fill('20.00');
    await page.locator('select[name="refundFrom"]').selectOption('cash');
    await page.getByLabel('Reference / reason', { exact:true }).fill('UI refund certification');
    await submit(page, page.getByRole('button', { name:'Record refund', exact:true }));
    const body = await page.locator('main').innerText();
    assert.match(body, /Refund recorded/);
    assert.match(body, /inventory was not changed/i);
    await page.getByText('Show customer refunds', { exact:true }).click();
    assert.match(await page.locator('main').innerText(), /\$20\.00 refunded/i);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 90);
  });

  await context.test('inventory valuation visibly reconciles the cost subledger to inventory control', async () => {
    await page.goto(`${base}/accounting/reports/inventory-valuation?asOf=${today}`);
    const body = await page.locator('main').innerText();
    assert.match(body, /Inventory valuation/);
    assert.match(body, /90 units/);
    assert.match(body, /Cost subledger \$900\.00 · Inventory control \$900\.00/);
    assert.match(body, /Reconciled/);
  });

  await context.test('the browser proves balanced books and traces a ledger row to its immutable source entry', async () => {
    await page.goto(`${base}/accounting/reports/trial-balance?from=1900-01-01&to=${today}`);
    assert.match(await page.locator('main').innerText(), /Debits equal credits/);
    const trialTotals = page.locator('tfoot tr').last().locator('th');
    assert.equal((await trialTotals.nth(1).innerText()).trim(), (await trialTotals.nth(2).innerText()).trim());

    await page.goto(`${base}/accounting/reports/general-ledger?from=1900-01-01&to=${today}`);
    const entryLink = page.locator('a[href^="/accounting/entries/"]').first();
    assert.equal(await entryLink.count(), 1);
    await submit(page, entryLink);
    await page.getByText('Advanced accounting details', { exact:true }).click();
    const entryTotals = page.locator('tfoot tr').last().locator('th');
    assert.equal((await entryTotals.nth(1).innerText()).trim(), (await entryTotals.nth(2).innerText()).trim());
    const entryBody = await page.locator('main').innerText();
    assert.match(entryBody, /Source record/);
    assert.match(entryBody, /Domain event/);
    assert.match(entryBody, /Original entry/);
  });

  assert.deepEqual(errors, []);
});
