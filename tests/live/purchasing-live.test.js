'use strict';

/**
 * Mission 6 against the real model.
 *
 * The model's whole job in purchasing is to recognise what kind of request it
 * is and name the things in it. It never decides a quantity — every number in
 * these assertions comes from the deterministic replenishment engine, and the
 * tests check that the language layer routes to it rather than inventing its
 * own answer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const actionService = require('../../src/actions/action-service');
const queryPlanner = require('../../src/attention/query-planner');
const queryService = require('../../src/attention/query-service');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const replenishment = require('../../src/purchasing/replenishment');
const engine = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const scenarios = require('../helpers/scenarios');

const LIVE = Boolean(process.env.ANTHROPIC_API_KEY);
const TIMEOUT = 120000;
const DAY = 24 * 60 * 60 * 1000;

test.after(cleanupAll);

/** A wholesaler at Mission 6's example numbers. */
function wholesaler() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Harbour Clothing' });
  scenarios.configure(db, workspace.workspaceId, {
    inventoryModel: { primaryArchetype: 'quantity', usesVariants: false },
  });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Navy Oxford' });

  const abc = suppliers.createSupplier(db, workspace.ctx, membership, {
    name: 'ABC Footwear',
    defaultLeadTimeDays: 21,
  });
  suppliers.linkItem(db, workspace.ctx, membership, {
    supplierId: abc.id,
    skuId: item.skuId,
    supplierSku: 'OX-NV-08',
    purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12,
    minimumOrderQuantity: 2,
    lastUnitCost: 8.2,
    leadTimeDays: 21,
  });

  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40 });
  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const stmt = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  for (let i = 0; i < 6; i += 1) {
    const result = engine.issue(db, workspace.ctx, {
      skuId: item.skuId, locationId: workspace.main.id, quantity: 5, reasonCode: 'sold',
    });
    for (const id of result.movementIds) stmt.run(new Date(Date.now() - (28 - i * 4) * DAY).toISOString(), id);
  }
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );

  return { db, workspace, ctx: workspace.ctx, membership, item, abc };
}

async function ask(env, question) {
  const plan = await queryPlanner.plan(question, {
    context: { locationNames: ['Main Warehouse', 'Downtown Store'] },
  });
  return { plan, result: queryService.execute(env.db, env.workspace.workspaceId, plan) };
}

test('“what should I order today?” is answered from the engine', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = wholesaler();
  const { plan, result } = await ask(env, 'What should I order today?');

  assert.equal(plan.intent, 'replenishment', JSON.stringify(plan));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].label, 'Navy Oxford');
  assert.equal(result.rows[0].supplier, 'ABC Footwear');

  // The figure came from the deterministic engine, not from the model.
  const engineAnswer = replenishment.evaluateOne(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.equal(result.rows[0].recommended, engineAnswer.quantityUnits);
  assert.equal(result.rows[0].recommended % 12, 0, 'whole cases only');
});

test('“what is already on order?” answers from real orders', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = wholesaler();
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: env.abc.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 4 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);

  const { plan, result } = await ask(env, "What's already on order?");
  assert.equal(plan.intent, 'on_order', JSON.stringify(plan));
  assert.match(result.answer, /48 unit\(s\) outstanding|1 purchase order/);
});

test('“who supplies this?” names the supplier on file', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = wholesaler();
  const { plan, result } = await ask(env, 'Who supplies the Navy Oxford?');

  assert.equal(plan.intent, 'suppliers_for_item', JSON.stringify(plan));
  assert.match(result.answer, /ABC Footwear/);
});

test('“how much did we last pay?” comes from committed orders', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = wholesaler();
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: env.abc.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2, unitCost: 7.9 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);

  const { plan, result } = await ask(env, 'How much did we last pay for Navy Oxfords?');
  assert.equal(plan.intent, 'last_cost', JSON.stringify(plan));
  assert.match(result.answer, /7\.9/);
  assert.match(result.answer, /ABC Footwear/);
});

test('an instruction to order becomes a draft order, not a purchase', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = wholesaler();
  const result = await actionService.interpret(
    env.db, env.ctx, env.membership, 'Order 5 cases of Navy Oxford from ABC Footwear'
  );

  assert.equal(result.kind, 'purchase_order', JSON.stringify(result));
  assert.equal(result.order.supplierName, 'ABC Footwear');
  assert.equal(result.order.status, 'DRAFT', 'nothing is committed to without approval');
  assert.equal(result.order.lines.length, 1);
  assert.equal(result.order.lines[0].quantityPurchaseUnits, 5);
  assert.equal(result.order.lines[0].quantityUnits, 60);
  assert.equal(result.order.lines[0].unitCost, 8.2);
});

test('ordering without a number uses the engine, and says so', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = wholesaler();
  const result = await actionService.interpret(
    env.db, env.ctx, env.membership, 'Reorder the Navy Oxfords from ABC'
  );

  assert.equal(result.kind, 'purchase_order', JSON.stringify(result));
  const engineAnswer = replenishment.evaluateOne(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.equal(result.order.lines[0].quantityUnits, engineAnswer.quantityUnits);
  assert.match(result.assumptions.join(' '), /reorder point/i);
});

test('a delivery announcement opens receiving rather than booking anything in', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = wholesaler();
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: env.abc.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 4 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);
  const before = env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE operation = 'receive'").get().n;

  const result = await actionService.interpret(
    env.db, env.ctx, env.membership, "ABC Footwear's shipment arrived"
  );

  assert.equal(result.kind, 'receive_shipment', JSON.stringify(result));
  assert.match(result.supplier, /ABC/);
  assert.equal(
    env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE operation = 'receive'").get().n,
    before,
    'saying a shipment arrived must not book it in by itself'
  );
});

test('Foundry still refuses what it genuinely cannot do', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = wholesaler();
  for (const question of [
    'What was our gross profit last month?',
    'Send the purchase order to ABC by email',
  ]) {
    const { plan } = await ask(env, question);
    assert.equal(plan.intent, 'unsupported', `"${question}" produced ${plan.intent}`);
    assert.ok(plan.unsupportedReason.length > 0);
  }
});
