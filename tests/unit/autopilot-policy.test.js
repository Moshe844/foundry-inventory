'use strict';

/**
 * Mission 7: the gate every autonomous action has to pass.
 *
 * These are the tests that decide whether it is safe to let Foundry act
 * unattended. Almost none of them are about it doing the right thing — they are
 * about it declining: when it is paused, when nothing authorises it, when the
 * quantity is over the limit, when it moved the same stock yesterday, when the
 * move would undo one it just made, and when two policies are arguing.
 *
 * No AI provider is involved anywhere in this file, and none may ever be: the
 * verdict has to be identical every time or unattended execution is a gamble.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const modes = require('../../src/autopilot/modes');
const policyService = require('../../src/autopilot/policy-service');
const engine = require('../../src/autopilot/policy-engine');
const workItems = require('../../src/autopilot/work-items');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const { newId, nowIso } = require('../../src/lib/util');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Autopilot Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx);
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 60 });
  return { db, workspace, membership, ctx: workspace.ctx, item };
}

/** An approved warehouse-balancing policy, as the customer would have it. */
function balancingPolicy(env, overrides = {}) {
  const policy = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Automatic Warehouse Balancing',
    description: 'Move stock between our own warehouses when one is about to run out.',
    allowedActionTypes: ['transfer'],
    locationScope: [env.workspace.main.id, env.workspace.store.id],
    conditions: [policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK, policyService.CONDITIONS.SOURCE_ABOVE_SAFETY],
    maximumQuantity: 12,
    ...overrides,
  });
  return policyService.approve(env.db, env.ctx, env.membership, policy.id);
}

/** A transfer that satisfies every condition. */
function goodPlan(env, overrides = {}) {
  return {
    actionType: 'transfer',
    skuId: env.item.skuId,
    itemId: env.item.itemId,
    quantity: 12,
    fromLocationId: env.workspace.main.id,
    toLocationId: env.workspace.store.id,
    conditions: {
      destination_stockout_risk: { passed: true, detail: '8 left, 21 issued in 30 days' },
      source_above_safety: { passed: true, detail: '61 left, 4 issued in 30 days' },
    },
    ...overrides,
  };
}

/** Records a completed automatic action, the way the executor will. */
function recordCompleted(env, { skuId, from, to, quantity = 12, at = Date.now() }) {
  env.db
    .prepare(
      `INSERT INTO work_items (
         id, workspace_id, category, source, affected_entities, recommended_action,
         approval_requirement, execution_status, verification_status, idempotency_key,
         created_at, completed_at
       ) VALUES (?, ?, 'balance_transfer', 'test', ?, ?, 'NONE', 'COMPLETED', 'VERIFIED', ?, ?, ?)`
    )
    .run(
      newId('wi'),
      env.workspace.workspaceId,
      JSON.stringify({ skuId }),
      JSON.stringify({ actionType: 'transfer', fromLocationId: from, toLocationId: to, quantity }),
      newId('key'),
      new Date(at).toISOString(),
      new Date(at).toISOString()
    );
}

// --- modes -------------------------------------------------------------------

test('a workspace starts supervised, and says what that means', () => {
  const env = setup();
  const state = modes.ensure(env.db, env.workspace.workspaceId);

  assert.equal(state.mode, 'SUPERVISED');
  assert.equal(state.canAct, true);
  assert.equal(state.canAutomate, false, 'supervised prepares work; it does not act on its own');
  assert.match(state.modeBlurb, /carries out what you approve/);
});

test('gaining authority needs an owner; giving it up does not', () => {
  const env = setup();
  const staff = { role: 'staff' };

  assert.throws(
    () => modes.setMode(env.db, env.ctx, staff, 'POLICY_AUTOMATED'),
    /permission/,
    'staff must not be able to switch autonomy on'
  );
  // …but anyone who can operate the inventory can turn it down.
  assert.equal(modes.setMode(env.db, env.ctx, staff, 'OBSERVE').mode, 'OBSERVE');
  assert.equal(modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED').mode, 'POLICY_AUTOMATED');
});

test('pausing stops autonomous work and says who did it', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);

  modes.pause(env.db, env.ctx, env.membership, 'Stock take this weekend');
  const paused = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(paused.decision, 'refused');
  assert.match(paused.reason, /Stock take this weekend/);

  modes.resume(env.db, env.ctx, env.membership);
  assert.equal(engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env)).decision, 'authorized');
});

test('a safety suspension is not cleared by an ordinary resume', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);

  modes.suspend(env.db, env.workspace.workspaceId, {
    scope: 'transfer',
    reason: 'The last transfer could not be independently verified.',
  });

  const refused = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(refused.decision, 'refused');
  assert.match(refused.reason, /could not be independently verified/);

  // Staff cannot wave it away, because they did not cause it and cannot judge it.
  assert.throws(() => modes.resume(env.db, env.ctx, { role: 'staff' }), /permission/);
  modes.clearSuspension(env.db, env.ctx, env.membership);
  assert.equal(engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env)).decision, 'authorized');

  // And it told somebody.
  const note = env.db
    .prepare("SELECT * FROM notifications WHERE workspace_id = ? AND kind = 'paused'")
    .get(env.workspace.workspaceId);
  assert.ok(note, 'stopping itself has to be visible');
  assert.equal(note.severity, 'critical');
});

// --- policies ----------------------------------------------------------------

test('a policy with no ceiling is refused as a policy at all', () => {
  const env = setup();
  assert.throws(
    () => policyService.propose(env.db, env.ctx, env.membership, {
      name: 'Do what you like', allowedActionTypes: ['transfer'],
    }),
    /A policy without a limit is not a limit/
  );
});

test('a policy cannot authorise an action Foundry will not automate', () => {
  const env = setup();
  for (const action of ['adjust', 'issue', 'receive', 'purchase']) {
    assert.throws(
      () => policyService.propose(env.db, env.ctx, env.membership, {
        name: 'Too much', allowedActionTypes: [action], maximumQuantity: 5,
      }),
      /only be trusted with transfers/,
      `${action} must not be automatable in Mission 7`
    );
  }
});

test('a policy does nothing until it is approved', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  const policy = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Automatic Warehouse Balancing',
    allowedActionTypes: ['transfer'],
    maximumQuantity: 12,
  });

  assert.equal(policy.isActive, false);
  const before = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(before.decision, 'needs_approval');
  assert.match(before.reason, /No policy authorises/);

  policyService.approve(env.db, env.ctx, env.membership, policy.id);
  assert.equal(engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env)).decision, 'authorized');
});

test('approving something that changed since you read it is refused', () => {
  const env = setup();
  const policy = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Balancing', allowedActionTypes: ['transfer'], maximumQuantity: 12,
  });
  assert.throws(
    () => policyService.approve(env.db, env.ctx, env.membership, policy.id, { expectedHash: 'not-the-hash' }),
    /changed since you looked at it/
  );
});

test('revising a policy creates a new version and retires the old one', () => {
  const env = setup();
  const first = balancingPolicy(env);
  const second = policyService.revise(env.db, env.ctx, env.membership, first.id, { maximumQuantity: 30 });

  assert.equal(second.version, 2);
  assert.equal(second.supersedesPolicyId, first.id);
  assert.equal(second.isActive, false, 'a wider policy must be approved before it does anything');

  // Until it is approved the old limit still governs.
  assert.equal(engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env, { quantity: 30 })).decision, 'refused');

  policyService.approve(env.db, env.ctx, env.membership, second.id);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  assert.equal(engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env, { quantity: 30 })).decision, 'authorized');
  assert.equal(policyService.get(env.db, env.workspace.workspaceId, first.id).isActive, false);
});

test('"stop doing that" disables the policy and nothing more runs under it', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  const policy = balancingPolicy(env);
  assert.equal(engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env)).decision, 'authorized');

  policyService.disable(env.db, env.ctx, env.membership, policy.id, 'Not while we are counting');
  const after = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(after.decision, 'needs_approval');
  assert.match(after.reason, /No policy authorises/);
});

// --- the gate ----------------------------------------------------------------

test('supervised mode prepares the work rather than doing it', () => {
  const env = setup();
  balancingPolicy(env);   // approved, but the workspace is only supervised

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'needs_approval');
  assert.match(verdict.reason, /supervised/);
});

test('an authorised transfer shows every check it passed', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'authorized');
  const names = verdict.checks.filter((c) => c.passed).map((c) => c.name);
  for (const required of [
    'Foundry is able to act',
    'Policy is in force',
    'Within the policy quantity limit',
    'Within the daily budget',
    'Cooldown has elapsed',
    'Not a reversal of a recent move',
  ]) {
    assert.ok(names.includes(required), `missing check: ${required}`);
  }
});

test('over the policy limit is refused, and says by how much', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env, { quantity: 13 }));
  assert.equal(verdict.decision, 'refused');
  assert.match(verdict.reason, /at most 12 units in one go; this is 13/);
});

test('a location outside the policy is refused', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);
  const elsewhere = require('../../src/domain/location-service').createLocation(env.db, env.ctx, {
    name: 'Third Site', kind: 'warehouse',
  });

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env, { toLocationId: elsewhere.id }));
  assert.equal(verdict.decision, 'refused');
  assert.match(verdict.reason, /does not cover both of those locations/);
});

test('a condition that is false, or unmeasured, refuses the action', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);

  const failed = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env, {
    conditions: {
      destination_stockout_risk: { passed: false, detail: '40 left' },
      source_above_safety: { passed: true },
    },
  }));
  assert.equal(failed.decision, 'refused');
  assert.match(failed.reason, /destination is measurably at risk/);

  // Silence is not consent: an unmeasured condition is a refusal, not a pass.
  const unmeasured = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env, { conditions: {} }));
  assert.equal(unmeasured.decision, 'refused');
  assert.match(unmeasured.reason, /could not measure/);
});

// --- loops -------------------------------------------------------------------

test('the same product is not moved twice inside the cooldown', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);
  recordCompleted(env, {
    skuId: env.item.skuId, from: env.workspace.main.id, to: env.workspace.store.id, at: Date.now() - 2 * HOUR,
  });

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'refused');
  assert.match(verdict.reason, /moved this product 2 hours ago/);
});

test('stock is never bounced straight back where it came from', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);
  // Moved store → main two days ago; the cooldown has passed, but reversing it
  // is the signature of a threshold sitting on the usual balance.
  recordCompleted(env, {
    skuId: env.item.skuId, from: env.workspace.store.id, to: env.workspace.main.id, at: Date.now() - 2 * DAY,
  });

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'refused');
  assert.match(verdict.reason, /straight back where it came from/);
});

test('a product that keeps needing moving stops being moved automatically', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);
  // Two moves the same way this week, both outside the cooldown.
  for (const daysAgo of [5, 3]) {
    recordCompleted(env, {
      skuId: env.item.skuId, from: env.workspace.main.id, to: env.workspace.store.id,
      at: Date.now() - daysAgo * DAY,
    });
  }

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'refused');
  assert.match(verdict.reason, /already moved this product 2 times this week/);
  assert.match(verdict.reason, /Something else is going on here/);
});

test('the daily budget is a hard stop', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);
  modes.setLimits(env.db, env.ctx, env.membership, { maxActionsPerDay: 2, cooldownHours: 0, maxActionsPerItemPerWeek: 50 });

  for (let i = 0; i < 2; i += 1) {
    recordCompleted(env, {
      skuId: newId('sku'), from: env.workspace.main.id, to: env.workspace.store.id, at: Date.now() - HOUR,
    });
  }

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'refused');
  assert.match(verdict.reason, /already taken its 2 automatic actions for today/);
});

// --- conflicting policies ----------------------------------------------------

test('policies that cannot both be satisfied are surfaced, not fought over', () => {
  const env = setup();
  const first = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Keep Brooklyn stocked',
    allowedActionTypes: ['transfer'],
    maximumQuantity: 12,
    thresholds: { minimumByLocation: { [env.workspace.main.id]: 20 } },
  });
  policyService.approve(env.db, env.ctx, env.membership, first.id);
  const second = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Keep New Jersey stocked',
    allowedActionTypes: ['transfer'],
    maximumQuantity: 12,
    thresholds: { minimumByLocation: { [env.workspace.store.id]: 50 } },
  });
  policyService.approve(env.db, env.ctx, env.membership, second.id);

  const conflict = engine.detectConflicts(env.db, env.workspace.workspaceId, env.item.skuId, { totalOnHand: 60 });
  assert.ok(conflict, 'two floors totalling 70 cannot both be met from 60 units');
  assert.equal(conflict.required, 70);
  assert.match(conflict.message, /decide which matters more/);

  // With enough stock there is no conflict to report.
  assert.equal(engine.detectConflicts(env.db, env.workspace.workspaceId, env.item.skuId, { totalOnHand: 90 }), null);
});

// --- isolation ---------------------------------------------------------------

test('autonomy is per inventory: a policy here authorises nothing there', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  balancingPolicy(env);

  const other = seedAnotherWorkspace(env.db, env.workspace.accountId, 'Separate Co');
  const otherItem = makeQuantityItem(env.db, other.ctx);

  // The other inventory has no policy and its own mode.
  assert.equal(policyService.list(env.db, other.workspaceId).length, 0);
  const verdict = engine.evaluate(env.db, other.workspaceId, {
    actionType: 'transfer',
    skuId: otherItem.skuId,
    quantity: 5,
    fromLocationId: other.main.id,
    toLocationId: other.store.id,
    conditions: {},
  });
  assert.equal(verdict.decision, 'needs_approval');

  // Pausing one does not pause the other.
  modes.pause(env.db, env.ctx, env.membership, 'counting');
  assert.equal(modes.get(env.db, other.workspaceId).paused, false);
  assert.equal(modes.get(env.db, env.workspace.workspaceId).paused, true);
});

// --- the value budget --------------------------------------------------------
//
// These limits were stored and settable long before anything read them. A limit
// the engine never consults is worse than no limit: the customer believes they
// set a ceiling, and there isn't one.

test('a single action over the value ceiling is refused', () => {
  const env = setup();
  balancingPolicy(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  modes.setLimits(env.db, env.ctx, env.membership, { maxValuePerAction: 100 });

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, { ...goodPlan(env), value: 150 });
  assert.equal(verdict.decision, 'refused');
  assert.match(verdict.reason, /100 of value/);
});

test('the daily value budget counts what has already been spent', () => {
  const env = setup();
  balancingPolicy(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  modes.setLimits(env.db, env.ctx, env.membership, { maxValuePerDay: 100 });

  // 60 already committed automatically today.
  const spent = workItems.upsert(env.db, env.workspace.workspaceId, {
    category: 'balance_transfer',
    recommendedAction: { actionType: 'transfer', quantity: 1 },
    approvalRequirement: 'NONE',
    executionStatus: workItems.STATUS.AUTHORIZED,
    idempotencyKey: 'spent-today',
  }).item;
  workItems.transition(env.db, env.workspace.workspaceId, spent.id, workItems.STATUS.COMPLETED, {
    outcome: { value: 60 },
    completedAt: nowIso(),
  });

  // 30 more fits; 50 more does not.
  assert.equal(engine.evaluate(env.db, env.workspace.workspaceId, { ...goodPlan(env), value: 30 }).decision, 'authorized');

  const over = engine.evaluate(env.db, env.workspace.workspaceId, { ...goodPlan(env), value: 50 });
  assert.equal(over.decision, 'refused');
  assert.match(over.reason, /60 of its 100 daily value budget/);
});

test('an action with no known value does not silently consume the budget', () => {
  const env = setup();
  balancingPolicy(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  modes.setLimits(env.db, env.ctx, env.membership, { maxValuePerDay: 100 });

  // No value on the plan: transfers between own locations rarely have one.
  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'authorized', 'an unpriced move is not charged against a money budget');
  assert.ok(!verdict.checks.some((c) => c.name === 'Within the daily value budget'));
});

test('an inventory really kept in another system is never written to automatically', () => {
  const env = setup();
  const paths = require('../../src/onboarding/paths');
  balancingPolicy(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  // Everything else about this workspace says go.
  assert.equal(engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env)).decision, 'authorized');

  // Set directly. Onboarding refuses this mode without a genuinely connected
  // connector, and the registry is empty, so today no supported path reaches
  // this state — which is exactly why the gate is checked here too rather than
  // assumed. A guard that only holds while another layer is correct is not one.
  env.db
    .prepare('UPDATE workspaces SET source_of_truth_mode = ? WHERE id = ?')
    .run(paths.SOURCE_OF_TRUTH.EXTERNAL_CONNECTED, env.workspace.workspaceId);

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'needs_approval');
  assert.match(verdict.reason, /kept in another system/);
  assert.ok(
    verdict.checks.some((c) => c.name === 'These records are the ones that count' && !c.passed),
    'and it says which check stopped it'
  );
});

// --- migrated inventory (item 24) --------------------------------------------
//
// A migration fills a workspace in minutes with numbers that came from a
// spreadsheet. Acting on them straight away means acting on somebody else's
// figures before Foundry has watched a single thing happen.

/**
 * Marks this workspace's stock as having arrived from an import, followed by
 * `movementsSince` days of real trading starting `tradingDaysAgo` ago.
 *
 * The order matters: opening balances land first, then the business operates.
 */
function asMigrated(env, { movementsSince = 0, tradingDaysAgo = 0 } = {}) {
  env.db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  env.db
    .prepare("UPDATE movements SET notes = 'Initial inventory import', occurred_at = ? WHERE workspace_id = ?")
    .run(new Date(Date.now() - (tradingDaysAgo + 5) * DAY).toISOString(), env.workspace.workspaceId);

  for (let i = 0; i < movementsSince; i += 1) {
    inventory.issue(env.db, env.ctx, {
      skuId: env.item.skuId,
      locationId: env.workspace.main.id,
      quantity: 1,
      reasonCode: 'sold',
    });
  }
  env.db
    .prepare("UPDATE movements SET occurred_at = ? WHERE notes IS NOT 'Initial inventory import' AND workspace_id = ?")
    .run(new Date(Date.now() - tradingDaysAgo * DAY).toISOString(), env.workspace.workspaceId);
}

test('a freshly migrated inventory is prepared for, never acted on', () => {
  const env = setup();
  balancingPolicy(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  asMigrated(env, { movementsSince: 1, tradingDaysAgo: 1 });

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'needs_approval');
  assert.match(verdict.reason, /has not been operated here long enough/);
  assert.ok(
    verdict.checks.some((c) => c.name === 'This inventory has been operated, not just loaded' && !c.passed)
  );
});

test('once it has been traded for a fortnight, the migration stops mattering', () => {
  const env = setup();
  balancingPolicy(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  asMigrated(env, { movementsSince: 6, tradingDaysAgo: 20 });

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'authorized');
});

test('an inventory that never imported anything needs no settling period', () => {
  const env = setup();
  balancingPolicy(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  const verdict = engine.evaluate(env.db, env.workspace.workspaceId, goodPlan(env));
  assert.equal(verdict.decision, 'authorized', 'every movement here was Foundry\u2019s own from the start');
});
