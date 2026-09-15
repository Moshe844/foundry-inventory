'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const prices = require('../../src/pricing/price-service');
const kits = require('../../src/domain/kit-service');
const needsYou = require('../../src/manager/needs-you-inbox');
const attention = require('../../src/attention/attention-engine');
const reorderPolicies = require('../../src/purchasing/policy-service');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const reevaluate = require('../../src/attention/reevaluate');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup(name = 'Mission 10 Co') {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: name });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', code: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  return { db, workspace, membership, item, ctx: workspace.ctx };
}

function draft(env, quantity, overrides = {}) {
  return sales.createOrder(env.db, env.ctx, {
    customerName: overrides.customerName || 'ABC School', neededBy: overrides.neededBy || null,
    fulfillmentLocationId: overrides.fulfillmentLocationId || null,
    lines: [{ skuId: env.item.skuId, quantity }],
  });
}

test('a kit stays one customer SKU while its exact components reserve and leave inventory', () => {
  const env = setup('Kit sales company');
  const cleaner = makeQuantityItem(env.db, env.ctx, { name: 'Cleaner', baseCode: 'CLEAN-1' });
  const cloth = makeQuantityItem(env.db, env.ctx, { name: 'Shop Cloth', baseCode: 'CLOTH-1' });
  const kit = makeQuantityItem(env.db, env.ctx, { name: 'Maintenance Starter Kit', baseCode: 'KIT-1' });
  kits.define(env.db, env.ctx, { kitSkuId: kit.skuId, components: [
    { skuId: cleaner.skuId, quantity: 2 },
    { skuId: cloth.skuId, quantity: 3 },
  ] });
  prices.setPrice(env.db, env.ctx, { skuId: kit.skuId, amount: '49.00', currency: 'USD' });
  inventory.receive(env.db, env.ctx, { skuId: cleaner.skuId, locationId: env.workspace.main.id, quantity: 10 });
  inventory.receive(env.db, env.ctx, { skuId: cloth.skuId, locationId: env.workspace.main.id, quantity: 10 });

  let order = sales.createOrder(env.db, env.ctx, { customerName: 'Kit Customer',
    fulfillmentLocationId: env.workspace.main.id, lines: [{ skuId: kit.skuId, quantity: 2 }] });
  assert.equal(order.lines.length, 1, 'the customer order contains the kit, not invented component sale lines');
  assert.equal(order.lines[0].isKit, true);
  assert.deepEqual(order.lines[0].kitComponents.map((row) => [row.code, Number(row.quantity_required)]),
    [['CLEAN-1', 4], ['CLOTH-1', 6]]);

  order = sales.confirm(env.db, env.ctx, order.id);
  assert.equal(order.status, 'CONFIRMED');
  assert.deepEqual(order.totals, { ordered: 2, fulfilled: 0, allocated: 2, backordered: 0 });
  assert.equal(sales.availabilityForSku(env.db, env.workspace.workspaceId, cleaner.skuId).committed, 4);
  assert.equal(sales.availabilityForSku(env.db, env.workspace.workspaceId, cloth.skuId).committed, 6);
  assert.equal(sales.availabilityForSku(env.db, env.workspace.workspaceId, kit.skuId).committed, 0,
    'a virtual kit is never treated as physical stock');

  order = sales.fulfill(env.db, env.ctx, order.id, {}, { idempotencyKey: `kit:${order.id}` });
  assert.equal(order.status, 'FULFILLED');
  assert.equal(order.lines.length, 1);
  assert.equal(order.lines[0].quantity_fulfilled, 2);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, cleaner.skuId, env.workspace.main.id), 6);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, cloth.skuId, env.workspace.main.id), 4);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, kit.skuId, env.workspace.main.id), 0);
});

test('a kit pick list shows physical components while shipment fulfills the kit line', () => {
  const env = setup('Kit shipment company');
  const partA = makeQuantityItem(env.db, env.ctx, { name: 'Filter', baseCode: 'FILTER-1' });
  const partB = makeQuantityItem(env.db, env.ctx, { name: 'Gloves', baseCode: 'GLOVE-1' });
  const kit = makeQuantityItem(env.db, env.ctx, { name: 'Service Kit', baseCode: 'SERVICE-KIT' });
  kits.define(env.db, env.ctx, { kitSkuId: kit.skuId, components: [
    { skuId: partA.skuId, quantity: 1 }, { skuId: partB.skuId, quantity: 2 },
  ] });
  prices.setPrice(env.db, env.ctx, { skuId: kit.skuId, amount: '30.00', currency: 'USD' });
  inventory.receive(env.db, env.ctx, { skuId: partA.skuId, locationId: env.workspace.main.id, quantity: 5 });
  inventory.receive(env.db, env.ctx, { skuId: partB.skuId, locationId: env.workspace.main.id, quantity: 10 });
  let order = sales.createOrder(env.db, env.ctx, { customerName: 'Shipment Customer',
    fulfillmentLocationId: env.workspace.main.id, deliveryMethod: 'PICKUP',
    lines: [{ skuId: kit.skuId, quantity: 2 }] });
  order = sales.confirm(env.db, env.ctx, order.id);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  assert.deepEqual(box.lines.map((line) => [line.sku_code, Number(line.quantity)]),
    [['FILTER-1', 2], ['GLOVE-1', 4]]);
  assert.equal(box.lines.every((line) => line.kit_component_id), true);
  shipments.ship(env.db, env.ctx, box.id, { handover: 'COLLECTED' });
  order = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(order.status, 'FULFILLED');
  assert.equal(order.lines[0].quantity_fulfilled, 2);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, partA.skuId, env.workspace.main.id), 3);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, partB.skuId, env.workspace.main.id), 6);
});

test('new component stock closes a kit backorder without reserving fictional kit stock', () => {
  const env = setup('Kit replenishment company');
  const component = makeQuantityItem(env.db, env.ctx, { name: 'Replacement Filter', baseCode: 'FILTER-R' });
  const kit = makeQuantityItem(env.db, env.ctx, { name: 'Filter Pair Kit', baseCode: 'FILTER-KIT' });
  kits.define(env.db, env.ctx, { kitSkuId: kit.skuId,
    components: [{ skuId: component.skuId, quantity: 2 }] });
  prices.setPrice(env.db, env.ctx, { skuId: kit.skuId, amount: '19.00', currency: 'USD' });

  let order = sales.createOrder(env.db, env.ctx, { customerName: 'Waiting Kit Customer',
    fulfillmentLocationId: env.workspace.main.id, lines: [{ skuId: kit.skuId, quantity: 3 }] });
  order = sales.confirm(env.db, env.ctx, order.id);
  assert.deepEqual(order.totals, { ordered: 3, fulfilled: 0, allocated: 0, backordered: 3 });
  assert.deepEqual(sales.backorderedBySku(env.db, env.workspace.workspaceId),
    [{ sku_id: component.skuId, backordered: 6 }]);

  const movement = inventory.receive(env.db, env.ctx, {
    skuId: component.skuId, locationId: env.workspace.main.id, quantity: 6,
  });
  reevaluate.afterMovement(env.db, env.workspace.workspaceId, [component.skuId], 'receive', {
    sourceRecordId: movement.movementIds[0],
  });

  order = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(order.status, 'CONFIRMED');
  assert.deepEqual(order.totals, { ordered: 3, fulfilled: 0, allocated: 3, backordered: 0 });
  assert.equal(sales.availabilityForSku(env.db, env.workspace.workspaceId, component.skuId).committed, 6);
  assert.equal(sales.availabilityForSku(env.db, env.workspace.workspaceId, kit.skuId).committed, 0);
});

test('Mission 10 commitments preserve on-hand, fulfillment consumes both, and cancellation releases the remainder', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 50 });
  let order = sales.confirm(env.db, env.ctx, draft(env, 30).id);
  let position = sales.availabilityForSku(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.deepEqual({ onHand: position.onHand, committed: position.committed, available: position.available },
    { onHand: 50, committed: 30, available: 20 });

  const line = order.lines[0];
  order = sales.fulfill(env.db, env.ctx, order.id, { lines: [{
    lineId: line.id, locationId: env.workspace.main.id, quantity: 10,
  }] }, { idempotencyKey: `test-fulfill:${order.id}:10` });
  assert.equal(order.status, 'PARTIALLY_FULFILLED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 40);
  position = sales.availabilityForSku(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.deepEqual({ onHand: position.onHand, committed: position.committed, available: position.available },
    { onHand: 40, committed: 20, available: 20 });

  order = sales.cancel(env.db, env.ctx, order.id, 'Customer no longer needs the remainder.');
  assert.equal(order.status, 'CANCELLED');
  position = sales.availabilityForSku(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.deepEqual({ onHand: position.onHand, committed: position.committed, available: position.available },
    { onHand: 40, committed: 0, available: 40 });
});

test('Mission 10 allocates what exists and records the rest as an honest backorder', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 60 });
  const order = sales.confirm(env.db, env.ctx, draft(env, 100).id);
  assert.equal(order.status, 'BACKORDERED');
  assert.deepEqual(order.totals, { ordered: 100, fulfilled: 0, allocated: 60, backordered: 40 });
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 60);
});

test('Mission 10 newly received stock is automatically committed to the oldest waiting order', () => {
  const env = setup();
  let order = sales.confirm(env.db, env.ctx, draft(env, 12).id);
  assert.deepEqual(order.totals, { ordered: 12, fulfilled: 0, allocated: 0, backordered: 12 });

  const movement = inventory.receive(env.db, env.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 7,
  });
  reevaluate.afterMovement(env.db, env.workspace.workspaceId, [env.item.skuId], 'receive', {
    sourceRecordId: movement.movementIds[0],
  });

  order = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.deepEqual(order.totals, { ordered: 12, fulfilled: 0, allocated: 7, backordered: 5 });
  assert.equal(order.status, 'BACKORDERED');
  assert.ok(order.events.some((event) => event.event_type === 'ALLOCATION_CHANGED'));
});

test('Mission 10 full fulfillment closes the order through the existing inventory ledger', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  let order = sales.confirm(env.db, env.ctx, draft(env, 10).id);
  order = sales.fulfill(env.db, env.ctx, order.id, { lines: [{
    lineId: order.lines[0].id, locationId: env.workspace.main.id, quantity: 10,
  }] }, { idempotencyKey: `full:${order.id}` });
  assert.equal(order.status, 'FULFILLED');
  assert.deepEqual(order.totals, { ordered: 10, fulfilled: 10, allocated: 0, backordered: 0 });
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 0);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'issue'")
    .get(env.workspace.workspaceId).n, 1);
});

test('Mission 10 serializes competing allocation so two orders cannot reserve the same units', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const first = sales.confirm(env.db, env.ctx, draft(env, 8, { customerName: 'First Customer' }).id);
  const second = sales.confirm(env.db, env.ctx, draft(env, 8, { customerName: 'Second Customer' }).id);
  assert.equal(first.totals.allocated, 8);
  assert.equal(second.totals.allocated, 2);
  assert.equal(second.totals.backordered, 6);
  assert.equal(sales.availabilityForSku(env.db, env.workspace.workspaceId, env.item.skuId).committed, 10);
});

test('Mission 10 honors a preferred fulfillment location and then allocates sensibly across the network', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 30 });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.store.id, quantity: 5 });
  const order = sales.confirm(env.db, env.ctx, draft(env, 20, { fulfillmentLocationId: env.workspace.store.id }).id);
  const allocated = new Map(order.lines[0].allocations.map((row) => [row.location_id, row.quantity]));
  assert.equal(allocated.get(env.workspace.store.id), 5);
  assert.equal(allocated.get(env.workspace.main.id), 15);
  assert.equal(order.totals.backordered, 0);
});

test('Mission 10 requested-date shortfalls become one clear Needs You decision', () => {
  const env = setup();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const order = sales.confirm(env.db, env.ctx, draft(env, 12, { neededBy: tomorrow }).id);
  const item = needsYou.inbox(env.db, env.workspace.workspaceId)
    .find((entry) => entry.id.startsWith(`sales-order:${order.id}:`));
  assert.ok(item);
  assert.equal(item.href, `/purchasing/supplier-for/${env.item.skuId}`,
    'the decision opens the exact missing supplier setup, not the same order page again');
  assert.equal(item.importance, 'Urgent');
  assert.match(item.title, /ABC School needs 12.*normal supply is too late/i);
  assert.match(item.why, /cannot promise the requested date/i);
});

test('Mission 10 sales orders and commitments are isolated between workspaces', () => {
  const first = setup('First Sales Workspace');
  const second = setup('Second Sales Workspace');
  inventory.receive(first.db, first.ctx, { skuId: first.item.skuId, locationId: first.workspace.main.id, quantity: 10 });
  const order = sales.confirm(first.db, first.ctx, draft(first, 7).id);
  assert.equal(sales.listOrders(second.db, second.workspace.workspaceId).length, 0);
  assert.throws(() => sales.getOrder(second.db, second.workspace.workspaceId, order.id), /not in this inventory/i);
  assert.equal(sales.availabilityForSku(second.db, second.workspace.workspaceId, second.item.skuId).committed, 0);
});

function configureReplenishment(env) {
  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, { name: 'Apparel Supply' });
  supplierService.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.item.skuId, isPreferred: true,
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 5, leadTimeDays: 5,
  });
  reorderPolicies.setPolicy(env.db, env.ctx, env.membership, env.item.skuId, {
    reorderPoint: 50, targetStock: 80, safetyStock: 0,
  });
  return supplier;
}

test('Mission 10 confirmation drives replenishment immediately from available stock without Check now', () => {
  const env = setup();
  configureReplenishment(env);
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 100 });
  const order = sales.confirm(env.db, env.ctx, draft(env, 80).id);
  assert.equal(order.totals.allocated, 80);
  const current = attention.listAttention(env.db, env.workspace.workspaceId, { category: 'replenishment_needed' });
  assert.equal(current.length, 1, 'the confirmed commitment caused the scoped manager reaction');
  assert.match(current[0].explanation, /committed|available/i);
  assert.ok(env.db.prepare("SELECT 1 FROM domain_events WHERE workspace_id = ? AND event_type = 'sales_order.confirmed' AND status = 'PROCESSED'")
    .get(env.workspace.workspaceId));
});

test('Mission 10 existing on-order stock covers committed demand and prevents duplicate purchasing', () => {
  const env = setup();
  const supplier = configureReplenishment(env);
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 100 });
  const po = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, lines: [{ skuId: env.item.skuId, quantityUnits: 60 }],
  });
  poService.approve(env.db, env.ctx, env.membership, po.id, { expectedHash: po.integrityHash });
  sales.confirm(env.db, env.ctx, draft(env, 80).id);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1);
  assert.equal(attention.listAttention(env.db, env.workspace.workspaceId, { category: 'replenishment_needed' }).length, 0);
});

test('Mission 10 cancellation releases demand and automatically clears replenishment raised only for that order', () => {
  const env = setup();
  configureReplenishment(env);
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 100 });
  const order = sales.confirm(env.db, env.ctx, draft(env, 80).id);
  assert.equal(attention.listAttention(env.db, env.workspace.workspaceId, { category: 'replenishment_needed' }).length, 1);
  sales.cancel(env.db, env.ctx, order.id, 'Customer cancelled.');
  assert.equal(attention.listAttention(env.db, env.workspace.workspaceId, { category: 'replenishment_needed' }).length, 0);
});
