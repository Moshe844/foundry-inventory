'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const costing = require('../../src/accounting/costing');
const prices = require('../../src/pricing/price-service');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const payments = require('../../src/accounting/payments');
const planner = require('../../src/attention/query-planner');
const queryService = require('../../src/attention/query-service');

test.after(cleanupAll);

test('a natural sale-profit-and-payment question is answered as one exact story', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Human Walkthrough' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });

  const shirt = makeQuantityItem(db, workspace.ctx, {
    name: 'T-shirt', baseCode: 'TSHIRT', variantLabel: 'Black / Small',
  });
  prices.setPrice(db, workspace.ctx, { skuId: shirt.skuId, amount: '20.00', currency: 'USD' });
  const received = inventory.receive(db, workspace.ctx, {
    skuId: shirt.skuId, locationId: workspace.main.id, quantity: 10,
    reference: 'QA opening stock',
  });
  costing.receive(db, workspace.ctx, {
    movementIds: received.movementIds, unitCostMinor: 500,
    sourceType: 'opening_balance', sourceRecordId: 'qa-opening',
  });
  const customer = sales.createCustomer(db, workspace.ctx, { name: 'Human Test Customer', shippingAddress: '7 Example Lane, Albany, NY 12207, US' });
  const order = sales.confirm(db, workspace.ctx, sales.createOrder(db, workspace.ctx, {
    customerId: customer.id,
    lines: [{ skuId: shirt.skuId, quantity: 2 }],
  }).id);
  payments.record(db, workspace.ctx, membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: customer.id, salesOrderId: order.id,
    paymentDate: new Date().toISOString().slice(0, 10), amountMinor: 4000,
    method: 'cash', sourceKey: `qa-payment:${order.id}`,
  });
  const box = shipments.startPicking(db, workspace.ctx, order.id);
  shipments.ship(db, workspace.ctx, box.id, { handover: 'CARRIER' });

  const question = 'why did we make 30 dollars on the tshirt sale and has the customer actually paid us?';
  const plan = await planner.plan(question);
  assert.equal(plan.intent, 'sale_profit_and_payment');
  const result = queryService.execute(db, workspace.workspaceId, plan, { question });
  assert.equal(result.answerMode, 'verified', 'a model must not contradict the joined records');
  assert.match(result.answer, /\$40\.00 sale/);
  assert.match(result.answer, /cost \$10\.00/);
  assert.match(result.answer, /\$30\.00 gross profit/);
  assert.match(result.answer, /customer paid \$40\.00 and now owes \$0\.00/i);
  assert.equal(result.rows[0].href, `/orders/${order.id}`);
});

test('a profit-versus-customer-cash question reconciles the whole period, not one convenient sale', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Period Story' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  const shirt = makeQuantityItem(db, workspace.ctx, { name: 'T-shirt', baseCode: 'TSHIRT' });
  prices.setPrice(db, workspace.ctx, { skuId: shirt.skuId, amount: '20.00', currency: 'USD' });
  const received = inventory.receive(db, workspace.ctx, {
    skuId: shirt.skuId, locationId: workspace.main.id, quantity: 10,
  });
  costing.receive(db, workspace.ctx, {
    movementIds: received.movementIds, unitCostMinor: 500,
    sourceType: 'opening_balance', sourceRecordId: 'period-opening',
  });

  for (const [name, quantity] of [['First Customer', 2], ['Second Customer', 1]]) {
    const customer = sales.createCustomer(db, workspace.ctx, { name, shippingAddress: '7 Example Lane, Albany, NY 12207, US' });
    const order = sales.confirm(db, workspace.ctx, sales.createOrder(db, workspace.ctx, {
      customerId: customer.id, lines: [{ skuId: shirt.skuId, quantity }],
    }).id);
    payments.record(db, workspace.ctx, membership, {
      direction: 'CUSTOMER_RECEIPT', customerId: customer.id, salesOrderId: order.id,
      paymentDate: new Date().toISOString().slice(0, 10), amountMinor: quantity * 2000,
      method: 'cash', sourceKey: `period-payment:${order.id}`,
    });
    const box = shipments.startPicking(db, workspace.ctx, order.id);
    shipments.ship(db, workspace.ctx, box.id, { handover: 'CARRIER' });
  }

  const question = 'Why did I only make $45 when customers paid $60?';
  const plan = await planner.plan(question);
  assert.equal(plan.intent, 'period_profit_and_customer_cash');
  const result = queryService.execute(db, workspace.workspaceId, plan, { question });
  assert.match(result.answer, /customers paid \$60\.00.*cash received, not profit/i);
  assert.match(result.answer, /\$60\.00 of revenue/);
  assert.match(result.answer, /cost \$15\.00.*\$45\.00 gross profit/);
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => /^\/orders\//.test(row.href)));
});
