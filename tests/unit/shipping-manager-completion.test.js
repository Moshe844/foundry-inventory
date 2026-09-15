'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shipping = require('../../src/shipping');
const shipments = require('../../src/sales/shipment-service');
const sales = require('../../src/sales/sales-order-service');
const inventory = require('../../src/domain/inventory-engine');
const prices = require('../../src/pricing/price-service');
const locations = require('../../src/domain/location-service');
const returns = require('../../src/operations/returns');
const auth = require('../../src/domain/auth-service');
const communications = require('../../src/sales/customer-communications');
const queryPlanner = require('../../src/attention/query-planner');
const queryService = require('../../src/attention/query-service');
const story = require('../../src/web/story');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeCarrier, carrierEvent } = require('../helpers/fake-carrier');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Shipping Completion' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Acrylic sign', baseCode: 'SIGN-1' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '45.00', currency: 'USD' });
  db.prepare('UPDATE skus SET weight_grams = 600 WHERE id = ?').run(item.skuId);
  db.prepare('UPDATE locations SET address = ? WHERE id = ?')
    .run('12 Depot Road, Monroe, NY 10950', workspace.main.id);
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 });
  const customer = sales.createCustomer(db, workspace.ctx, { name: 'A Customer', email: 'customer@example.test',
    shippingAddress: '13 Austra Pkwy, Monroe, NY 10950' });
  const order = sales.confirm(db, workspace.ctx, sales.createOrder(db, workspace.ctx, {
    customerId: customer.id, neededBy: '2026-09-20', lines: [{ skuId: item.skuId, quantity: 2 }],
  }).id);
  const box = shipments.startPicking(db, workspace.ctx, order.id, {});
  shipments.markPacked(db, workspace.ctx, box.id, {});
  return { db, workspace, ctx: workspace.ctx, membership, item, customer, order, box };
}

function withCarrier(carrier) {
  const undo = shipping.provider.register('easypost', carrier);
  process.env.EASYPOST_API_KEY = 'EZTK_completion';
  return () => { undo(); delete process.env.EASYPOST_API_KEY; };
}

test('customer promise is separate from the carrier estimate and recommendations account for shipping charged', async () => {
  const env = setup(); const undo = withCarrier(fakeCarrier());
  try {
    const promise = shipping.service.setPromise(env.db, env.ctx, env.box.id, {
      service: 'Two day', windowStart: '2026-09-19', windowEnd: '2026-09-20',
      customerShippingMinor: 1900, source: 'checkout',
    });
    assert.equal(promise.service, 'Two day');
    assert.equal(promise.customerShippingMinor, 1900);
    const quoted = await shipping.service.quote(env.db, env.ctx, env.box.id);
    assert.equal(quoted.promise.windowEnd, '2026-09-20');
    const recommendation = shipping.rules.recommend(quoted.rates, quoted.promisedDate,
      { customerShippingMinor: 1900, performance: new Map() });
    assert.match(recommendation.because, /shipping amount charged/i);
    assert.equal(recommendation.comparisons.length, 3);
    shipments.ship(env.db, env.ctx, env.box.id, { handover: 'CARRIER', carrier: 'ups',
      trackingNumber: '1Z999AA10123456784' });
    shipments.ship(env.db, env.ctx, env.box.id, { handover: 'CARRIER', carrier: 'ups',
      trackingNumber: '1Z999AA10123456784' });
    const charge = env.db.prepare(`SELECT id FROM accounting_journal_entries
      WHERE workspace_id = ? AND source_type = 'customer_shipping_charge'`)
      .all(env.workspace.workspaceId);
    assert.equal(charge.length, 1);
    const lines = env.db.prepare(`SELECT a.system_key, l.debit_minor, l.credit_minor
      FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id = l.account_id
      WHERE l.entry_id = ? ORDER BY l.line_number`).all(charge[0].id);
    assert.deepEqual(lines.map((line) => [line.system_key, line.debit_minor, line.credit_minor]), [
      ['ACCOUNTS_RECEIVABLE', 1900, 0], ['SALES_REVENUE', 0, 1900],
    ]);
  } finally { undo(); env.db.close(); }
});

test('label purchase and void are durable, idempotent, and reverse unused postage without moving stock', async () => {
  const env = setup(); const carrier = fakeCarrier(); const undo = withCarrier(carrier);
  try {
    const quoted = await shipping.service.quote(env.db, env.ctx, env.box.id);
    const bought = await shipping.service.buyLabel(env.db, env.ctx, env.box.id, quoted.rates[0].id);
    const result = await shipping.service.voidLabel(env.db, env.ctx, env.box.id);
    assert.equal(result.status, 'SUCCEEDED');
    assert.deepEqual(carrier.state.voided, ['lbl_fake']);
    const replay = await shipping.service.voidLabel(env.db, env.ctx, env.box.id);
    assert.equal(replay.replayed, true);
    assert.equal(carrier.state.voided.length, 1);
    await shipping.service.buyLabel(env.db, env.ctx, env.box.id, quoted.rates[0].id);
    const secondVoid = await shipping.service.voidLabel(env.db, env.ctx, env.box.id);
    assert.equal(secondVoid.status, 'SUCCEEDED');
    assert.equal(carrier.state.voided.length, 2);
    const row = env.db.prepare('SELECT * FROM sales_shipments WHERE id = ?').get(env.box.id);
    assert.equal(row.label_status, 'VOIDED');
    assert.equal(Number(row.postage_refund_minor), Number(row.shipping_cost_minor));
    const transactions = shipping.service.labelTransactions(env.db, env.workspace.workspaceId, env.box.id);
    assert.equal(transactions.filter((entry) => entry.operation === 'PURCHASE').length, 2);
    assert.equal(transactions.filter((entry) => entry.operation === 'VOID').length, 2);
    const journalCounts = env.db.prepare(`SELECT source_type, COUNT(*) AS n
      FROM accounting_journal_entries WHERE workspace_id = ?
      AND source_type IN ('shipment_postage', 'shipment_postage_refund') GROUP BY source_type`)
      .all(env.workspace.workspaceId);
    assert.deepEqual(Object.fromEntries(journalCounts.map((entry) => [entry.source_type, entry.n])),
      { shipment_postage: 2, shipment_postage_refund: 2 });
    shipments.cancelShipment(env.db, env.ctx, env.box.id, 'Customer changed the order');
    assert.equal(Number(env.db.prepare('SELECT SUM(on_hand) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?')
      .get(env.workspace.workspaceId, env.item.skuId).n), 10);
  } finally { undo(); env.db.close(); }
});

test('an ambiguous purchase failure pauses the exact effect instead of buying twice', async () => {
  const env = setup(); const carrier = fakeCarrier({ buyError: new Error('connection ended after submit') });
  const undo = withCarrier(carrier);
  try {
    const quoted = await shipping.service.quote(env.db, env.ctx, env.box.id);
    await assert.rejects(shipping.service.buyLabel(env.db, env.ctx, env.box.id, quoted.rates[0].id), /connection ended/);
    await assert.rejects(shipping.service.buyLabel(env.db, env.ctx, env.box.id, quoted.rates[0].id), /risk buying.*twice/i);
    const tx = shipping.service.labelTransactions(env.db, env.workspace.workspaceId, env.box.id);
    assert.equal(tx[0].status, 'REVIEW');
    assert.equal(carrier.state.bought.length, 0);
  } finally { undo(); env.db.close(); }
});

test('carrier stages prepare one factual message each and duplicate events prepare nothing twice', () => {
  const env = setup(); const carrier = fakeCarrier(); const undo = withCarrier(carrier);
  try {
    env.db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', provider = 'easypost',
      carrier = 'ups', tracking_number = '1Z999AA10123456784' WHERE id = ?`).run(env.box.id);
    shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({ id: 'stage-1',
      status: 'OUT_FOR_DELIVERY', detail: 'On vehicle', events: [{ object_id: 'stage-scan-1',
        status: 'OUT_FOR_DELIVERY', datetime: '2026-09-20T08:00:00Z', message: 'On vehicle' }] }));
    shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({ id: 'stage-1',
      status: 'OUT_FOR_DELIVERY' }));
    const messages = communications.forShipment(env.db, env.workspace.workspaceId, env.box.id)
      .filter((message) => message.messageKind === 'shipping_out_for_delivery');
    assert.equal(messages.length, 1);
    assert.match(messages[0].body, /On vehicle/);
    assert.equal(messages[0].status, 'PREPARED');
  } finally { undo(); env.db.close(); }
});

test('return label completes the carrier loop but cannot receive stock or issue a refund', async () => {
  const env = setup(); const carrier = fakeCarrier({ trackingNumber: '9400111899223100000000' });
  const undo = withCarrier(carrier);
  try {
    shipments.ship(env.db, env.ctx, env.box.id, { handover: 'CARRIER', carrier: 'ups',
      trackingNumber: '1Z999AA10123456784' });
    const quarantine = locations.createLocation(env.db, env.ctx,
      { name: 'Return quarantine', kind: 'zone', barcode: 'RETURN-Q' });
    dbAddress(env.db, quarantine.id);
    let rma = returns.requestCustomerReturn(env.db, env.ctx, env.membership, {
      salesOrderId: env.order.id, quarantineLocationId: quarantine.id, resolution: 'REFUND',
      reason: 'Customer changed mind', lines: [{ salesOrderLineId: env.order.lines[0].id, quantity: 1 }],
    });
    rma = returns.authorizeCustomerReturn(env.db, env.ctx, env.membership, rma.id);
    const compared = await shipping.returns.quote(env.db, env.ctx, rma.id);
    assert.equal(compared.rates.length, 3);
    const bought = await shipping.returns.buy(env.db, env.ctx, rma.id, { rateId: compared.rates[0].id });
    assert.equal(bought.label.status, 'PURCHASED');
    assert.equal(returns.getCustomerReturn(env.db, env.workspace.workspaceId, rma.id).status, 'AUTHORIZED');
    carrier.state.trackers.set(bought.label.tracking_number, { status: 'DELIVERED',
      events: [{ externalEventId: 'return-delivered', status: 'DELIVERED',
        occurredAt: '2026-09-25T12:00:00Z' }] });
    const tracked = await shipping.returns.refresh(env.db, env.ctx, rma.id);
    assert.equal(tracked.label.status, 'DELIVERED');
    assert.equal(tracked.needsPhysicalReceipt, true);
    assert.equal(returns.getCustomerReturn(env.db, env.workspace.workspaceId, rma.id).status, 'AUTHORIZED');
  } finally { undo(); env.db.close(); }
});

test('Ask Foundry and the order story read the complete carrier and accounting evidence', async () => {
  const env = setup(); const carrier = fakeCarrier(); const undo = withCarrier(carrier);
  try {
    shipping.service.setPromise(env.db, env.ctx, env.box.id, {
      service: 'Two day', windowEnd: '2026-09-20', customerShippingMinor: 2200,
      source: 'checkout',
    });
    const quoted = await shipping.service.quote(env.db, env.ctx, env.box.id);
    const bought = await shipping.service.buyLabel(env.db, env.ctx, env.box.id, quoted.rates[0].id);
    shipments.ship(env.db, env.ctx, env.box.id, { handover: 'CARRIER' });
    shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({
      id: 'carrier-problem', status: 'FAILURE', detail: 'Address needs customer confirmation',
      events: [{ object_id: 'problem-scan', status: 'FAILURE',
        datetime: '2026-09-19T10:00:00Z', message: 'Address needs customer confirmation' }],
    }));
    shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({
      id: 'carrier-recovered', status: 'DELIVERED', detail: 'Delivered at reception',
      events: [{ object_id: 'delivery-scan', status: 'DELIVERED',
        datetime: '2026-09-20T12:43:00Z', message: 'Delivered at reception',
        location: 'Reception' }],
    }));

    const statusPlan = await queryPlanner.plan(`Where is order ${env.order.order_number}?`);
    assert.equal(statusPlan.intent, 'shipment_status');
    const status = queryService.execute(env.db, env.workspace.workspaceId, statusPlan,
      { question: `Where is order ${env.order.order_number}?` });
    assert.match(status.answer, /delivered/i);
    assert.equal(status.rows[0].tracking, '1Z999AA10123456784');

    const costPlan = await queryPlanner.plan('What did customers pay for shipping versus what we spent this month?');
    assert.equal(costPlan.intent, 'shipping_costs');
    const costs = queryService.execute(env.db, env.workspace.workspaceId, costPlan,
      { question: 'What did customers pay for shipping versus what we spent this month?' });
    assert.match(costs.answer, /customers paid \$22\.00/i);
    assert.match(costs.answer, new RegExp(`net shipping spend was \\\$${(bought.amountMinor / 100).toFixed(2)}`, 'i'));

    const completeOrder = sales.getOrder(env.db, env.workspace.workspaceId, env.order.id);
    const narrative = story.salesOrder(env.db, env.workspace.workspaceId, completeOrder, {
      shipments: shipments.listForOrder(env.db, env.workspace.workspaceId, env.order.id),
      customerNotices: communications.forOrder(env.db, env.workspace.workspaceId, env.order.id),
      money: { totalMinor: 9000, remainingMinor: 9000, currency: 'USD' },
      fulfilment: shipments.fulfilmentState(env.db, env.workspace.workspaceId, completeOrder),
    });
    const text = JSON.stringify(narrative);
    assert.match(text, /selected .* and bought the label/i);
    assert.match(text, new RegExp(`\\$${(bought.amountMinor / 100).toFixed(2)}`));
    assert.match(text, /delivery exception/i);
    assert.match(text, /carrier verified delivery/i);
    assert.match(text, /Reception/);
  } finally { undo(); env.db.close(); }
});

function dbAddress(db, locationId) {
  db.prepare('UPDATE locations SET address = ? WHERE id = ?')
    .run('12 Depot Road, Monroe, NY 10950', locationId);
}
