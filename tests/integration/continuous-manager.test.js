'use strict';

/** Mission 9 acceptance matrix: committed event -> scoped safe reaction. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const reevaluate = require('../../src/attention/reevaluate');
const events = require('../../src/manager/events');
const reactions = require('../../src/manager/reactions');
const physicalEvents = require('../../src/manager/physical-events');
const investigations = require('../../src/manager/investigations');
const needsYou = require('../../src/manager/needs-you-inbox');
const supplierService = require('../../src/purchasing/supplier-service');
const reorderPolicies = require('../../src/purchasing/policy-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const position = require('../../src/purchasing/position');
const modes = require('../../src/autopilot/modes');
const scheduler = require('../../src/autopilot/scheduler');
const workItems = require('../../src/autopilot/work-items');
const { addLocalDays, localDateKey } = require('../../src/lib/calendar');
const {
  seedAuthorityWorkspace, approveTransferPolicy, balanceAt,
} = require('../helpers/autopilot-authority-fixture');

test.after(cleanupAll);

function database() { return makeDatabase().db; }

function purchasingScenario({ stock = 10, reorderPoint = 5, targetStock = 10 } = {}) {
  const db = database();
  const workspace = seedWorkspace(db, { workspaceName: 'Continuous Purchasing' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Continuous Widget' });
  inventory.receive(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: stock,
  });
  const supplier = supplierService.createSupplier(db, workspace.ctx, membership, {
    name: 'Reliable Parts', defaultLeadTimeDays: 5,
  });
  supplierService.linkItem(db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, purchaseUnit: 'unit',
    unitsPerPurchaseUnit: 1, minimumOrderQuantity: 1, orderMultiple: 1,
    leadTimeDays: 5, lastUnitCost: 2, isPreferred: true,
  });
  reorderPolicies.setPolicy(db, workspace.ctx, membership, item.skuId, {
    reorderPoint, targetStock, preferredSupplierId: supplier.id, leadTimeDays: 5,
  });
  return { db, workspace, membership, item, supplier };
}

function placeOrder(env, units = 6, expectedDate = null) {
  const draft = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    destinationLocationId: env.workspace.main.id,
    expectedDate,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: units }],
  });
  return poService.approve(env.db, env.workspace.ctx, env.membership, draft.id, {
    expectedHash: draft.integrityHash,
  });
}

function react(env, type, payload = {}, options = {}) {
  return reactions.publishAndReact(env.db, env.workspace.workspaceId, type, payload, {
    idempotencyKey: options.idempotencyKey || `${type}:${Date.now()}:${Math.random()}`,
    now: options.now,
  });
}

test('Mission 9.1 sale below reorder point creates replenishment without Check now', () => {
  const env = purchasingScenario();
  const sale = inventory.issue(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 6, reasonCode: 'sold',
  });
  reevaluate.afterMovement(env.db, env.workspace.workspaceId, [env.item.skuId], 'issue', {
    sourceRecordId: sale.movementIds[0],
  });

  const plans = workItems.list(env.db, env.workspace.workspaceId, { category: 'replenishment_plan' });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].executionStatus, workItems.STATUS.WAITING_FOR_APPROVAL);
  assert.ok(events.list(env.db, env.workspace.workspaceId).some((event) =>
    event.type === events.TYPES.INVENTORY_ISSUED && event.status === events.STATUS.PROCESSED));
});

test('Mission 9.2 qualifying transfer inside authority executes automatically', () => {
  const db = database();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'M9 Auto Transfer' });
  const policy = approveTransferPolicy(env, { maximumQuantity: 5 });
  modes.setMode(db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
  const before = balanceAt(env, env.destination.id);
  const published = react(env, events.TYPES.INVENTORY_ISSUED, { skuId: env.sku.id });

  assert.equal(balanceAt(env, env.destination.id), before + 5);
  const [done] = workItems.list(db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.equal(done.executionStatus, workItems.STATUS.COMPLETED);
  assert.equal(done.triggerEventId, published.event.id);
  assert.equal(done.outcome.triggerEventId, published.event.id);
  assert.equal(done.outcome.policyId, policy.id);
  assert.equal(done.outcome.policyVersion, policy.version);
  assert.equal(done.verificationStatus, 'VERIFIED');
});

test('Mission 9.3 transfer outside authority goes to Needs You', () => {
  const db = database();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 8, workspaceName: 'M9 Limited Transfer' });
  approveTransferPolicy(env, { maximumQuantity: 5 });
  modes.setMode(db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
  const before = balanceAt(env, env.destination.id);
  react(env, events.TYPES.INVENTORY_ISSUED, { skuId: env.sku.id });

  assert.equal(balanceAt(env, env.destination.id), before);
  const [waiting] = workItems.awaitingApproval(db, env.workspace.workspaceId);
  assert.equal(waiting.recommendedAction.quantity, 8);
  assert.match(waiting.policyEvaluation.reason, /at most 5 units/i);
  assert.ok(needsYou.inbox(db, env.workspace.workspaceId).some((entry) => entry.id === `work:${waiting.id}`));
});

test('Mission 9.4 placing a PO updates position and replay cannot duplicate purchasing', () => {
  const env = purchasingScenario({ stock: 4 });
  const order = placeOrder(env, 6);
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);
  const beforeReplay = env.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n;
  reactions.publishAndReact(env.db, env.workspace.workspaceId, events.TYPES.PURCHASE_ORDER_PLACED, {
    purchaseOrderId: order.id, skuId: env.item.skuId,
  }, { sourceRecordType: 'purchase_order', sourceRecordId: `${order.id}:${order.updatedAt}` });

  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, env.item.skuId).position, 10);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, beforeReplay);
});

test('Mission 9.5 partial receipt reduces on-order and creates no duplicate reorder', () => {
  const env = purchasingScenario({ stock: 4 });
  const order = placeOrder(env, 6);
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);
  const received = receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: 'm9-partial',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 2, locationId: env.workspace.main.id }],
  });
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);

  assert.equal(received.order.status, poService.STATUS.PARTIALLY_RECEIVED);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, env.item.skuId).onOrder, 4);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 1);
});

test('Mission 9.6 full receipt closes replenishment automatically', () => {
  const env = purchasingScenario({ stock: 4 });
  const order = placeOrder(env, 6);
  react(env, events.TYPES.PURCHASE_ORDER_PLACED, { purchaseOrderId: order.id, skuId: env.item.skuId });
  const current = poService.get(env.db, env.workspace.workspaceId, order.id);
  receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: 'm9-full',
    lines: [{ lineId: current.lines[0].id, quantityUnits: 6, locationId: env.workspace.main.id }],
  });
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);

  assert.equal(poService.get(env.db, env.workspace.workspaceId, order.id).status, poService.STATUS.RECEIVED);
  assert.equal(workItems.awaitingApproval(env.db, env.workspace.workspaceId)
    .filter((item) => item.category === 'replenishment_plan').length, 0);
});

test('Mission 9.7 physical count discrepancy appears in Needs You automatically', () => {
  const env = purchasingScenario({ stock: 10, reorderPoint: 0, targetStock: 0 });
  const event = physicalEvents.record(env.db, env.workspace.ctx, {
    eventType: 'physical_count', statedAs: 'I counted 7 Continuous Widgets at Main Warehouse.',
    skuId: env.item.skuId, locationId: env.workspace.main.id, countedQuantity: 7,
    displayName: 'Continuous Widget',
  });
  assert.ok(event.investigationId);
  assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId)
    .some((entry) => entry.id === `investigation:${event.investigationId}`));
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 10);
});

test('Mission 9.8 confirmed count correction clears the discrepancy automatically', () => {
  const env = purchasingScenario({ stock: 10, reorderPoint: 0, targetStock: 0 });
  const event = physicalEvents.record(env.db, env.workspace.ctx, {
    eventType: 'physical_count', statedAs: 'I counted 7 Continuous Widgets at Main Warehouse.',
    skuId: env.item.skuId, locationId: env.workspace.main.id, countedQuantity: 7,
    displayName: 'Continuous Widget',
  });
  investigations.resolve(env.db, env.workspace.ctx, event.investigationId, 'A second count confirmed 7.');
  const correction = inventory.adjust(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, countedQty: 7,
    reasonCode: 'physical_count', notes: 'Confirmed recount',
  });
  reevaluate.afterMovement(env.db, env.workspace.workspaceId, [env.item.skuId], 'adjust', {
    sourceRecordId: correction.movementIds[0],
  });

  assert.equal(investigations.list(env.db, env.workspace.workspaceId, {
    statuses: ['NEEDS_HUMAN', 'INCONCLUSIVE'], limit: 20,
  }).length, 0);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 7);
});

test('Mission 9.9 changing a reorder policy reconsiders only the affected variant', () => {
  const env = purchasingScenario({ stock: 4, reorderPoint: 3, targetStock: 4 });
  reorderPolicies.setPolicy(env.db, env.workspace.ctx, env.membership, env.item.skuId, {
    reorderPoint: 5, targetStock: 10, preferredSupplierId: env.supplier.id,
  });
  react(env, events.TYPES.REORDER_POLICY_UPDATED, { skuId: env.item.skuId, change: 'levels' });
  const [plan] = workItems.list(env.db, env.workspace.workspaceId, { category: 'replenishment_plan' });
  assert.ok(plan);
  assert.equal(plan.recommendedAction.reorderPoint, 5);
  assert.equal(plan.recommendedAction.target, 10);
});

test('Mission 9.10 authority change safely reconsiders eligible pending work', () => {
  const db = database();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'M9 Authority Change' });
  modes.setMode(db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
  react(env, events.TYPES.INVENTORY_ISSUED, { skuId: env.sku.id });
  assert.equal(workItems.awaitingApproval(db, env.workspace.workspaceId).length, 1);

  approveTransferPolicy(env, { maximumQuantity: 5 });
  react(env, events.TYPES.AUTHORITY_UPDATED, { change: 'policy_approved' });
  assert.equal(balanceAt(env, env.destination.id), 9);
  assert.equal(workItems.awaitingApproval(db, env.workspace.workspaceId).length, 0);
});

test('Mission 9.11 Pause stops automatic consequential reactions', () => {
  const db = database();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'M9 Paused' });
  approveTransferPolicy(env, { maximumQuantity: 5 });
  modes.setMode(db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
  modes.pause(db, env.ctx, env.membership, 'Mission 9 pause test');
  const before = balanceAt(env, env.destination.id);
  react(env, events.TYPES.INVENTORY_ISSUED, { skuId: env.sku.id });
  assert.equal(balanceAt(env, env.destination.id), before);
});

test('Mission 9.12 Resume immediately resumes eligible management', () => {
  const db = database();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'M9 Resume' });
  approveTransferPolicy(env, { maximumQuantity: 5 });
  modes.setMode(db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
  modes.pause(db, env.ctx, env.membership, 'Mission 9 resume test');
  react(env, events.TYPES.INVENTORY_ISSUED, { skuId: env.sku.id });
  modes.resume(db, env.ctx, env.membership);
  react(env, events.TYPES.FOUNDRY_RESUMED, { resumed: true });
  assert.equal(balanceAt(env, env.destination.id), 9);
});

test('Mission 9.13 a PO becomes due/late from a scheduled time turn alone', () => {
  const env = purchasingScenario({ stock: 20, reorderPoint: 0, targetStock: 0 });
  const tomorrow = addLocalDays(localDateKey(), 1);
  const order = placeOrder(env, 6, tomorrow);
  const twoDaysLater = new Date(`${addLocalDays(localDateKey(), 2)}T17:00:00.000Z`).getTime();
  scheduler.runWorkspace(env.db, env.workspace.workspaceId, {
    now: twoDaysLater, trigger: 'scheduled', intervalMs: 15 * 60 * 1000,
  });
  const [followup] = workItems.list(env.db, env.workspace.workspaceId, { category: 'receiving_followup' });
  assert.ok(followup);
  assert.equal(followup.recommendedAction.purchaseOrderId, order.id);
  assert.equal(followup.recommendedAction.late, true);
  assert.equal(followup.triggerEventId !== null, true);
});

test('Mission 9.14 replaying one event never duplicates movement, work, or Needs You', () => {
  const db = database();
  const env = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'M9 Replay' });
  approveTransferPolicy(env, { maximumQuantity: 5 });
  modes.setMode(db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
  const key = 'm9-replayed-source-event';
  const first = reactions.publishAndReact(db, env.workspace.workspaceId, events.TYPES.INVENTORY_ISSUED,
    { skuId: env.sku.id }, { idempotencyKey: key });
  const movementCount = db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND notes LIKE '%autopilot%'")
    .get(env.workspace.workspaceId).n;
  const second = reactions.publishAndReact(db, env.workspace.workspaceId, events.TYPES.INVENTORY_ISSUED,
    { skuId: env.sku.id }, { idempotencyKey: key });

  assert.equal(second.event.id, first.event.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND notes LIKE '%autopilot%'")
    .get(env.workspace.workspaceId).n, movementCount);
  assert.equal(workItems.list(db, env.workspace.workspaceId, { category: 'balance_transfer' }).length, 1);
});

test('Mission 9.15 events and reactions remain isolated between workspaces', () => {
  const db = database();
  const a = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'M9 Workspace A' });
  const b = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'M9 Workspace B' });
  approveTransferPolicy(a, { maximumQuantity: 5 });
  approveTransferPolicy(b, { maximumQuantity: 5 });
  modes.setMode(db, a.ctx, a.membership, modes.MODES.POLICY_AUTOMATED);
  modes.setMode(db, b.ctx, b.membership, modes.MODES.POLICY_AUTOMATED);
  const beforeB = balanceAt(b, b.destination.id);

  react(a, events.TYPES.INVENTORY_ISSUED, { skuId: a.sku.id });

  assert.equal(balanceAt(a, a.destination.id), 9);
  assert.equal(balanceAt(b, b.destination.id), beforeB);
  assert.equal(events.list(db, b.workspace.workspaceId).length, 0);
  assert.equal(workItems.list(db, b.workspace.workspaceId, { category: 'balance_transfer' }).length, 0);
});
