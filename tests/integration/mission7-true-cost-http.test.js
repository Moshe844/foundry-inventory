'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const auth = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const orders = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const ledger = require('../../src/accounting/ledger');
const costing = require('../../src/accounting/costing');
const payables = require('../../src/accounting/payables');
const landed = require('../../src/accounting/landed-costs');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, plain, signIn } = require('../helpers');

test.after(cleanupAll);

test('the purchase page leads an owner to a simple landed-cost evidence workflow', async () => {
  const store = makeDatabase(); const workspace = seedWorkspace(store.db);
  const membership = auth.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Inbound coat' });
  const supplier = suppliers.createSupplier(store.db, workspace.ctx, membership, { name: 'Inbound supplier' });
  suppliers.linkItem(store.db, workspace.ctx, membership, { supplierId: supplier.id, skuId: item.skuId,
    purchaseUnit: 'case', unitsPerPurchaseUnit: 1, lastUnitCost: 20 });
  let order = orders.createOrder(store.db, workspace.ctx, membership, { supplierId: supplier.id,
    destinationLocationId: workspace.main.id, lines: [{ skuId: item.skuId, quantityUnits: 4, unitCost: 20 }] });
  order = orders.approve(store.db, workspace.ctx, membership, order.id);
  ledger.configure(store.db, workspace.ctx, membership, { startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE' });
  const receipt = receiving.receive(store.db, workspace.ctx, membership, order.id, { idempotencyKey: 'mission7-http-receipt',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 4 }] });
  costing.receive(store.db, workspace.ctx, { movementIds: receipt.receipt.lines.flatMap((line) => line.movementIds),
    unitCostMinor: 2000, sourceType: 'mission7-http-receipt', sourceRecordId: receipt.receipt.id });
  const bill = payables.createDraft(store.db, workspace.ctx, membership, { supplierId: supplier.id,
    supplierInvoiceNumber: 'FREIGHT-HTTP', issueDate: '2026-08-01', sourceKey: 'mission7-http-freight',
    lines: [{ description: 'Carrier freight', quantity: 1, unitCostMinor: 100 }] });
  const opened = payables.open(store.db, workspace.ctx, membership, bill.bill.id);
  const draft = landed.createDraft(store.db, workspace.ctx, membership, { purchaseOrderId: order.id,
    receiptIds: [receipt.receipt.id], allocationMethod: 'quantity',
    charges: [{ category: 'freight', description: 'Carrier freight', amountMinor: 100, sourceBillLineId: opened.lines[0].id }] });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'mission7-http' });
  const agent = request.agent(app); await signIn(agent, workspace.account.email);
  const orderPage = await agent.get(`/purchasing/orders/${order.id}`).expect(200);
  assert.match(plain(orderPage.text), /StockChief prepared the documented landed-cost split/);
  assert.match(plain(orderPage.text), /Review split/);
  const page = await agent.get(`/purchasing/orders/${order.id}/landed-costs`).expect(200);
  const text = plain(page.text);
  assert.match(text, /Put the cost of getting these goods here into inventory/);
  assert.match(text, /Source supplier-bill expense/);
  const detail = await agent.get(`/purchasing/orders/${order.id}/landed-costs/${draft.document.id}`).expect(200);
  assert.match(plain(detail.text), /Review the exact landed-cost split/);
  assert.match(plain(detail.text), /The source and allocated totals agree exactly/);
});
