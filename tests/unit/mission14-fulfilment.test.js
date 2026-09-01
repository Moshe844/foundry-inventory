'use strict';

/*
 * Fulfilment: pick, pack, ship, deliver.
 *
 * The claim these tests defend is that picking and packing move no stock, and
 * that shipping moves it exactly once. Everything else here is a consequence
 * of that: two boxes cannot claim the same unit, a cancelled box gives its
 * stock back without a movement, and a shipment that fails to issue leaves no
 * trace saying it went.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const carriers = require('../../src/sales/carriers');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup(name = 'Fulfilment Co') {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: name });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', code: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  return { db, workspace, item, ctx: workspace.ctx };
}

function confirmedOrder(env, quantity) {
  const order = sales.createOrder(env.db, env.ctx, {
    customerName: 'ABC School',
    lines: [{ skuId: env.item.skuId, quantity }],
  });
  return sales.confirm(env.db, env.ctx, order.id);
}

const onHand = (env) => repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id);
const position = (env) => sales.availabilityForSku(env.db, env.workspace.workspaceId, env.item.skuId);

test('picking and packing move no stock; shipping moves it exactly once', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 50 });
  const order = confirmedOrder(env, 30);

  let shipment = shipments.startPicking(env.db, env.ctx, order.id);
  assert.equal(shipment.status, 'PICKING');
  assert.equal(shipment.units, 30);
  assert.equal(onHand(env), 50, 'picking must not take anything off the shelf');
  assert.equal(position(env).committed, 30, 'it was already committed and stays committed');

  shipment = shipments.markPacked(env.db, env.ctx, shipment.id, { packageCount: 2, weightGrams: 3400 });
  assert.equal(shipment.status, 'PACKED');
  assert.equal(shipment.package_count, 2);
  assert.equal(onHand(env), 50, 'packing must not take anything off the shelf either');

  shipment = shipments.ship(env.db, env.ctx, shipment.id, {
    carrier: 'ups', service: 'Ground', trackingNumber: '1Z999AA10123456784', shippingCostMinor: 1250,
  });
  assert.equal(shipment.status, 'SHIPPED');
  assert.equal(onHand(env), 20, 'shipping is the one place stock leaves');
  assert.deepEqual({ committed: position(env).committed, available: position(env).available },
    { committed: 0, available: 20 });

  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, order.id).status, 'FULFILLED');
  assert.equal(shipment.trackingUrl, 'https://www.ups.com/track?tracknum=1Z999AA10123456784');

  const delivered = shipments.markDelivered(env.db, env.ctx, shipment.id, { deliveredAt: '2026-09-04' });
  assert.equal(delivered.status, 'DELIVERED');
  assert.equal(delivered.delivered_at, '2026-09-04');
});

test('shipping the same box twice issues stock once', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  const order = confirmedOrder(env, 10);
  const shipment = shipments.startPicking(env.db, env.ctx, order.id);

  shipments.ship(env.db, env.ctx, shipment.id, { carrier: 'usps' });
  assert.equal(onHand(env), 30);
  const again = shipments.ship(env.db, env.ctx, shipment.id, { carrier: 'usps' });
  assert.equal(again.status, 'SHIPPED');
  assert.equal(onHand(env), 30, 'a repeated ship must not issue the stock a second time');
});

test('two boxes cannot claim the same allocated unit', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  const order = confirmedOrder(env, 20);
  const line = order.lines[0];

  shipments.startPicking(env.db, env.ctx, order.id, {
    lines: [{ lineId: line.id, locationId: env.workspace.main.id, quantity: 12 }],
  });
  const free = shipments.pickable(env.db, env.workspace.workspaceId, order.id);
  assert.equal(free[0].available, 8, 'the first box holds 12 of the 20 allocated');

  assert.throws(() => shipments.startPicking(env.db, env.ctx, order.id, {
    lines: [{ lineId: line.id, locationId: env.workspace.main.id, quantity: 9 }],
  }), /already in another box/);

  const second = shipments.startPicking(env.db, env.ctx, order.id);
  assert.equal(second.units, 8, 'a second box defaults to exactly what is left free');
  assert.equal(shipments.pickable(env.db, env.workspace.workspaceId, order.id).length, 0);
});

test('cancelling a box returns its claim without moving stock', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 25 });
  const order = confirmedOrder(env, 15);
  const shipment = shipments.startPicking(env.db, env.ctx, order.id);
  assert.equal(shipments.pickable(env.db, env.workspace.workspaceId, order.id).length, 0);

  const cancelled = shipments.cancelShipment(env.db, env.ctx, shipment.id, 'Customer pushed the date.');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(onHand(env), 25, 'nothing physical moved, so nothing physical comes back');
  assert.equal(shipments.pickable(env.db, env.workspace.workspaceId, order.id)[0].available, 15);

  assert.throws(() => shipments.ship(env.db, env.ctx, shipment.id, {}), /cancelled shipment cannot be shipped/);
});

test('a shipped box cannot be cancelled or re-picked', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const order = confirmedOrder(env, 5);
  const shipment = shipments.startPicking(env.db, env.ctx, order.id);
  const line = shipment.lines[0];
  shipments.ship(env.db, env.ctx, shipment.id, {});

  assert.throws(() => shipments.cancelShipment(env.db, env.ctx, shipment.id), /Record a return/);
  assert.throws(() => shipments.setLineQuantity(env.db, env.ctx, shipment.id,
    line.sales_order_line_id, line.location_id, 2), /already gone/);
});

test('a part shipment leaves the order partly shipped and the rest still pickable', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 30 });
  const order = confirmedOrder(env, 20);
  const line = order.lines[0];

  const first = shipments.startPicking(env.db, env.ctx, order.id, {
    lines: [{ lineId: line.id, locationId: env.workspace.main.id, quantity: 8 }],
  });
  shipments.ship(env.db, env.ctx, first.id, { carrier: 'fedex', trackingNumber: '123456789012' });

  const after = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(after.status, 'PARTIALLY_FULFILLED');
  assert.equal(onHand(env), 22);
  assert.equal(shipments.fulfilmentState(env.db, env.workspace.workspaceId, after).state, 'Partly shipped');

  const second = shipments.startPicking(env.db, env.ctx, order.id);
  assert.equal(second.units, 12);
  shipments.ship(env.db, env.ctx, second.id, {});
  const done = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(done.status, 'FULFILLED');
  assert.equal(shipments.fulfilmentState(env.db, env.workspace.workspaceId, done).state, 'Shipped');
  assert.equal(shipments.listForOrder(env.db, env.workspace.workspaceId, order.id).length, 2);
});

test('the fulfilment state is derived, and names what the order is waiting for', () => {
  const env = setup();
  const draft = sales.createOrder(env.db, env.ctx, {
    customerName: 'ABC School', lines: [{ skuId: env.item.skuId, quantity: 6 }],
  });
  const state = (order) => shipments.fulfilmentState(env.db, env.workspace.workspaceId, order).state;
  assert.equal(state(draft), 'Not confirmed');

  const order = sales.confirm(env.db, env.ctx, draft.id);
  assert.equal(state(sales.getOrder(env.db, env.workspace.workspaceId, order.id)), 'Waiting for stock');

  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 6 });
  sales.allocateAvailable(env.db, env.ctx, order.id);
  const ready = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(state(ready), 'Ready to pick');

  const shipment = shipments.startPicking(env.db, env.ctx, order.id);
  assert.equal(state(ready), 'Picking');
  shipments.markPacked(env.db, env.ctx, shipment.id, {});
  assert.equal(state(ready), 'Packed');
  shipments.ship(env.db, env.ctx, shipment.id, {});
  assert.equal(state(sales.getOrder(env.db, env.workspace.workspaceId, order.id)), 'Shipped');
  shipments.markDelivered(env.db, env.ctx, shipment.id, {});
  assert.equal(state(sales.getOrder(env.db, env.workspace.workspaceId, order.id)), 'Delivered');
});

test('the pick list is grouped by location, because picking costs footsteps', () => {
  const env = setup();
  const second = require('../../src/domain/location-service').createLocation(env.db, env.ctx,
    { name: 'Back Room', kind: 'warehouse' });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 4 });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: second.id, quantity: 6 });
  const order = confirmedOrder(env, 10);

  const shipment = shipments.startPicking(env.db, env.ctx, order.id);
  const list = shipments.pickList(env.db, env.workspace.workspaceId, shipment.id);
  assert.equal(list.units, 10);
  assert.equal(list.stops.length, 2);
  assert.deepEqual(list.stops.map((stop) => stop.locationName).sort(), ['Back Room', 'Main Warehouse']);
  assert.equal(shipment.ship_from_location_id, null, 'a box drawn from two rooms has no single origin');
});

test('an unconfirmed or unallocated order cannot start a box', () => {
  const env = setup();
  const draft = sales.createOrder(env.db, env.ctx, {
    customerName: 'ABC School', lines: [{ skuId: env.item.skuId, quantity: 3 }],
  });
  assert.throws(() => shipments.startPicking(env.db, env.ctx, draft.id), /Confirm this sales order/);

  const order = sales.confirm(env.db, env.ctx, draft.id);
  assert.throws(() => shipments.startPicking(env.db, env.ctx, order.id), /Nothing is allocated/);
});

test('the work queue separates boxes needing a person from orders needing a box', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 30 });
  const first = confirmedOrder(env, 5);
  const secondOrder = confirmedOrder(env, 7);

  let queue = shipments.workQueue(env.db, env.workspace.workspaceId);
  assert.equal(queue.open.length, 0);
  assert.equal(queue.ready.length, 2);
  assert.deepEqual(queue.ready.map((row) => row.units), [5, 7]);

  const box = shipments.startPicking(env.db, env.ctx, first.id);
  queue = shipments.workQueue(env.db, env.workspace.workspaceId);
  assert.equal(queue.open.length, 1);
  assert.equal(queue.open[0].order_number, first.order_number);
  assert.equal(queue.ready.length, 1, 'an order fully claimed by a box is no longer waiting for one');

  shipments.ship(env.db, env.ctx, box.id, {});
  queue = shipments.workQueue(env.db, env.workspace.workspaceId);
  assert.equal(queue.open.length, 0, 'a shipped box needs nobody');
  assert.equal(queue.ready[0].order_number, secondOrder.order_number);
});

test('a tracking number names its own carrier, and an ambiguous one names none', () => {
  assert.equal(carriers.detect('1Z999AA10123456784').code, 'ups');
  assert.equal(carriers.detect('9'.repeat(20)), null, '20 digits is both USPS and FedEx');
  assert.equal(carriers.detect('not a tracking number'), null);
  assert.equal(carriers.trackingUrlFor('other', '12345'), null, 'an unknown carrier has no link to offer');

  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 5 });
  const order = confirmedOrder(env, 2);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, { trackingNumber: '1Z999AA10123456784' });
  assert.equal(shipped.carrier, 'ups', 'the carrier was read from the number, not asked for');
  assert.equal(shipped.carrierName, 'UPS');
});

test('what goes in the box can be changed until it is packed', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20 });
  const order = confirmedOrder(env, 10);
  const line = order.lines[0];
  const box = shipments.startPicking(env.db, env.ctx, order.id);

  let updated = shipments.setLineQuantity(env.db, env.ctx, box.id, line.id, env.workspace.main.id, 4);
  assert.equal(updated.units, 4);
  assert.equal(shipments.pickable(env.db, env.workspace.workspaceId, order.id)[0].available, 6);

  assert.throws(() => shipments.setLineQuantity(env.db, env.ctx, box.id, line.id, env.workspace.main.id, 11),
    /Only 10 of that is allocated/);

  updated = shipments.setLineQuantity(env.db, env.ctx, box.id, line.id, env.workspace.main.id, 0);
  assert.equal(updated.units, 0);
  assert.throws(() => shipments.markPacked(env.db, env.ctx, box.id, {}), /This box is empty/);
});

test('a box carries the address it was picked for, not the customer of the day', () => {
  const env = setup();
  const customer = sales.createCustomer(env.db, env.ctx, {
    name: 'ABC School', shippingAddress: '14 Mill Lane\nRiverside, OR 97001',
  });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 3 }],
  }).id);

  const box = shipments.startPicking(env.db, env.ctx, order.id);
  assert.match(box.ship_to_address, /14 Mill Lane/);

  sales.updateCustomer(env.db, env.ctx, customer.id, {
    name: 'ABC School', shippingAddress: '900 New Road\nElsewhere, OR 97002',
  });
  const again = shipments.getShipment(env.db, env.workspace.workspaceId, box.id);
  assert.match(again.ship_to_address, /14 Mill Lane/,
    'a customer moving must not rewrite where an existing box was addressed');
});
