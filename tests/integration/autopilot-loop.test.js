'use strict';

/**
 * Mission 7: the loop, and the first real autonomous action.
 *
 * The scenario is the one from the brief — kids tights, Black / Size 5, eight
 * left in Brooklyn against sixty-one in New Jersey, with Brooklyn doing all the
 * selling. Foundry should notice, check the policy, move twelve, verify the
 * result, and be able to explain itself afterwards.
 *
 * The rest of the file is the part that matters more: what happens when the
 * world changes between planning and execution, when verification fails, when
 * the scheduler fires twice, and when the process dies mid-transfer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const modes = require('../../src/autopilot/modes');
const policyService = require('../../src/autopilot/policy-service');
const workItems = require('../../src/autopilot/work-items');
const planner = require('../../src/autopilot/planner');
const runner = require('../../src/autopilot/runner');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;

/**
 * Kids Tights: Black and White in sizes 2, 5 and 8, across two warehouses,
 * with Brooklyn selling and New Jersey barely moving.
 */
/**
 * @param {object} options
 *   allStockAtBrooklyn — put every unit where the trading happens, so the line
 *     needs an order and nothing else. Purchasing authority is what those tests
 *     are about; a line that also needs a transfer is now one combined
 *     replenishment decision, which is a different behaviour with its own test.
 */
function tights({ allStockAtBrooklyn = false } = {}) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Kids Tights' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);

  const created = itemService.createItem(db, workspace.ctx, {
    name: 'Kids Tights',
    baseCode: 'KT-100',
    trackingMode: 'quantity',
    hasVariants: true,
    options: [
      { name: 'Colour', values: 'Black, White' },
      { name: 'Size', values: '2, 5, 8' },
    ],
  });
  const skus = repo.listSkusForItem(db, workspace.workspaceId, created.itemId);
  const black5 = skus.find((sku) => sku.variant_label === 'Black / 5');

  const brooklyn = workspace.main;      // "Main Warehouse"
  const jersey = workspace.store;       // "Downtown Store"

  // Opening stock, then a month of trading that only Brooklyn did.
  inventory.receive(db, workspace.ctx, {
    skuId: black5.id, locationId: brooklyn.id, quantity: allStockAtBrooklyn ? 94 : 29,
  });
  if (!allStockAtBrooklyn) {
    inventory.receive(db, workspace.ctx, { skuId: black5.id, locationId: jersey.id, quantity: 65 });
  }

  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const backdate = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  const issue = (skuId, locationId, quantity, daysAgo) => {
    const result = inventory.issue(db, workspace.ctx, { skuId, locationId, quantity, reasonCode: 'sold' });
    const when = new Date(Date.now() - daysAgo * DAY).toISOString();
    for (const id of result.movementIds) backdate.run(when, id);
  };
  // Brooklyn: 21 sold over the month. New Jersey: 4.
  for (const [quantity, daysAgo] of [[5, 28], [4, 22], [3, 16], [4, 10], [5, 4]]) {
    issue(black5.id, brooklyn.id, quantity, daysAgo);
  }
  if (!allStockAtBrooklyn) issue(black5.id, jersey.id, 4, 12);
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );

  return { db, workspace, membership, ctx: workspace.ctx, itemId: created.itemId, black5, brooklyn, jersey };
}

/** The approved warehouse-balancing policy from the brief. */
function balancing(env, overrides = {}) {
  const policy = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Automatic Warehouse Balancing',
    description: 'Move stock between our warehouses when one is about to run out.',
    allowedActionTypes: ['transfer'],
    locationScope: [env.brooklyn.id, env.jersey.id],
    conditions: [
      policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK,
      policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
    ],
    maximumQuantity: 12,
    ...overrides,
  });
  return policyService.approve(env.db, env.ctx, env.membership, policy.id);
}

const balanceOf = (env, locationId) => repo.getBalance(env.db, env.workspace.workspaceId, env.black5.id, locationId);

// --- the signal --------------------------------------------------------------

test('the balancing signal finds the shortage and sizes the move from real demand', () => {
  const env = tights();
  const signalEngine = require('../../src/signals/signal-engine');
  const [sku] = signalEngine.skuSignals(env.db, env.workspace.workspaceId, { skuIds: [env.black5.id] });

  const proposal = planner.planBalanceTransfer(env.db, env.workspace.workspaceId, sku, { maximumQuantity: 12 });

  assert.ok(proposal, 'Brooklyn is running down and New Jersey is not — that is a transfer');
  assert.equal(proposal.toLocationId, env.brooklyn.id);
  assert.equal(proposal.fromLocationId, env.jersey.id);
  assert.equal(proposal.quantity, 12, 'capped by the policy ceiling');
  assert.equal(proposal.conditions.destination_stockout_risk.passed, true);
  assert.equal(proposal.conditions.source_above_safety.passed, true);
  assert.match(proposal.conditions.destination_stockout_risk.detail, /8 left and issued 21/);
});

test('a product nobody is buying is left alone', () => {
  const env = tights();
  const signalEngine = require('../../src/signals/signal-engine');
  const skus = repo.listSkusForItem(env.db, env.workspace.workspaceId, env.itemId);
  const white8 = skus.find((sku) => sku.variant_label === 'White / 8');
  inventory.receive(env.db, env.ctx, { skuId: white8.id, locationId: env.jersey.id, quantity: 40 });

  const [sku] = signalEngine.skuSignals(env.db, env.workspace.workspaceId, { skuIds: [white8.id] });
  assert.equal(
    planner.planBalanceTransfer(env.db, env.workspace.workspaceId, sku, { maximumQuantity: 12 }),
    null,
    'no outbound history means no basis for moving anything'
  );
});

// --- the scenario ------------------------------------------------------------

test('supervised: Foundry prepares the transfer and waits', () => {
  const env = tights();
  balancing(env);   // approved policy, but the workspace stays supervised

  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  assert.equal(result.executed, 0, 'a policy alone must not be enough');
  assert.equal(result.awaiting, 1);
  assert.equal(balanceOf(env, env.brooklyn.id), 8, 'nothing moved');

  const [waiting] = workItems.awaitingApproval(env.db, env.workspace.workspaceId);
  assert.equal(waiting.category, 'balance_transfer');
  assert.match(waiting.policyEvaluation.reason, /supervised/);

  // And somebody was told there is a decision to make.
  const note = env.db
    .prepare("SELECT * FROM notifications WHERE workspace_id = ? AND kind = 'approval_required'")
    .get(env.workspace.workspaceId);
  assert.ok(note);
  assert.match(note.title, /Move 12 Kids Tights \/ Black \/ 5/);
});

test('on autopilot: Foundry moves the stock, verifies it, and records why', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  const before = { brooklyn: balanceOf(env, env.brooklyn.id), jersey: balanceOf(env, env.jersey.id) };
  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  assert.equal(result.executed, 1);
  const [done] = result.results;
  assert.equal(done.verified, true, JSON.stringify(done.checks));

  // The stock actually moved, and the total is unchanged.
  assert.equal(balanceOf(env, env.brooklyn.id), before.brooklyn + 12);
  assert.equal(balanceOf(env, env.jersey.id), before.jersey - 12);
  assert.equal(
    balanceOf(env, env.brooklyn.id) + balanceOf(env, env.jersey.id),
    before.brooklyn + before.jersey
  );
  assert.equal(inventory.verifyIntegrity(env.db, env.workspace.workspaceId).ok, true);

  // It went through the Mission 4 engine, so it is an ordinary transfer.
  const item = done.item;
  assert.equal(item.executionStatus, 'COMPLETED');
  assert.equal(item.verificationStatus, 'VERIFIED');
  assert.ok(item.proposalId, 'executed through a real action proposal');

  // Everything "why did you do that" needs is on the record.
  assert.equal(item.policyEvaluation.decision, 'authorized');
  const passed = item.policyEvaluation.checks.filter((check) => check.passed).map((check) => check.name);
  assert.ok(passed.includes('Within the policy quantity limit'));
  const evidence = item.sourceEvidence.map((entry) => `${entry.label}: ${entry.value}`).join(' | ');
  assert.match(evidence, /Main Warehouse on hand: 8/);
  assert.match(evidence, /Downtown Store on hand: 61/);
  assert.deepEqual(item.outcome.checks.map((check) => check.ok), [true, true, true]);

  // …and it said so.
  const note = env.db
    .prepare("SELECT * FROM notifications WHERE workspace_id = ? AND kind = 'action_completed'")
    .get(env.workspace.workspaceId);
  assert.match(note.title, /Moved 12 Kids Tights \/ Black \/ 5 to Main Warehouse/);
});

test('running the loop again does not move it twice', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  runner.run(env.db, env.ctx, env.membership, { trigger: 'first' });
  const afterFirst = balanceOf(env, env.brooklyn.id);

  // The scheduler fires again, and again with a different trigger.
  runner.run(env.db, env.ctx, env.membership, { trigger: 'first' });
  runner.run(env.db, env.ctx, env.membership, { trigger: 'second' });

  assert.equal(balanceOf(env, env.brooklyn.id), afterFirst, 'the same shortage is one piece of work');
  const transfers = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.equal(transfers.length, 1);
  assert.equal(
    env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'transfer'")
      .get(env.workspace.workspaceId).n,
    2,   // one transfer is two movements: out and in
    'exactly one transfer happened'
  );
});

test('approving prepared work carries it out', () => {
  const env = tights();
  balancing(env);
  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  const [waiting] = workItems.awaitingApproval(env.db, env.workspace.workspaceId);
  runner.approveWorkItem(env.db, env.ctx, env.membership, waiting.id);
  const done = runner.executeWorkItem(env.db, env.ctx, env.membership, waiting.id);

  assert.equal(done.verified, true);
  assert.equal(balanceOf(env, env.brooklyn.id), 20);
  assert.equal(workItems.get(env.db, env.workspace.workspaceId, waiting.id).approvedAt !== null, true);
});

// --- item 36: the world changes between planning and execution ---------------

test('if somebody else moves the stock first, Foundry does not go ahead', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  // Plan, but do not execute yet.
  const planned = runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });
  const [item] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.equal(item.executionStatus, 'AUTHORIZED');

  // A person does it by hand in the meantime.
  inventory.transfer(env.db, env.ctx, {
    skuId: env.black5.id,
    fromLocationId: env.jersey.id,
    toLocationId: env.brooklyn.id,
    quantity: 20,
  });
  const afterHuman = { brooklyn: balanceOf(env, env.brooklyn.id), jersey: balanceOf(env, env.jersey.id) };

  const result = runner.executeWorkItem(env.db, env.ctx, env.membership, item.id);

  assert.equal(result.executed, false, 'the shortage was already dealt with');
  assert.equal(workItems.get(env.db, env.workspace.workspaceId, item.id).executionStatus, 'CANCELLED');
  assert.equal(balanceOf(env, env.brooklyn.id), afterHuman.brooklyn, 'no second transfer');
  assert.equal(balanceOf(env, env.jersey.id), afterHuman.jersey);
});

test('a policy disabled after planning stops the work it authorised', () => {
  const env = tights();
  const policy = balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });
  const [item] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });

  policyService.disable(env.db, env.ctx, env.membership, policy.id, 'stop that');
  const result = runner.executeWorkItem(env.db, env.ctx, env.membership, item.id);

  assert.equal(result.executed, false);
  assert.equal(balanceOf(env, env.brooklyn.id), 8, 'nothing moved after the policy was withdrawn');
});

// --- item 38: verification fails ---------------------------------------------

test('a transfer that cannot be verified stops autopilot rather than retrying', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });
  const [item] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });

  // Force the check to disagree with the ledger: the balance is read again
  // after the movement, so moving more stock in between breaks the arithmetic.
  const original = repo.getBalance;
  let calls = 0;
  repo.getBalance = function patched(...args) {
    calls += 1;
    // The two reads after execution report something impossible.
    return calls > 2 ? 999 : original.apply(this, args);
  };

  let result;
  try {
    result = runner.executeWorkItem(env.db, env.ctx, env.membership, item.id);
  } finally {
    repo.getBalance = original;
  }

  assert.equal(result.verified, false);
  const after = workItems.get(env.db, env.workspace.workspaceId, item.id);
  assert.equal(after.executionStatus, 'FAILED');
  assert.equal(after.verificationStatus, 'FAILED');

  // Autopilot stopped itself for transfers, and said why.
  const state = modes.get(env.db, env.workspace.workspaceId);
  assert.equal(state.suspended, true);
  assert.equal(state.suspendedScope, 'transfer');
  assert.match(state.suspendedReason, /could not be independently verified/);
  assert.equal(state.canAutomate, false);

  // A further run does nothing while it is suspended.
  const next = runner.run(env.db, env.ctx, env.membership, { trigger: 'after' });
  assert.equal(next.executed, 0);
});

// --- item 32: restart recovery -----------------------------------------------

test('work interrupted mid-flight is reconciled, never blindly repeated', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });
  const [item] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });

  // The process dies with the item marked EXECUTING and nothing moved.
  workItems.transition(env.db, env.workspace.workspaceId, item.id, workItems.STATUS.EXECUTING, {});
  const before = balanceOf(env, env.brooklyn.id);

  const recovered = runner.recover(env.db, env.ctx, env.membership);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].executionStatus, 'BLOCKED');
  assert.match(recovered[0].errorMessage, /Interrupted before anything moved/);
  assert.equal(balanceOf(env, env.brooklyn.id), before, 'recovery must not move stock');
});

test('work that did complete before the restart is finished, not repeated', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });
  const item = result.results[0].item;
  const after = balanceOf(env, env.brooklyn.id);

  // Pretend the crash happened after the movement but before the bookkeeping.
  env.db.prepare("UPDATE work_items SET execution_status = 'VERIFYING', completed_at = NULL WHERE id = ?")
    .run(item.id);

  const recovered = runner.recover(env.db, env.ctx, env.membership);
  assert.equal(recovered[0].executionStatus, 'COMPLETED');
  assert.match(recovered[0].outcome.note, /reconciled after a restart/);
  assert.equal(balanceOf(env, env.brooklyn.id), after, 'the transfer was not done a second time');
});

// --- purchasing --------------------------------------------------------------

test('Foundry prepares purchase orders but never sends them', () => {
  const env = tights({ allStockAtBrooklyn: true });
  const suppliers = require('../../src/purchasing/supplier-service');
  const policies = require('../../src/purchasing/policy-service');
  const poService = require('../../src/purchasing/po-service');

  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Tights Supply Co', defaultLeadTimeDays: 14,
  });
  suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.black5.id, purchaseUnit: 'box', unitsPerPurchaseUnit: 10, lastUnitCost: 3.5,
  });
  policies.setPolicy(env.db, env.ctx, env.membership, env.black5.id, { reorderPoint: 200, targetStock: 260 });
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  // A configured line's replenishment is now one decision, so the order is a
  // component of a plan rather than work standing on its own. What this test
  // protects is unchanged and still asserted below: Foundry prepares, and never
  // places, an order by itself.
  const plan = workItems.list(env.db, env.workspace.workspaceId, { category: 'replenishment_plan' })[0];
  assert.ok(plan, 'the reorder condition is a replenishment decision');
  assert.equal(plan.executionStatus, 'WAITING_FOR_APPROVAL');
  assert.deepEqual(
    workItems.list(env.db, env.workspace.workspaceId, { category: 'purchase_approval' }), [],
    'and no bare "approve this order" decision appears before the plan'
  );
  assert.equal(
    env.db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, 0,
    'nothing is drafted until the plan is approved'
  );

  runner.approveWorkItem(env.db, env.ctx, env.membership, plan.id);
  const carried = runner.executeWorkItem(env.db, env.ctx, env.membership, plan.id);
  const order = poService.get(env.db, env.workspace.workspaceId, carried.purchaseOrderId);
  assert.equal(order.status, 'DRAFT', 'Foundry must never place an order by itself');
  assert.equal(order.source, 'foundry_recommendation');
  assert.ok(order.lines.length >= 1);

  const note = env.db
    .prepare("SELECT * FROM notifications WHERE workspace_id = ? AND kind = 'purchase_prepared'")
    .get(env.workspace.workspaceId);
  assert.match(note.body, /Nothing has been sent/);
});

test('an approved routine-purchasing policy lets Foundry approve a supported replenishment', () => {
  const env = tights({ allStockAtBrooklyn: true });
  const suppliers = require('../../src/purchasing/supplier-service');
  const policies = require('../../src/purchasing/policy-service');
  const poService = require('../../src/purchasing/po-service');
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, { name: 'Tights Supply Co', defaultLeadTimeDays: 14 });
  suppliers.linkItem(env.db, env.ctx, env.membership, { supplierId: supplier.id, skuId: env.black5.id,
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 3.5, isPreferred: true });
  policies.setPolicy(env.db, env.ctx, env.membership, env.black5.id, { reorderPoint: 100, targetStock: 119 });
  const policy = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Routine replenishment', allowedActionTypes: ['approve_purchase_order'], supplierScope: [supplier.id],
    maximumValue: 1000, thresholds: { maxUnitPriceChangePercent: 5 },
    conditions: [policyService.CONDITIONS.REPLENISHMENT_EVIDENCE,
      policyService.CONDITIONS.MOQ_ORDER_MULTIPLE_COMPLIANT,
      policyService.CONDITIONS.NO_DUPLICATE_INCOMING_DEMAND,
      policyService.CONDITIONS.PRICE_WITHIN_POLICY],
  });
  policyService.approve(env.db, env.ctx, env.membership, policy.id);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  runner.run(env.db, env.ctx, env.membership, { trigger: 'manager-purchasing' });
  const [prepared] = workItems.list(env.db, env.workspace.workspaceId, { category: 'purchase_preparation' });
  const order = poService.get(env.db, env.workspace.workspaceId, prepared.purchaseOrderId);
  assert.equal(order.status, 'ORDERED', JSON.stringify({ outcome: prepared.outcome,
    approvals: workItems.list(env.db, env.workspace.workspaceId, { category: 'purchase_approval' }) }));
  assert.equal(prepared.outcome.autoApproved, true);
  assert.equal(prepared.verificationStatus, 'VERIFIED');
});

test('a 17 percent supplier price increase stops routine purchasing in Needs you', () => {
  const env = tights({ allStockAtBrooklyn: true });
  const suppliers = require('../../src/purchasing/supplier-service');
  const policies = require('../../src/purchasing/policy-service');
  const poService = require('../../src/purchasing/po-service');
  const receiving = require('../../src/purchasing/receiving-service');
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, { name: 'Tights Supply Co', defaultLeadTimeDays: 14 });
  suppliers.linkItem(env.db, env.ctx, env.membership, { supplierId: supplier.id, skuId: env.black5.id,
    supplierSku: 'KT-B5', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 10, isPreferred: true });
  let previous = poService.createOrder(env.db, env.ctx, env.membership, { supplierId: supplier.id,
    lines: [{ skuId: env.black5.id, quantityUnits: 1, unitCost: 10, destinationLocationId: env.brooklyn.id }] });
  previous = poService.approve(env.db, env.ctx, env.membership, previous.id, { expectedHash: previous.integrityHash, markOrdered: true });
  receiving.receive(env.db, env.ctx, env.membership, previous.id, { idempotencyKey: 'prior-price',
    lines: previous.lines.map((line) => ({ lineId: line.id, quantityUnits: 1, locationId: env.brooklyn.id })) });
  suppliers.linkItem(env.db, env.ctx, env.membership, { supplierId: supplier.id, skuId: env.black5.id,
    supplierSku: 'KT-B5', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 11.7, isPreferred: true });
  policies.setPolicy(env.db, env.ctx, env.membership, env.black5.id, { reorderPoint: 100, targetStock: 119 });
  const policy = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Routine replenishment', allowedActionTypes: ['approve_purchase_order'], supplierScope: [supplier.id],
    maximumValue: 2000, thresholds: { maxUnitPriceChangePercent: 5 },
    conditions: [policyService.CONDITIONS.REPLENISHMENT_EVIDENCE,
      policyService.CONDITIONS.MOQ_ORDER_MULTIPLE_COMPLIANT,
      policyService.CONDITIONS.NO_DUPLICATE_INCOMING_DEMAND,
      policyService.CONDITIONS.PRICE_WITHIN_POLICY],
  });
  policyService.approve(env.db, env.ctx, env.membership, policy.id);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  runner.run(env.db, env.ctx, env.membership, { trigger: 'manager-price-exception' });
  const [decision] = workItems.list(env.db, env.workspace.workspaceId, { category: 'purchase_approval' });
  assert.ok(decision, 'the exceptional order is prepared as one human decision');
  assert.equal(decision.executionStatus, 'WAITING_FOR_APPROVAL');
  assert.match(decision.policyEvaluation.reason, /17%.*5%/);
  const order = poService.get(env.db, env.workspace.workspaceId,
    decision.purchaseOrderId || decision.recommendedAction.purchaseOrderId);
  assert.equal(order.status, 'DRAFT', 'the price exception was not approved or sent');
});

// --- quiet inventories -------------------------------------------------------

test('a healthy inventory produces no work at all', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Quiet Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = require('../helpers').makeQuantityItem(db, workspace.ctx);
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 500 });

  const result = runner.run(db, workspace.ctx, membership, { trigger: 'test' });
  assert.equal(result.planned, 0);
  assert.equal(result.executed, 0);
  assert.equal(result.awaiting, 0);
  assert.equal(result.nothingToDo, true);
});

// --- the gaps found by running it in a browser -------------------------------
//
// All three of these were only visible end to end: each is a place where the
// pieces are individually correct and the sequence is not.

test('a plan made before the policy existed is re-sized, not left blocking the day', () => {
  const env = tights();

  // The loop runs first — nothing authorises anything, so it prepares whatever
  // the numbers justify, unbounded by a ceiling that does not exist yet.
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'first' });
  const [before] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.ok(before.recommendedAction.quantity > 12, 'sized with no ceiling to respect');

  // Now the owner writes and approves a policy capping it at twelve.
  balancing(env);
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'second' });

  const after = workItems.get(env.db, env.workspace.workspaceId, before.id);
  assert.equal(after.recommendedAction.quantity, 12, 'brought within what the policy could authorise');
  assert.equal(
    workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' }).length,
    1,
    're-sized in place — a second piece of work for one shortage would be a duplicate'
  );
});

test('granting authority takes on work that was only ever waiting for it', () => {
  const env = tights();
  balancing(env);

  // Supervised: Foundry prepares and asks.
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'supervised' });
  const [prepared] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.equal(prepared.executionStatus, 'WAITING_FOR_APPROVAL');

  // The owner hands over authority. The same work now qualifies on its own.
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'automated' });

  const after = workItems.get(env.db, env.workspace.workspaceId, prepared.id);
  assert.equal(after.executionStatus, 'AUTHORIZED', 'otherwise handing over authority changed nothing');
  assert.equal(after.isAutomatic, true);
});

test('work refused for any reason other than authority stays waiting', () => {
  const env = tights();
  balancing(env);
  // The workspace-wide ceiling: no automatic actions today, whatever a policy says.
  modes.setLimits(env.db, env.ctx, env.membership, { maxActionsPerDay: 0 });
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });
  const [item] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });

  assert.equal(item.executionStatus, 'WAITING_FOR_APPROVAL');
  assert.equal(item.isAutomatic, false, 'the mode says yes, the hard limit says no, and no wins');

  // And running it does not quietly promote it either.
  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'again' });
  assert.equal(result.executed, 0);
  assert.equal(balanceOf(env, env.brooklyn.id), 8, 'nothing moved');
});

test('a person pressing "check now" is never answered with a stale plan', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  // Two presses inside the same minute. The second has to actually look.
  const first = runner.planWork(env.db, env.ctx, env.membership, { trigger: 'manual' });
  const second = runner.planWork(env.db, env.ctx, env.membership, { trigger: 'manual' });

  assert.ok(!first.replayed);
  assert.ok(!second.replayed, 'a button that silently does nothing is worse than a slow one');

  // The scheduler is still protected from firing twice.
  const scheduled = runner.planWork(env.db, env.ctx, env.membership, { trigger: 'scheduled' });
  const again = runner.planWork(env.db, env.ctx, env.membership, { trigger: 'scheduled' });
  assert.ok(!scheduled.replayed);
  assert.ok(again.replayed);

  // And looking repeatedly never produces a second piece of work.
  assert.equal(workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' }).length, 1);
});

// --- deliveries (item 14) ----------------------------------------------------

test('a delivery due today becomes work, and Foundry never books it in itself', () => {
  const env = tights();
  const supplierService = require('../../src/purchasing/supplier-service');
  const poService = require('../../src/purchasing/po-service');
  const repoLocal = require('../../src/domain/repository');

  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Sockworks', defaultLeadTimeDays: 7,
  });
  supplierService.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.black5.id, purchaseUnit: 'each',
    unitsPerPurchaseUnit: 1, leadTimeDays: 7, lastUnitCost: 2,
  });
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    destinationLocationId: env.brooklyn.id,
    expectedDate: new Date().toISOString().slice(0, 10),
    lines: [{ skuId: env.black5.id, quantityPurchaseUnits: 24 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);

  const before = repoLocal.getBalance(env.db, env.workspace.workspaceId, env.black5.id, env.brooklyn.id);
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });

  const [delivery] = workItems.list(env.db, env.workspace.workspaceId, { category: 'receiving_followup' });
  assert.ok(delivery, 'a delivery at its date is work, not a line on a list');
  assert.equal(delivery.executionStatus, 'WAITING_FOR_APPROVAL');
  assert.equal(delivery.recommendedAction.purchaseOrderId, order.id);

  // A person acknowledges it. That records the reminder as dealt with and
  // touches no stock — the units arrive through receiving, where somebody counts.
  runner.approveWorkItem(env.db, env.ctx, env.membership, delivery.id);
  const result = runner.executeWorkItem(env.db, env.ctx, env.membership, delivery.id);

  assert.equal(result.executed, false);
  assert.equal(result.acknowledged, true);
  assert.equal(
    repoLocal.getBalance(env.db, env.workspace.workspaceId, env.black5.id, env.brooklyn.id),
    before,
    'acknowledging a delivery must never create stock'
  );
});

test('the same delivery is not raised twice', () => {
  const env = tights();
  const supplierService = require('../../src/purchasing/supplier-service');
  const poService = require('../../src/purchasing/po-service');

  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Sockworks', defaultLeadTimeDays: 7,
  });
  supplierService.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.black5.id, purchaseUnit: 'each',
    unitsPerPurchaseUnit: 1, leadTimeDays: 7, lastUnitCost: 2,
  });
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    destinationLocationId: env.brooklyn.id,
    expectedDate: new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10),
    lines: [{ skuId: env.black5.id, quantityPurchaseUnits: 24 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);

  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'first' });
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'second' });

  const raised = workItems.list(env.db, env.workspace.workspaceId, { category: 'receiving_followup' });
  assert.equal(raised.length, 1, 'a late order is one piece of work, not one per check');
  assert.equal(raised[0].recommendedAction.late, true);
});
