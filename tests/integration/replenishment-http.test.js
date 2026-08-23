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
