'use strict';

/**
 * Crossing a reorder point has to become something you see.
 *
 * The reported problem was not that the arithmetic was wrong — it was that
 * nothing happened. A configured level could be crossed and the only way to
 * find out was to go and open Reorder Settings, which is the one screen a
 * person who does not already know there is a problem has no reason to open.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { csrfFrom } = require('../helpers');
const {
  makeDatabase, cleanupAll, seedWorkspace, signIn, plain, makeQuantityItem,
} = require('../helpers');
const inventory = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const attention = require('../../src/attention/attention-engine');
const policyService = require('../../src/purchasing/policy-service');
const supplierService = require('../../src/purchasing/supplier-service');
const runner = require('../../src/autopilot/runner');
const workItems = require('../../src/autopilot/work-items');
const repo = require('../../src/domain/repository');
const autopilotPresenter = require('../../src/autopilot/presenter');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

async function warehouseAndShop({ warehouseStock, shopStock, shopSales, withSupplier = true, levels }) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Replenishment Co' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'replen' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Trail Ration Pack' });
  inventory.receive(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: warehouseStock, occurredAt: daysAgo(40),
  });
  inventory.receive(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.store.id, quantity: shopStock + shopSales, occurredAt: daysAgo(40),
  });
  for (let i = 0; i < shopSales; i += 1) {
    inventory.issue(store.db, workspace.ctx, {
      skuId: item.skuId, locationId: workspace.store.id, quantity: 1, reasonCode: 'sold',
      occurredAt: daysAgo(28 - (i % 28)),
    });
  }

  if (withSupplier) {
    const supplier = supplierService.createSupplier(store.db, workspace.ctx, membership, { name: 'ABC Supply' });
    supplierService.linkItem(store.db, workspace.ctx, membership, {
      supplierId: supplier.id, skuId: item.skuId, purchaseUnit: 'case',
      unitsPerPurchaseUnit: 12, minimumOrderQuantity: 1, leadTimeDays: 15, isPreferred: true,
    });
  }
  if (levels) policyService.setPolicy(store.db, workspace.ctx, membership, item.skuId, levels);

  attention.evaluate(store.db, workspace.workspaceId, { trigger: 'test' });
  return { ...store, workspace, membership, agent, item };
}

test('crossing a configured reorder point puts a plan in Needs you by itself', async () => {
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });

  const needsYou = plain((await env.agent.get('/needs-you')).text).replace(/\s+/g, ' ');
  assert.match(needsYou, /Trail Ration Pack/, 'the customer never opened Reorder Settings to find this');
  assert.match(needsYou, /48 on hand/);
  assert.match(needsYou, /reorder at 60/i);

  // And on the daily home, not only on the dedicated queue.
  const home = plain((await env.agent.get('/')).text).replace(/\s+/g, ' ');
  assert.match(home, /Trail Ration Pack/);
  env.db.close();
});

test('the plan shown for approval carries the reason, the working and the after-state', async () => {
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });
  const row = env.db
    .prepare("SELECT id FROM attention_items WHERE category = 'replenishment_needed' AND status = 'OPEN'")
    .get();
  assert.ok(row, 'a configured level was crossed, so there must be a finding');

  const page = await env.agent.get(`/attention/${row.id}`);
  assert.equal(page.status, 200);
  const text = plain(page.text).replace(/\s+/g, ' ');

  // The reason.
  assert.match(text, /at or below the reorder point of 60/i);
  // The exact movements and the exact order.
  assert.match(text, /from Main Warehouse to Downtown Store/i);
  assert.match(text, /3 case\(s\)/);
  assert.match(text, /36 unit\(s\) from ABC Supply/);
  // The working.
  assert.match(text, /How Foundry worked this out/i);
  assert.match(text, /Position across every location is 48 on hand \+ 0 on order = 48/);
  assert.match(text, /Order up to 84 − position 48 = 36 needed/);
  // What the inventory will look like afterwards.
  assert.match(text, /Afterwards: 48 on hand across every location, rising to 84/);
  env.db.close();
});

test('a transfer and an order are never proposed as contradictory alternatives', async () => {
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });
  const open = env.db
    .prepare("SELECT category, metrics FROM attention_items WHERE status = 'OPEN'")
    .all()
    .map((r) => ({ category: r.category, metrics: JSON.parse(r.metrics) }));

  // The old pair of cards cannot both exist: one plan owns this product.
  const imbalance = open.filter((r) => r.category === 'location_imbalance');
  assert.deepEqual(imbalance, [], 'the planner owns a configured line, not the old heuristic');

  const plan = open.find((r) => r.category === 'replenishment_needed');
  assert.ok(plan);
  // Both halves stated together, and reconciled: moving stock cannot have been
  // counted as if it also arrived from the supplier.
  assert.ok(plan.metrics.transferUnits > 0);
  assert.equal(plan.metrics.orderUnits, 36);
  assert.ok(
    plan.metrics.transferUnits < 45,
    `a plan that empties the warehouse is the bug: moved ${plan.metrics.transferUnits}`
  );
  assert.equal(plan.metrics.position, 48);
  env.db.close();
});

test('a line with no configured level is left to the ordinary findings', async () => {
  const env = await warehouseAndShop({ warehouseStock: 45, shopStock: 3, shopSales: 20, levels: null });
  const categories = env.db
    .prepare("SELECT DISTINCT category FROM attention_items WHERE status = 'OPEN'")
    .all()
    .map((r) => r.category);
  assert.ok(
    !categories.includes('replenishment_needed'),
    'a derived level is not a level the business asked to be told about'
  );
  env.db.close();
});

test('a level crossed with no supplier says so instead of proposing a quantity', async () => {
  const env = await warehouseAndShop({
    warehouseStock: 5, shopStock: 3, shopSales: 20, withSupplier: false,
    levels: { reorderPoint: 60, targetStock: 84 },
  });
  const row = env.db
    .prepare("SELECT id FROM attention_items WHERE category = 'replenishment_needed' AND status = 'OPEN'")
    .get();
  assert.ok(row);
  const text = plain((await env.agent.get(`/attention/${row.id}`)).text).replace(/\s+/g, ' ');
  assert.match(text, /no supplier/i);
  assert.match(text, /Add one for this line/i);
  // It must not invent a pack size, a cost or a lead time out of nothing.
  assert.doesNotMatch(text, /case\(s\) —/);
  env.db.close();
});

test('restocking drops the order half of the plan and keeps only what is still true', async () => {
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });
  const before = JSON.parse(env.db
    .prepare("SELECT metrics FROM attention_items WHERE category = 'replenishment_needed'").get().metrics);
  assert.equal(before.orderUnits, 36);

  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 40,
  });
  attention.evaluate(env.db, env.workspace.workspaceId, { trigger: 'test' });

  // Position is 88, above the reorder point, so nothing is bought. The shop is
  // still short of its own demand, so the move survives — one plan, revised,
  // rather than a stale recommendation to spend money.
  const after = JSON.parse(env.db
    .prepare("SELECT metrics FROM attention_items WHERE category = 'replenishment_needed'").get().metrics);
  assert.equal(after.orderUnits, 0, 'there is no longer anything to buy');
  assert.equal(after.decision, 'transfer');
  assert.ok(after.transferUnits > 0, 'but the stock is still in the wrong place');
  env.db.close();
});

test('a plan closes itself once nothing about it is true any more', async () => {
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });
  assert.ok(
    env.db.prepare("SELECT id FROM attention_items WHERE category = 'replenishment_needed' AND status = 'OPEN'").get()
  );

  // Enough overall, and enough at the shop that was short.
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.store.id, quantity: 40,
  });
  attention.evaluate(env.db, env.workspace.workspaceId, { trigger: 'test' });

  const still = env.db
    .prepare("SELECT status FROM attention_items WHERE category = 'replenishment_needed'").get();
  assert.notEqual(still.status, 'OPEN', 'a plan with nothing left to ask for must stand down');
  env.db.close();
});

test('approving the move goes through the ordinary proposal, and moves nothing early', async () => {
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });
  const row = env.db
    .prepare("SELECT id FROM attention_items WHERE category = 'replenishment_needed' AND status = 'OPEN'")
    .get();

  const detail = await env.agent.get(`/attention/${row.id}`);
  const before = env.db.prepare('SELECT COUNT(*) c FROM movements').get().c;

  const acted = await env.agent.post(`/attention/${row.id}/action`).type('form')
    .send({ _csrf: csrfFrom(detail.text) });
  assert.match(acted.headers.location, /^\/actions\//, 'it becomes a proposal to approve, not a movement');
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM movements').get().c, before,
    'preparing a transfer must not move stock');

  // The proposal is the plan's move, not a number invented at the button.
  const proposal = env.db
    .prepare('SELECT action_type, quantity FROM action_proposals ORDER BY created_at DESC').get();
  assert.equal(proposal.action_type, 'transfer');
  assert.equal(proposal.quantity, 7);

  const page = plain((await env.agent.get(acted.headers.location)).text).replace(/\s+/g, ' ');
  assert.match(page, /Main Warehouse/);
  assert.match(page, /Downtown Store/);
  env.db.close();
});

test('an order already prepared is not recommended a second time', async () => {
  // Found in the browser: clicking "Review the order" produced PO-1001 for 36,
  // and the plan then still offered to order 36 — because a draft is not
  // on-order, so nothing suppressed it. Two clicks, two orders, same stock.
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });
  const row = env.db
    .prepare("SELECT id FROM attention_items WHERE category = 'replenishment_needed' AND status = 'OPEN'")
    .get();
  const detail = await env.agent.get(`/attention/${row.id}`);
  const supplierId = env.db.prepare('SELECT id FROM suppliers LIMIT 1').get().id;

  const prepared = await env.agent.post(`/purchasing/prepare/${supplierId}`).type('form')
    .send({ _csrf: csrfFrom(detail.text) });
  assert.match(prepared.headers.location, /purchasing\/orders\//);
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, 1);

  // The plan is rebuilt on view, so this is what a person would now read.
  const again = plain((await env.agent.get(`/attention/${row.id}`)).text).replace(/\s+/g, ' ');
  assert.match(again, /already prepared/i);
  assert.match(again, /waiting for approval/i);
  assert.doesNotMatch(again, /36 unit\(s\) from ABC Supply/, 'it must not offer the same order again');

  // And pressing it again cannot quietly raise a second one.
  const twice = await env.agent.post(`/purchasing/prepare/${supplierId}`).type('form')
    .send({ _csrf: csrfFrom(detail.text) });
  assert.match(twice.headers.location, /purchasing/);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, 1,
    'a second draft for stock already drafted is a duplicate order'
  );
  env.db.close();
});

test('a card never argues with the plan printed inside it', async () => {
  // Found in the browser: after drafting the order, the body correctly said
  // "already prepared" while the heading above it still said "order 36".
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });
  const row = env.db
    .prepare("SELECT id FROM attention_items WHERE category = 'replenishment_needed' AND status = 'OPEN'")
    .get();
  const detail = await env.agent.get(`/attention/${row.id}`);
  const supplierId = env.db.prepare('SELECT id FROM suppliers LIMIT 1').get().id;
  await env.agent.post(`/purchasing/prepare/${supplierId}`).type('form')
    .send({ _csrf: csrfFrom(detail.text) });

  const text = plain((await env.agent.get(`/attention/${row.id}`)).text).replace(/\s+/g, ' ');
  assert.match(text, /already prepared/i);
  // Nothing anywhere on the page may still be offering that order.
  assert.doesNotMatch(text, /and order 36/i, 'the heading must not outlive the decision');
  assert.doesNotMatch(text, /order 3 case\(s\) from ABC Supply/i, 'nor the recommendation');
  assert.match(text, /Move 7 unit\(s\) between locations/);
  env.db.close();
});

test('a plan whose order is already drafted does not claim there is enough', async () => {
  // Found by asking "why is this low?" in the browser: the answer read "There
  // is enough overall — 48 against a reorder point of 60", which is false. Two
  // different reasons end in move-and-do-not-buy, and they were sharing a
  // sentence that only fits one of them.
  const env = await warehouseAndShop({
    warehouseStock: 45, shopStock: 3, shopSales: 20, levels: { reorderPoint: 60, targetStock: 84 },
  });
  const row = env.db
    .prepare("SELECT id FROM attention_items WHERE category = 'replenishment_needed' AND status = 'OPEN'")
    .get();
  const detail = await env.agent.get(`/attention/${row.id}`);
  const supplierId = env.db.prepare('SELECT id FROM suppliers LIMIT 1').get().id;
  await env.agent.post(`/purchasing/prepare/${supplierId}`).type('form')
    .send({ _csrf: csrfFrom(detail.text) });

  const text = plain((await env.agent.get(`/attention/${row.id}`)).text).replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /There is enough overall/,
    '48 against a reorder point of 60 is not enough, whatever is drafted');
  assert.match(text, /at or below the reorder point of 60/);
  assert.match(text, /already drafted on PO-1001/);
  env.db.close();
});

/**
 * The reported scenario, exactly: Black/Small at 55, reorder 60, target 80,
 * Downtown 10, Main Warehouse 45, ABC Apparel in cases of 12.
 *
 * What Needs Me held two independent approvals — "Move 45 to Downtown Store?"
 * and "PO-1002 is ready to send" — with no shared arithmetic. The move drained
 * the warehouse to zero as though the order were not happening, and the order
 * was sized as though the move were not.
 */
async function blackSmall() {
  const itemService = require('../../src/domain/item-service');
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Tee Co' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'plan-one' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const created = itemService.createItem(store.db, workspace.ctx, {
    name: 'Black T-shirt', baseCode: 'BT-1', trackingMode: 'quantity', hasVariants: true,
    options: [{ name: 'Colour', values: 'Black, White' }, { name: 'Size', values: 'Small, Large' }],
  });
  const small = repo.listSkusForItem(store.db, workspace.workspaceId, created.itemId)
    .find((sku) => sku.variant_label === 'Black / Small');

  inventory.receive(store.db, workspace.ctx, {
    skuId: small.id, locationId: workspace.main.id, quantity: 45, occurredAt: daysAgo(40),
  });
  inventory.receive(store.db, workspace.ctx, {
    skuId: small.id, locationId: workspace.store.id, quantity: 50, occurredAt: daysAgo(40),
  });
  // Downtown sells steadily and is down to 10 — short of its own fortnight of
  // cover, while the warehouse sits on 45 and sells none. 55 in total.
  for (let i = 0; i < 40; i += 1) {
    inventory.issue(store.db, workspace.ctx, {
      skuId: small.id, locationId: workspace.store.id, quantity: 1, reasonCode: 'sold',
      occurredAt: daysAgo(28 - (i % 28)),
    });
  }

  const supplier = supplierService.createSupplier(store.db, workspace.ctx, membership, { name: 'ABC Apparel' });
  supplierService.linkItem(store.db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: small.id, purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12, minimumOrderQuantity: 1, leadTimeDays: 15, isPreferred: true,
  });
  policyService.setPolicy(store.db, workspace.ctx, membership, small.id, { reorderPoint: 60, targetStock: 80 });

  return { ...store, workspace, membership, agent, small, supplier, itemId: created.itemId };
}

test('one need produces one decision, not a transfer approval and a PO approval', async () => {
  const env = await blackSmall();
  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'test' });

  const concernsSmall = (entry) => (entry.affectedEntities || {}).skuId === env.small.id
    || (((entry.recommendedAction || {}).lines) || []).some((line) => line.skuId === env.small.id);

  const open = workItems.list(env.db, env.workspace.workspaceId, { limit: 100 })
    .filter((entry) => !entry.isTerminal);
  const forSmall = open.filter(concernsSmall);

  assert.equal(
    forSmall.length, 1,
    `one stock need is one decision, got: ${forSmall.map((entry) => entry.category).join(', ')}`
  );
  const plan = forSmall[0];
  assert.equal(plan.category, 'replenishment_plan');
  assert.deepEqual(
    open.filter((entry) => ['balance_transfer', 'purchase_preparation'].includes(entry.category))
      .filter(concernsSmall),
    [],
    'neither half may also stand on its own'
  );

  // Both halves, with the arithmetic that says both are needed.
  const action = plan.recommendedAction;
  assert.equal(action.onHandTotal, 55);
  assert.equal(action.reorderPoint, 60);
  assert.equal(action.target, 80);
  assert.ok(action.transfers.length, 'the shop is short');
  assert.equal(action.orderUnits, 36, '80 - 55 = 25, rounded up to whole cases of 12');
  assert.equal(action.purchase.quantityPurchaseUnits, 3);

  // The warehouse is not drained to zero to satisfy the shop.
  const warehouseAfter = action.after.byLocation.find((row) => row.locationName === 'Main Warehouse');
  assert.ok(
    warehouseAfter.after > 0,
    `Main Warehouse must not be emptied without a rule saying it may: left ${warehouseAfter.after}`
  );
  assert.ok(action.transferUnits < 45, `moved ${action.transferUnits} of 45`);

  // Before and after, per location, with the total conserved by the move alone.
  assert.equal(action.after.onHandAfterMoves, 55, 'moving stock cannot create any');
  assert.equal(action.after.onHandAfterDelivery, 55 + action.orderUnits);
  env.db.close();
});

test('approving the one plan carries out both halves and verifies each', async () => {
  const poService = require('../../src/purchasing/po-service');
  const engine = require('../../src/domain/inventory-engine');

  const env = await blackSmall();
  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'test' });
  const plan = workItems.list(env.db, env.workspace.workspaceId, { category: 'replenishment_plan' })[0];
  assert.equal(plan.approvalRequirement, 'REQUIRED', 'a plan that spends money is never Foundry alone');

  const balance = (locationId) => repo.getBalance(env.db, env.workspace.workspaceId, env.small.id, locationId);
  const before = { warehouse: balance(env.workspace.main.id), shop: balance(env.workspace.store.id) };

  runner.approveWorkItem(env.db, env.workspace.ctx, env.membership, plan.id);
  const result = runner.executeWorkItem(env.db, env.workspace.ctx, env.membership, plan.id);

  assert.equal(result.executed, true);
  assert.equal(result.verified, true, JSON.stringify(result.checks));

  // The move happened through the ledger, and each leg was checked on its own.
  const after = { warehouse: balance(env.workspace.main.id), shop: balance(env.workspace.store.id) };
  const moved = before.warehouse - after.warehouse;
  assert.ok(moved > 0, 'the move ran');
  assert.equal(after.shop, before.shop + moved, 'what left one place arrived at the other');
  assert.equal(after.warehouse + after.shop, before.warehouse + before.shop, 'a move creates nothing');
  assert.ok(after.warehouse > 0, 'and it does not empty the warehouse');
  assert.ok(result.checks.some((check) => check.kind === 'transfer' && check.ok));

  // The order was prepared, not placed.
  assert.ok(result.purchaseOrderId, 'the order half ran too');
  const order = poService.get(env.db, env.workspace.workspaceId, result.purchaseOrderId);
  assert.equal(order.status, 'DRAFT', 'approving a plan does not tell a supplier anything');

  // And the ledger still agrees with itself afterwards.
  assert.equal(engine.verifyIntegrity(env.db, env.workspace.workspaceId).ok, true);
  env.db.close();
});

/**
 * Older fragments must not survive the plan that replaced them.
 *
 * Excluding a governed line from the two independent paths stops new fragments
 * being made and does nothing about the ones already in Needs you. Those stayed
 * approvable, so a person could approve the plan — moving stock and drafting an
 * order — and then approve the older transfer and the older PO the plan had
 * already accounted for, and move and buy the same stock twice.
 */
function olderFragmentsFor(env) {
  const transfer = workItems.upsert(env.db, env.workspace.workspaceId, {
    workPlanId: null,
    category: 'balance_transfer',
    source: 'balance_signal',
    affectedEntities: {
      skuId: env.small.id,
      displayName: 'Black T-shirt / Black / Small',
      fromLocationId: env.workspace.main.id,
      toLocationId: env.workspace.store.id,
    },
    recommendedAction: {
      actionType: 'transfer',
      skuId: env.small.id,
      quantity: 45,
      fromLocationId: env.workspace.main.id,
      toLocationId: env.workspace.store.id,
      fromLocationName: 'Main Warehouse',
      toLocationName: 'Downtown Store',
      displayName: 'Black T-shirt / Black / Small',
    },
    approvalRequirement: 'REQUIRED',
    executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
    priority: 50,
    urgency: 'normal',
    confidence: 'high',
    reason: 'Downtown Store is running low.',
    idempotencyKey: `balance_transfer:${env.small.id}:old`,
  }).item;

  const purchase = workItems.upsert(env.db, env.workspace.workspaceId, {
    workPlanId: null,
    category: 'purchase_preparation',
    source: 'replenishment',
    affectedEntities: { supplierId: env.supplier.id, supplierName: 'ABC Apparel' },
    recommendedAction: {
      actionType: 'prepare_purchase_order',
      supplierId: env.supplier.id,
      supplierName: 'ABC Apparel',
      lines: [{ skuId: env.small.id, quantityPurchaseUnits: 3, quantityUnits: 36 }],
    },
    approvalRequirement: 'REQUIRED',
    executionStatus: workItems.STATUS.WAITING_FOR_APPROVAL,
    priority: 60,
    urgency: 'normal',
    confidence: 'high',
    reason: 'Below the reorder point.',
    idempotencyKey: `purchase_preparation:${env.supplier.id}:old`,
  }).item;

  return { transfer, purchase };
}

test('a plan supersedes the older transfer and PO it replaces, leaving one decision', async () => {
  const env = await blackSmall();
  const older = olderFragmentsFor(env);

  // Both are live and approvable before the plan exists.
  assert.equal(workItems.get(env.db, env.workspace.workspaceId, older.transfer.id).isTerminal, false);
  assert.equal(workItems.get(env.db, env.workspace.workspaceId, older.purchase.id).isTerminal, false);

  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'manual' });

  const concernsSmall = (entry) => (entry.affectedEntities || {}).skuId === env.small.id
    || ((entry.recommendedAction || {}).skuId === env.small.id)
    || (((entry.recommendedAction || {}).lines) || []).some((line) => line.skuId === env.small.id);

  const active = workItems.list(env.db, env.workspace.workspaceId, { limit: 200 })
    .filter((entry) => !entry.isTerminal)
    .filter(concernsSmall);
  assert.equal(
    active.length, 1,
    `exactly one active decision, got: ${active.map((entry) => `${entry.category}/${entry.executionStatus}`).join(', ')}`
  );
  assert.equal(active[0].category, 'replenishment_plan');

  // The old ones are retired, not deleted, and say what took them over.
  for (const id of [older.transfer.id, older.purchase.id]) {
    const retired = workItems.get(env.db, env.workspace.workspaceId, id);
    assert.equal(retired.executionStatus, 'SUPERSEDED', `${retired.category} must be superseded`);
    assert.equal(retired.isTerminal, true, 'and terminal, so nothing can run it');
    assert.equal(retired.outcome.supersededByWorkItemId, active[0].id, 'naming the plan that took it over');
    assert.match(retired.outcome.supersededBecause, /one replenishment plan now covers this stock need/i);
  }

  // Still there to read afterwards.
  const everything = workItems.list(env.db, env.workspace.workspaceId, { limit: 200 }).map((entry) => entry.id);
  assert.ok(everything.includes(older.transfer.id), 'history keeps it');
  assert.ok(everything.includes(older.purchase.id), 'history keeps it');
  env.db.close();
});

test('a superseded action cannot be approved or executed', async () => {
  const env = await blackSmall();
  const older = olderFragmentsFor(env);
  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'manual' });

  const movementsBefore = env.db.prepare('SELECT COUNT(*) c FROM movements').get().c;
  const ordersBefore = env.db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c;

  for (const id of [older.transfer.id, older.purchase.id]) {
    assert.throws(
      () => runner.approveWorkItem(env.db, env.workspace.ctx, env.membership, id),
      /one replenishment plan now covers this stock need/i,
      'approving a superseded action must be refused, and say why'
    );
    const result = runner.executeWorkItem(env.db, env.workspace.ctx, env.membership, id);
    assert.equal(result.executed, false);
    assert.equal(result.superseded, true);
  }

  // The double execution this exists to prevent.
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM movements').get().c, movementsBefore,
    'no stock moved twice');
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, ordersBefore,
    'nothing was ordered twice');
  env.db.close();
});

test('pressing Check now again reuses the plan rather than making another', async () => {
  const env = await blackSmall();
  olderFragmentsFor(env);

  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'manual' });
  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'manual' });
  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'manual' });

  const plans = workItems.list(env.db, env.workspace.workspaceId, { category: 'replenishment_plan', limit: 100 });
  assert.equal(plans.length, 1, 'three checks, one plan');

  const active = workItems.list(env.db, env.workspace.workspaceId, { limit: 200 })
    .filter((entry) => !entry.isTerminal);
  assert.equal(
    active.length, 1,
    `re-checking must not accumulate work: ${active.map((entry) => entry.category).join(', ')}`
  );

  // And nothing was carried out by re-checking.
  assert.equal(
    env.db.prepare("SELECT COUNT(*) c FROM movements WHERE operation = 'transfer'").get().c, 0,
    'checking is not doing'
  );
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, 0);
  env.db.close();
});

/**
 * A draft order the plan contains is not a second decision.
 *
 * Superseding retired the older *work items*. A purchase order that had already
 * been drafted is not a work item — it is a row in purchase_orders — and it was
 * still listed on its own as "PO-1002 is ready to send", with its own approve
 * button, beside the plan that had already accounted for it.
 */
async function planWithAnExistingDraft() {
  const poService = require('../../src/purchasing/po-service');
  const env = await blackSmall();
  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    source: 'foundry_recommendation',
    lines: [{ skuId: env.small.id, quantityPurchaseUnits: 3 }],
  });
  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'manual' });
  return { ...env, order };
}

test('an order the plan contains is not offered for approval on its own', async () => {
  const env = await planWithAnExistingDraft();
  const prepared = autopilotPresenter.whatFoundryPrepared(env.db, env.workspace.workspaceId);

  assert.deepEqual(
    prepared.filter((entry) => entry.kind === 'purchase'), [],
    'the draft is reviewed through the plan, not beside it'
  );
  const plans = prepared.filter((entry) => entry.kind === 'work');
  assert.equal(plans.length, 1, `one decision, got: ${prepared.map((e) => e.title).join(' | ')}`);

  // The plan says it owns the order, and names it.
  const planItem = workItems.list(env.db, env.workspace.workspaceId, { category: 'replenishment_plan' })[0];
  const explained = autopilotPresenter.explain(env.db, env.workspace.workspaceId, planItem.id);
  const text = explained.paragraphs.join(' ');
  assert.match(text, /already drafted on PO-/);
  assert.match(text, /approved here rather than on its own/);
  env.db.close();
});

test('a plan-owned order cannot be approved from the purchasing page', async () => {
  const poService = require('../../src/purchasing/po-service');
  const env = await planWithAnExistingDraft();

  const page = await env.agent.get(`/purchasing/orders/${env.order.id}`);
  const posted = await env.agent.post(`/purchasing/orders/${env.order.id}/approve`).type('form')
    .send({ _csrf: csrfFrom(page.text), integrityHash: env.order.integrityHash });

  // Sent to the plan rather than quietly placing the order.
  assert.match(posted.headers.location, /\/autopilot\/work\//);
  assert.equal(
    poService.get(env.db, env.workspace.workspaceId, env.order.id).status, 'DRAFT',
    'the order must not have been placed independently of the plan'
  );
  env.db.close();
});

test('completed work does not claim an approval the plan now owns', async () => {
  const env = await planWithAnExistingDraft();
  const done = workItems.upsert(env.db, env.workspace.workspaceId, {
    workPlanId: null, category: 'purchase_preparation', source: 'replenishment',
    affectedEntities: { supplierId: env.supplier.id, supplierName: 'ABC Apparel' },
    recommendedAction: { actionType: 'prepare_purchase_order', supplierId: env.supplier.id, lines: [] },
    approvalRequirement: 'NONE', executionStatus: workItems.STATUS.DETECTED,
    priority: 60, urgency: 'normal', confidence: 'high',
    idempotencyKey: `purchase_preparation:${env.order.id}:done`,
  }).item;
  workItems.transition(env.db, env.workspace.workspaceId, done.id, workItems.STATUS.COMPLETED, {
    purchaseOrderId: env.order.id,
    verificationStatus: 'VERIFIED',
    outcome: { poNumber: 'PO-1002', lines: 1, subtotal: 0 },
  });

  const owned = new Set(autopilotPresenter.ordersOwnedByAPlan(env.db, env.workspace.workspaceId).keys());
  const card = autopilotPresenter.describeCompleted(
    workItems.get(env.db, env.workspace.workspaceId, done.id), owned
  );
  assert.match(card.detail, /part of a replenishment plan, and is approved there/);
  assert.doesNotMatch(card.detail, /Waiting for you to approve it/);

  // And without a plan owning it, the ordinary wording is unchanged.
  const plain = autopilotPresenter.describeCompleted(
    workItems.get(env.db, env.workspace.workspaceId, done.id), new Set()
  );
  assert.match(plain.detail, /Waiting for you to approve it/);
  env.db.close();
});

test('once the plan is done, the order is an ordinary draft again', async () => {
  const env = await planWithAnExistingDraft();
  const planItem = workItems.list(env.db, env.workspace.workspaceId, { category: 'replenishment_plan' })[0];

  runner.approveWorkItem(env.db, env.workspace.ctx, env.membership, planItem.id);
  runner.executeWorkItem(env.db, env.workspace.ctx, env.membership, planItem.id);

  // Placing the order is the act Foundry never does by itself, so once the plan
  // has finished it is the remaining decision and belongs back on its own.
  const owned = autopilotPresenter.ordersOwnedByAPlan(env.db, env.workspace.workspaceId);
  assert.equal(owned.size, 0, 'a finished plan owns nothing');
  const prepared = autopilotPresenter.whatFoundryPrepared(env.db, env.workspace.workspaceId);
  assert.ok(
    prepared.some((entry) => entry.kind === 'purchase'),
    'the draft is offered again once nothing else speaks for it'
  );
  env.db.close();
});
