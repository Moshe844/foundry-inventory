'use strict';

/**
 * Mission 7: the clock.
 *
 * The scheduler is the only part of Foundry that acts without a person present,
 * so these tests are almost entirely about what it declines to do: not acting
 * for a paused inventory, not acting under an authority nobody granted, not
 * acting twice, and not letting one broken workspace stop the rest.
 *
 * It decides nothing itself — it calls the same runner the button calls — so
 * there is deliberately no test here that a transfer is sized correctly. That
 * belongs to the loop, and duplicating it here would suggest the clock has an
 * opinion about inventory. It does not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../../src/autopilot/scheduler');
const modes = require('../../src/autopilot/modes');
const policyService = require('../../src/autopilot/policy-service');
const workItems = require('../../src/autopilot/work-items');
const authService = require('../../src/domain/auth-service');
const workspaceService = require('../../src/domain/workspace-service');
const itemService = require('../../src/domain/item-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;

/** The kids-tights shortage, in a workspace the scheduler will find. */
function tights(overrides = {}) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Kids Tights', ...overrides });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);

  const created = itemService.createItem(db, workspace.ctx, {
    name: 'Kids Tights',
    baseCode: 'KT-100',
    trackingMode: 'quantity',
    hasVariants: true,
    options: [{ name: 'Colour', values: 'Black, White' }, { name: 'Size', values: '2, 5, 8' }],
  });
  const skus = repo.listSkusForItem(db, workspace.workspaceId, created.itemId);
  const black5 = skus.find((sku) => sku.variant_label === 'Black / 5');

  inventory.receive(db, workspace.ctx, { skuId: black5.id, locationId: workspace.main.id, quantity: 29 });
  inventory.receive(db, workspace.ctx, { skuId: black5.id, locationId: workspace.store.id, quantity: 65 });

  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const backdate = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  const issue = (locationId, quantity, daysAgo) => {
    const result = inventory.issue(db, workspace.ctx, { skuId: black5.id, locationId, quantity, reasonCode: 'sold' });
    for (const id of result.movementIds) backdate.run(new Date(Date.now() - daysAgo * DAY).toISOString(), id);
  };
  for (const [q, d] of [[5, 28], [4, 22], [3, 16], [4, 10], [5, 4]]) issue(workspace.main.id, q, d);
  issue(workspace.store.id, 4, 12);
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );

  return { db, workspace, membership, ctx: workspace.ctx, black5 };
}

function balancing(env) {
  const policy = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Automatic Warehouse Balancing',
    allowedActionTypes: ['transfer'],
    locationScope: [env.workspace.main.id, env.workspace.store.id],
    conditions: [policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK, policyService.CONDITIONS.SOURCE_ABOVE_SAFETY],
    maximumQuantity: 12,
  });
  return policyService.approve(env.db, env.ctx, env.membership, policy.id);
}

const balanceOf = (env, locationId) => repo.getBalance(env.db, env.workspace.workspaceId, env.black5.id, locationId);

// --- the point of it ---------------------------------------------------------

test('nobody presses anything and the work still happens', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  const before = balanceOf(env, env.workspace.main.id);
  const result = scheduler.tick(env.db, { trigger: 'scheduled' });

  assert.equal(result.executed, 1);
  assert.equal(balanceOf(env, env.workspace.main.id), before + 12);
});

test('a scheduled action is carried out under the authority of whoever approved the policy', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  scheduler.tick(env.db, { trigger: 'scheduled' });

  const movement = env.db
    .prepare('SELECT actor_user_id FROM movements WHERE sku_id = ? ORDER BY seq DESC LIMIT 1')
    .get(env.black5.id);

  assert.equal(
    movement.actor_user_id,
    env.membership.id,
    'the movement belongs to the person who granted the permission, not to nobody'
  );
});

test('the next check is a real time, so the page can say when', () => {
  const env = tights();
  const now = Date.parse('2026-08-16T10:00:00.000Z');
  scheduler.tick(env.db, { now, intervalMs: 15 * 60 * 1000 });

  const state = modes.get(env.db, env.workspace.workspaceId);
  assert.equal(state.lastEvaluatedAt !== null, true);
  assert.equal(state.nextEvaluationAt, '2026-08-16T10:15:00.000Z');
});

// --- what it declines to do --------------------------------------------------

test('a paused inventory is looked at but never touched', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  modes.pause(env.db, env.ctx, env.membership, 'going on holiday');

  const before = balanceOf(env, env.workspace.main.id);
  const [result] = scheduler.tick(env.db, { trigger: 'scheduled' }).results;

  assert.equal(result.readOnly, true);
  assert.equal(result.because, 'paused');
  assert.equal(balanceOf(env, env.workspace.main.id), before, 'a timer must not defeat the kill switch');
  assert.equal(workItems.list(env.db, env.workspace.workspaceId).length, 0, 'and it plans nothing either');
});

test('an inventory that stopped itself is not restarted by the clock', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  modes.suspend(env.db, env.workspace.workspaceId, {
    scope: 'transfer',
    reason: 'the last transfer could not be verified',
  });

  const before = balanceOf(env, env.workspace.main.id);
  const [result] = scheduler.tick(env.db, { trigger: 'scheduled' }).results;

  assert.equal(result.readOnly, true);
  assert.equal(result.because, 'stopped itself');
  assert.equal(balanceOf(env, env.workspace.main.id), before);
});

test('a watching inventory gets its findings refreshed and nothing else', () => {
  const env = tights();
  modes.setMode(env.db, env.ctx, env.membership, 'OBSERVE');

  const [result] = scheduler.tick(env.db, { trigger: 'scheduled' }).results;

  assert.equal(result.readOnly, true);
  assert.equal(result.because, 'watching only');
  assert.equal(workItems.list(env.db, env.workspace.workspaceId).length, 0);
});

test('with no policy approved there is no authority, so it prepares and stops', () => {
  const env = tights();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  assert.equal(scheduler.authorityFor(env.db, env.workspace.workspaceId), null);

  const before = balanceOf(env, env.workspace.main.id);
  const [result] = scheduler.tick(env.db, { trigger: 'scheduled' }).results;

  assert.equal(result.plannedOnly, true);
  assert.equal(result.because, 'no approved policy');
  assert.equal(result.planned, 1, 'the work is still prepared for a person');
  assert.equal(balanceOf(env, env.workspace.main.id), before);
});

test('a policy whose approver has left the inventory authorises nothing', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  // A second owner, so the approver is allowed to leave at all.
  authService.createTeamMember(env.db, env.ctx, env.membership, {
    name: 'Sam Reyes',
    email: 'sam@kidstights.test',
    password: 'kids-tights-2026',
    role: 'owner',
  });
  workspaceService.leaveWorkspace(env.db, env.workspace.workspaceId, env.workspace.accountId);

  // Their signature is still on the policy and their membership row still
  // exists for the ledger. Neither is authority any more.
  assert.equal(scheduler.authorityFor(env.db, env.workspace.workspaceId), null);

  const before = balanceOf(env, env.workspace.main.id);
  const [result] = scheduler.tick(env.db, { trigger: 'scheduled' }).results;
  assert.equal(result.plannedOnly, true);
  assert.equal(balanceOf(env, env.workspace.main.id), before, 'nothing runs in a departed person\u2019s name');
});

test('ticking repeatedly does not do the work twice', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  scheduler.tick(env.db, { trigger: 'scheduled' });
  const after = balanceOf(env, env.workspace.main.id);
  scheduler.tick(env.db, { trigger: 'scheduled' });
  scheduler.tick(env.db, { trigger: 'scheduled' });

  assert.equal(balanceOf(env, env.workspace.main.id), after);
  assert.equal(workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' }).length, 1);
});

test('one broken workspace does not stop the sweep', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  // A second workspace with stock, arranged so that running it throws. What is
  // being tested is the sweep, not the fault: whatever goes wrong in one
  // inventory, the others still get their turn.
  const other = seedWorkspace(env.db, { workspaceName: 'Broken Co', email: 'broken@example.test' });
  const otherItem = itemService.createItem(env.db, other.ctx, {
    name: 'Widget', baseCode: 'W-1', trackingMode: 'quantity',
  });
  const [otherSku] = repo.listSkusForItem(env.db, other.workspaceId, otherItem.itemId);
  inventory.receive(env.db, other.ctx, { skuId: otherSku.id, locationId: other.main.id, quantity: 5 });

  const runner = require('../../src/autopilot/runner');
  const realPlanWork = runner.planWork;
  runner.planWork = (db, ctx, membership, options) => {
    if (ctx.workspaceId === other.workspaceId) throw new Error('this inventory is broken');
    return realPlanWork(db, ctx, membership, options);
  };

  try {
    const result = scheduler.tick(env.db, { trigger: 'scheduled' });

    assert.equal(result.workspaces, 2, 'both were attempted');
    assert.equal(result.failed, 1);
    assert.equal(result.executed, 1, 'and the healthy one still had its work done');
    assert.match(result.results.find((r) => r.failed).error, /broken/);
  } finally {
    runner.planWork = realPlanWork;
  }
});

test('only one process runs the loop at a time', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  const first = scheduler.tick(env.db, { trigger: 'scheduled' });
  assert.ok(!first.skipped);

  // Somebody else takes the lease before the next turn comes round.
  env.db
    .prepare('UPDATE autopilot_lease SET holder = ?, expires_at = ? WHERE id = ?')
    .run('another-server', Date.now() + 60000, 'autopilot');

  const second = scheduler.tick(env.db, { trigger: 'scheduled' });
  assert.equal(second.skipped, true);
  assert.match(second.because, /another process/);
});

test('workspaces with nothing in them are not swept at all', () => {
  const { db } = makeDatabase();
  seedWorkspace(db, { workspaceName: 'Empty Co' });

  assert.deepEqual(scheduler.activeWorkspaces(db), [], 'no stock, nothing to think about');
  assert.equal(scheduler.tick(db, { trigger: 'scheduled' }).workspaces, 0);
});
