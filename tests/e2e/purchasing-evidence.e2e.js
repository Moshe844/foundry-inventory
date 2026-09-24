'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repository = require('../../src/domain/repository');
const suppliers = require('../../src/purchasing/supplier-service');
const purchasing = require('../../src/purchasing/po-service');
const connections = require('../../src/connections/service');
const ingestion = require('../../src/connections/event-ingestion');

test.after(cleanupAll);

async function submit(page, locator) {
  await Promise.all([page.waitForNavigation(), locator.click()]);
}

test('supplier discrepancies and documents remain controlled in the browser', { timeout:120000 }, async (context) => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'Purchasing Evidence UI' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name:'Evidence Widget', baseCode:'EVID-W' });
  inventory.receive(store.db, workspace.ctx, {
    skuId:item.skuId, locationId:workspace.store.id, quantity:10,
  });
  const supplier = suppliers.createSupplier(store.db, workspace.ctx, membership, {
    name:'Evidence Supply', email:'orders@evidence.test', priceTolerancePercent:5, quantityTolerancePercent:0,
  });
  suppliers.linkItem(store.db, workspace.ctx, membership, {
    supplierId:supplier.id, skuId:item.skuId, supplierSku:'SUP-EVID-W', purchaseUnit:'unit',
    unitsPerPurchaseUnit:1, lastUnitCost:6.5,
  });
  const order = purchasing.createOrder(store.db, workspace.ctx, membership, {
    supplierId:supplier.id, destinationLocationId:workspace.store.id,
    lines:[{ skuId:item.skuId, quantityPurchaseUnits:24, unitCost:6.5 }],
  });
  purchasing.approve(store.db, workspace.ctx, membership, order.id);
  const mailbox = connections.create(store.db, workspace.ctx, membership, {
    providerType:'supplier_email', displayName:'Purchasing Inbox',
  });
  connections.addEmailRule(store.db, workspace.ctx, mailbox.connection.id, {
    senderPattern:'orders@evidence.test', supplierId:supplier.id, documentMode:'supplier_documents',
  });
  const auth = {
    connectorId:mailbox.connection.id, workspaceId:workspace.workspaceId,
    actorId:workspace.ownerId, accountId:workspace.accountId,
    providerType:'supplier_email', displayName:'Purchasing Inbox',
  };
  const message = (id, subject, facts, bodyText = '') => ingestion.ingest(store.db, auth, {
    eventId:id, type:'supplier_document.received', occurredAt:'2026-09-22T12:00:00Z',
    data:{ messageId:id, threadId:`thread-${id}`, sender:'orders@evidence.test', subject, bodyText, facts, attachments:[] },
  });

  const app = createApp({ db:store.db, env:'test', sessionSecret:'purchasing-evidence-ui' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
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

  await context.test('an over-receipt asks before changing stock and records the approved excess', async () => {
    const before = repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id);
    await page.goto(`${base}/purchasing/orders/${order.id}/receive`);
    await page.locator(`input[name="qty_${order.lines[0].id}"]`).fill('30');
    await page.getByRole('button', { name:'Book it in', exact:true }).click();
    let body = await page.locator('main').innerText();
    assert.match(body, /6 unit\(s\) above the purchase order/i);
    assert.match(body, /accept more than was ordered/i);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id), before);
    await page.getByLabel(/accept more than was ordered/i).check();
    await submit(page, page.getByRole('button', { name:'Book it in', exact:true }));
    await page.getByText('Receipts, invoices, documents and the full working record', { exact:true }).click();
    body = await page.locator('main').innerText();
    assert.match(body, /over-receipt accepted/i);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id), before + 30);
  });

  await context.test('a supplier price change outside tolerance becomes one explicit browser decision', async () => {
    const priceOrder = purchasing.createOrder(store.db, workspace.ctx, membership, {
      supplierId:supplier.id, destinationLocationId:workspace.store.id,
      lines:[{ skuId:item.skuId, quantityPurchaseUnits:10, unitCost:6.5 }],
    });
    purchasing.approve(store.db, workspace.ctx, membership, priceOrder.id);
    message('price-ui-1', `Invoice PRICE-UI-1 ${priceOrder.poNumber}`, {
      documentType:'invoice', poNumber:priceOrder.poNumber, invoiceNumber:'PRICE-UI-1',
      lines:[{ supplierSku:'SUP-EVID-W', quantity:10, unitPrice:7.25 }],
    });
    await page.goto(`${base}/settings/connections/${mailbox.connection.id}`);
    await page.getByText('See extracted details', { exact:true }).click();
    const body = await page.locator('main').innerText();
    assert.match(body, /A supplier changed something on an order/i);
    assert.match(body, /6\.5 to 7\.25/i);
    assert.match(body, /Accept supplier changes/i);
    assert.match(body, /Keep original purchase order/i);
    assert.equal(store.db.prepare('SELECT unit_cost FROM purchase_order_lines WHERE purchase_order_id = ?')
      .get(priceOrder.id).unit_cost, 6.5);
  });

  await context.test('a supplier invoice without a purchase order asks for the missing match and creates no stock', async () => {
    const before = repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id);
    message('invoice-no-po-ui-1', 'Invoice NO-PO-UI-1', {
      documentType:'invoice', invoiceNumber:'NO-PO-UI-1',
      lines:[{ supplierSku:'SUP-EVID-W', quantity:12, unitPrice:6.5 }],
    });
    await page.goto(`${base}/settings/connections/${mailbox.connection.id}`);
    const body = await page.locator('main').innerText();
    assert.match(body, /references an order StockChief cannot find/i);
    assert.match(body, /No purchase order could be matched confidently/i);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id), before);
  });

  await context.test('a shipment notice updates incoming evidence and ETA but never on-hand stock', async () => {
    const shipmentOrder = purchasing.createOrder(store.db, workspace.ctx, membership, {
      supplierId:supplier.id, destinationLocationId:workspace.store.id,
      lines:[{ skuId:item.skuId, quantityPurchaseUnits:15, unitCost:6.5 }],
    });
    purchasing.approve(store.db, workspace.ctx, membership, shipmentOrder.id);
    const before = repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id);
    message('shipment-ui-1', `Shipment notice ${shipmentOrder.poNumber}`, {
      documentType:'shipment_notice', poNumber:shipmentOrder.poNumber, expectedArrivalDate:'2026-10-03',
      lines:[{ supplierSku:'SUP-EVID-W', shippedQuantity:15, expectedArrivalDate:'2026-10-03' }],
    }, 'All 15 units shipped and are expected October 3.');
    await page.goto(`${base}/purchasing/orders/${shipmentOrder.id}`);
    await page.getByText('Receipts, invoices, documents and the full working record', { exact:true }).click();
    const body = await page.locator('main').innerText();
    assert.match(body, /shipment notice from orders@evidence\.test/i);
    assert.match(body, /Matched to this order/i);
    assert.match(body, /expected 2026-10-03/i);
    assert.match(body, /Nothing is booked in until you report that it arrived/i);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id), before);
  });

  assert.deepEqual(errors, []);
});
