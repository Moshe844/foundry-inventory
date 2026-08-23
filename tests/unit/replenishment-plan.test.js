'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem,
} = require('../helpers');
const inventory = require('../../src/domain/inventory-engine');
const locationService = require('../../src/domain/location-service');
const signalEngine = require('../../src/signals/signal-engine');
const policyService = require('../../src/purchasing/policy-service');
const supplierService = require('../../src/purchasing/supplier-service');
const authService = require('../../src/domain/auth-service');
const plan = require('../../src/purchasing/replenishment-plan');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

/**
 * A warehouse holding plenty and a shop that sells but is nearly empty — the
 * shape that used to produce two contradictory recommendations at once.
 */
function twoLocations({ warehouseStock = 45, shopStock = 3, shopSales = 20, warehouseSales = 0 } = {}) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Two Sites Co' });
  const warehouse = workspace.main;
  const shop = store.db
    .prepare("SELECT id, name FROM locations WHERE workspace_id = ? AND name = 'Downtown Store'")
    .get(workspace.workspaceId)
    || locationService.createLocation(store.db, workspace.ctx, { name: 'Downtown Store', kind: 'store' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Trail Ration Pack' });

  inventory.receive(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: warehouse.id, quantity: warehouseStock + warehouseSales,
    occurredAt: daysAgo(40),
  });
  inventory.receive(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: shop.id, quantity: shopStock + shopSales, occurredAt: daysAgo(40),
  });
  // Real dated outbound, spread out, so usage is measured rather than assumed.
  for (let i = 0; i < shopSales; i += 1) {
    inventory.issue(store.db, workspace.ctx, {
      skuId: item.skuId, locationId: shop.id, quantity: 1, reasonCode: 'sold',
      occurredAt: daysAgo(28 - (i % 28)),
    });
  }
  for (let i = 0; i < warehouseSales; i += 1) {
    inventory.issue(store.db, workspace.ctx, {
      skuId: item.skuId, locationId: warehouse.id, quantity: 1, reasonCode: 'sold',
      occurredAt: daysAgo(28 - (i % 28)),
    });
  }

  const signalsFor = () => signalEngine.skuSignals(store.db, workspace.workspaceId, {})
    .find((s) => s.skuId === item.skuId);

  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  return { ...store, workspace, membership, warehouse, shop, item, signalsFor };
}

function addSupplier(env, { unitsPerPurchaseUnit = 12, minimumOrderQuantity = 1, leadTimeDays = 15 } = {}) {
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, env.membership, {
    name: 'ABC Supply',
  });
  supplierService.linkItem(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.item.skuId,
    purchaseUnit: 'case', unitsPerPurchaseUnit, minimumOrderQuantity, leadTimeDays,
    isPreferred: true,
  });
  return supplier;
}

const setLevels = (env, levels) =>
  policyService.setPolicy(env.db, env.workspace.ctx, env.membership, env.item.skuId, levels);

test('a plan never moves stock it also assumes it is buying', () => {
  // The reported nonsense: "move all 45 warehouse units downtown" printed
  // beside "order 36 from the supplier".
  const env = twoLocations({ warehouseStock: 45, shopStock: 3, shopSales: 20 });
  addSupplier(env);
  setLevels(env, { reorderPoint: 60, targetStock: 84 });

  const result = plan.buildPlan(env.db, env.workspace.workspaceId, env.signalsFor());

  assert.equal(result.decision, 'transfer_and_purchase');
  assert.equal(result.onHandTotal, 48);
  assert.equal(result.networkPosition, 48);

  // The order is the network shortfall, and nothing else. 84 − 48 = 36.
  assert.equal(result.purchase.shortfall, 36);
  assert.equal(result.purchase.quantityUnits, 36);
  assert.equal(result.purchase.quantityPurchaseUnits, 3);

  // The transfer never empties the source, and never exceeds what is spare.
  const moved = result.transfers.reduce((n, m) => n + m.quantity, 0);
  assert.ok(moved > 0, 'the shop is short and the warehouse has spare');
  const warehouseAfter = result.after.byLocation.find((l) => l.locationName === 'Main Warehouse');
  assert.ok(warehouseAfter.after >= warehouseAfter.need,
    `the warehouse must keep its own need: kept ${warehouseAfter.after}, needs ${warehouseAfter.need}`);
  assert.ok(moved < 45, 'moving everything is never the answer');

  // The whole point: the two halves reconcile.
  assert.equal(result.after.onHandAfterMoves, 48, 'a transfer cannot change how much exists');
  assert.equal(result.after.onHandAfterDelivery, 84, 'and the delivery lands exactly on the target');
  env.db.close();
});

test('the order quantity is identical whether or not stock is moved', () => {
  // The mathematical guarantee, asserted rather than asserted-in-prose: a
  // transfer changes location balances and must leave the purchase untouched.
  const spread = twoLocations({ warehouseStock: 24, shopStock: 24, shopSales: 20 });
  addSupplier(spread);
  setLevels(spread, { reorderPoint: 60, targetStock: 84 });
  const spreadPlan = plan.buildPlan(spread.db, spread.workspace.workspaceId, spread.signalsFor());

  const lumped = twoLocations({ warehouseStock: 45, shopStock: 3, shopSales: 20 });
  addSupplier(lumped);
  setLevels(lumped, { reorderPoint: 60, targetStock: 84 });
  const lumpedPlan = plan.buildPlan(lumped.db, lumped.workspace.workspaceId, lumped.signalsFor());

  assert.equal(spreadPlan.onHandTotal, lumpedPlan.onHandTotal, 'same total, different distribution');
  assert.equal(
    spreadPlan.purchase.quantityUnits,
    lumpedPlan.purchase.quantityUnits,
    'where the stock sits cannot change how much is bought'
  );
  spread.db.close();
  lumped.db.close();
});

test('enough stock in the wrong place is a transfer, and buys nothing', () => {
  const env = twoLocations({ warehouseStock: 80, shopStock: 2, shopSales: 20 });
  addSupplier(env);
  setLevels(env, { reorderPoint: 60, targetStock: 84 });

  const result = plan.buildPlan(env.db, env.workspace.workspaceId, env.signalsFor());
  assert.equal(result.decision, 'transfer');
  assert.equal(result.purchase, null, 'position of 82 is above the reorder point of 60');
  assert.ok(result.transfers.length, 'but the shop still needs stock it does not have');
  assert.match(result.explanation, /not where the demand is/i);
  env.db.close();
});

test('stock already on order suppresses a second order', () => {
  const env = twoLocations({ warehouseStock: 45, shopStock: 3, shopSales: 20 });
  addSupplier(env);
  setLevels(env, { reorderPoint: 60, targetStock: 84 });

  const withoutOrder = plan.buildPlan(env.db, env.workspace.workspaceId, env.signalsFor());
  assert.equal(withoutOrder.purchase.quantityUnits, 36);

  // The same line, with 36 already inbound, must not order 36 again.
  const covered = plan.buildPlan(env.db, env.workspace.workspaceId, env.signalsFor(), {
    incoming: { onOrder: 36, lines: [], orders: [], nextExpectedDate: '2026-09-01', overdueUnits: 0 },
  });
  assert.equal(covered.networkPosition, 84);
  assert.equal(covered.purchase, null, 'already covered');
  assert.match(
    covered.calculation.map((s) => s.detail).join(' '),
    /Already on order: 36/,
    'and it says so'
  );
  env.db.close();
});

test('a reserve is a refusal, not a preference', () => {
  const env = twoLocations({ warehouseStock: 45, shopStock: 3, shopSales: 20 });
  addSupplier(env);
  setLevels(env, { reorderPoint: 60, targetStock: 84 });

  const floors = new Map([[env.warehouse.id, 44]]);
  const result = plan.buildPlan(env.db, env.workspace.workspaceId, env.signalsFor(), {
    reserveFloors: floors,
  });

  const moved = result.transfers.reduce((n, m) => n + m.quantity, 0);
  assert.ok(moved <= 1, `only the single unit above the reserve may move, moved ${moved}`);
  const warehouseAfter = result.after.byLocation.find((l) => l.locationName === 'Main Warehouse');
  assert.ok(warehouseAfter.after >= 44, 'the reserve holds even though the shop is short');
  assert.match(
    result.calculation.map((s) => s.detail).join(' '),
    /keeps a reserve of 44/,
    'and the plan names the rule that stopped it'
  );
  env.db.close();
});

test('a plan states what the inventory will look like afterwards', () => {
  const env = twoLocations({ warehouseStock: 45, shopStock: 3, shopSales: 20 });
  addSupplier(env);
  setLevels(env, { reorderPoint: 60, targetStock: 84 });

  const result = plan.buildPlan(env.db, env.workspace.workspaceId, env.signalsFor());
  assert.ok(result.after.byLocation.length >= 2);
  for (const row of result.after.byLocation) {
    assert.equal(typeof row.before, 'number');
    assert.equal(typeof row.after, 'number');
  }
  // Every step that produced a number is available to read back.
  const keys = result.calculation.map((s) => s.step);
  for (const expected of ['on_hand', 'demand', 'reorder_point', 'on_order', 'position', 'transfer', 'purchase']) {
    assert.ok(keys.includes(expected), `the plan must show its "${expected}" step`);
  }
  env.db.close();
});

test('no reorder point means no plan, not a guessed one', () => {
  const env = twoLocations({ warehouseStock: 45, shopStock: 3, shopSales: 0 });
  const result = plan.buildPlan(env.db, env.workspace.workspaceId, env.signalsFor());
  assert.equal(result.reorderPoint, null);
  assert.equal(result.decision, 'none');
  assert.deepEqual(result.transfers, [], 'no level means no basis for moving anything');
  env.db.close();
});

test('below the point with no supplier is blocked, and says which line', () => {
  const env = twoLocations({ warehouseStock: 5, shopStock: 3, shopSales: 20 });
  setLevels(env, { reorderPoint: 60, targetStock: 84 });

  const result = plan.buildPlan(env.db, env.workspace.workspaceId, env.signalsFor());
  assert.equal(result.blocked, 'no_supplier');
  assert.equal(result.purchase, null);
  assert.ok(result.belowReorderPoint);
  env.db.close();
});
