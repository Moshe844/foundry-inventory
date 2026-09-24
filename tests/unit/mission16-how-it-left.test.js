'use strict';

/*
 * StockChief does not say goods were shipped unless they were.
 *
 * The complaint this answers was short and correct: an order reported itself
 * shipped when nobody had chosen a carrier, entered an address, or in fact
 * shipped anything. One click moved the stock and StockChief supplied the word.
 *
 * So the claim now has to be backed. A shipment records how the goods left,
 * the question has no default, and every sentence StockChief writes about it is
 * built from the answer rather than from an assumption.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const shipments = require('../../src/sales/shipment-service');
const sales = require('../../src/sales/sales-order-service');
const inventory = require('../../src/domain/inventory-engine');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '15.00', currency: 'USD' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 50 });
  return { db, workspace, ctx: workspace.ctx, item };
}

function confirmedOrder(env, quantity = 5) {
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School', shippingAddress: '7 Example Lane, Albany, NY 12207, US' });
  return sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity }],
  }).id);
}

test('the delivery choice on the order carries through without asking twice', () => {
  const env = setup();
  const order = confirmedOrder(env);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});
  assert.equal(shipped.handover, 'CARRIER',
    'the order already recorded Send by carrier, so fulfilment does not ask again');
});

test('a tracking number is somebody saying it went by carrier', () => {
  const env = setup();
  const order = confirmedOrder(env);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, { trackingNumber: '1Z999AA10123456784' });
  assert.equal(shipped.handover, 'CARRIER', 'the answer was in the tracking number');
  assert.match(shipped.wentBy, /^Sent by /);
});

test('goods the customer carried out were not shipped anywhere', () => {
  const env = setup();
  const order = confirmedOrder(env);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const gone = shipments.ship(env.db, env.ctx, box.id, { handover: 'COLLECTED' });

  assert.equal(gone.handover, 'COLLECTED');
  assert.equal(gone.wentBy, 'Collected by the customer');
  assert.equal(gone.carrier, null, 'nobody carried it but them');
  assert.equal(gone.tracking_number, null, 'and there is nothing to follow');
  assert.equal(shipments.wordForOrder(env.db, env.workspace.workspaceId, order.id), 'collected',
    'so the order does not say shipped either');
});

test('we took it round ourselves, and the order says so', () => {
  const env = setup();
  const order = confirmedOrder(env);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  env.db.prepare(`UPDATE sales_shipments SET carrier = 'ups', service = 'Ground',
    tracking_number = '1Z999AA10123456784', shipping_cost_minor = 1200 WHERE id = ?`).run(box.id);
  const gone = shipments.ship(env.db, env.ctx, box.id, { handover: 'DELIVERED_BY_US' });
  assert.equal(gone.wentBy, 'Delivered by us');
  assert.equal(gone.carrier, null);
  assert.equal(gone.service, null);
  assert.equal(gone.tracking_number, null);
  assert.equal(gone.shipping_cost_minor, null);
  assert.equal(shipments.wordForOrder(env.db, env.workspace.workspaceId, order.id), 'delivered');
});

test('a shipment recorded before the question existed says only what is true', () => {
  /*
   * Eight of these exist in the owner's real data, rebuilt from fulfilment
   * events that predate shipments. StockChief cannot know how they went, so it
   * says that, rather than defaulting to the word that reads best.
   */
  assert.equal(shipments.wentBy({ status: 'SHIPPED', handover: null, carrier: null, tracking_number: null }),
    'Left stock — how it went was not recorded');
  // And nothing is claimed about a box that has not gone at all.
  assert.equal(shipments.wentBy({ status: 'PACKED', handover: null }), null);
});

test('an order that went two different ways does not claim either one', () => {
  const env = setup();
  const order = confirmedOrder(env, 6);

  const first = shipments.startPicking(env.db, env.ctx, order.id, {
    lines: [{ lineId: env.db.prepare('SELECT id FROM sales_order_lines WHERE sales_order_id = ?').get(order.id).id,
      locationId: env.workspace.main.id, quantity: 3 }] });
  shipments.ship(env.db, env.ctx, first.id, { handover: 'COLLECTED' });

  const second = shipments.startPicking(env.db, env.ctx, order.id);
  shipments.ship(env.db, env.ctx, second.id, { handover: 'CARRIER', carrier: 'ups' });

  assert.equal(shipments.wordForOrder(env.db, env.workspace.workspaceId, order.id), 'gone',
    'half collected and half posted is neither, so StockChief says the true thing');
});
