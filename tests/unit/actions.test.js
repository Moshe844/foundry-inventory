'use strict';

/**
 * Controlled inventory actions.
 *
 * The properties that matter here are almost all negative: an action must not
 * run twice, must not run against stock that has moved underneath it, must not
 * run without the right permission, must not half-run, and must never be
 * reported as done when the resulting inventory was not verified.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const itemService = require('../../src/domain/item-service');
const authService = require('../../src/domain/auth-service');
const attention = require('../../src/attention/attention-engine');
const proposals = require('../../src/actions/proposal-service');
const execution = require('../../src/actions/execution-service');
const actionService = require('../../src/actions/action-service');
const presenter = require('../../src/actions/presenter');
const permissions = require('../../src/actions/permissions');
const policy = require('../../src/actions/policy');
const {
  makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace,
  makeQuantityItem, makeVariantItem, makeSerialItem, makeLotItem, lotsFor, unitsFor,
} = require('../helpers');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

function setup(overrides = {}) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, overrides);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

/** A variant workspace at the mission's starting numbers. */
function clothing() {
  const base = setup({ workspaceName: 'Clothing Business' });
  const item = makeVariantItem(base.db, base.ctx);
  const navy4 = item.byLabel('Navy / 4');
  const navy5 = item.byLabel('Navy / 5');
  engine.receive(base.db, base.ctx, { skuId: navy4.id, locationId: base.workspace.store.id, quantity: 4 });
  engine.receive(base.db, base.ctx, { skuId: navy4.id, locationId: base.workspace.main.id, quantity: 48 });
  engine.receive(base.db, base.ctx, { skuId: navy5.id, locationId: base.workspace.main.id, quantity: 20 });
  return { ...base, item, navy4, navy5 };
}

const intent = (over = {}) => ({
  actionType: 'transfer',
  item: "Children's Sweater",
  variant: 'Navy 4',
  lotCode: '',
  serials: [],
  sourceLocation: 'Main Warehouse',
  destinationLocation: 'Downtown Store',
  quantity: 15,
  adjustmentTarget: null,
  reasonCode: '',
  ...over,
});

function propose(env, over = {}) {
  const built = proposals.build(env.db, env.ctx, intent(over));
  assert.ok(built.ok, built.question || built.unsupported);
  return proposals.persist(env.db, env.ctx, built.proposal, { instruction: 'test' });
}

function run(env, proposal) {
  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);
  return execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
}

// --- the preview -------------------------------------------------------------

test('a transfer proposal shows real before and after figures', () => {
  const env = clothing();
  const proposal = propose(env);
  const view = presenter.present(env.db, env.workspace.workspaceId, proposal);

  assert.equal(view.subjectName, "Children's Sweater / Navy / 4");
  assert.deepEqual(
    view.rows.map((r) => [r.label, r.before, r.after]),
    [['Main Warehouse', 48, 33], ['Downtown Store', 4, 19]]
  );
  assert.deepEqual(view.total, { before: 52, after: 52 });
  assert.equal(view.totalChanges, false, 'a transfer never changes how much you have');
  assert.equal(proposal.approvalRequirement, 'CONFIRM');
  assert.ok(proposals.verifyIntegrity(proposal));
});

test('a receive proposal adds to the destination and to the total', () => {
  const env = clothing();
  const proposal = propose(env, {
    actionType: 'receive',
    sourceLocation: '',
    destinationLocation: 'Downtown Store',
    quantity: 100,
  });
  const view = presenter.present(env.db, env.workspace.workspaceId, proposal);
  assert.deepEqual(view.rows.map((r) => [r.label, r.before, r.after]), [['Downtown Store', 4, 104]]);
  assert.deepEqual(view.total, { before: 52, after: 152 });
});

// --- execution and verification ----------------------------------------------

test('an approved transfer runs through the engine and is verified', () => {
  const env = clothing();
  const proposal = propose(env);
  const result = run(env, proposal);

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 33);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 19);
  assert.equal(repo.getSkuTotal(env.db, env.workspace.workspaceId, env.navy4.id), 52, 'total unchanged');
  assert.equal(engine.verifyIntegrity(env.db, env.workspace.workspaceId).ok, true);

  // The movement ledger has it, attributed to a real person.
  const movements = env.db
    .prepare("SELECT * FROM movements WHERE workspace_id = ? AND operation = 'transfer'")
    .all(env.workspace.workspaceId);
  assert.equal(movements.length, 2, 'both legs');
  assert.equal(movements[0].group_id, movements[1].group_id);
  for (const movement of movements) assert.equal(movement.actor_user_id, env.workspace.ownerId);

  const verification = env.db
    .prepare('SELECT * FROM action_verifications WHERE execution_id = ?')
    .get(result.executionId);
  assert.equal(verification.verified, 1);
  assert.ok(JSON.parse(verification.checks).some((c) => c.label === 'Total unchanged' && c.passed));
});

test('a receive is verified against the new balance', () => {
  const env = clothing();
  const proposal = propose(env, {
    actionType: 'receive', sourceLocation: '', destinationLocation: 'Downtown Store', quantity: 100,
  });
  const result = run(env, proposal);
  assert.equal(result.verified, true);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 104);
});

test('an issue removes stock and records the reason', () => {
  const env = clothing();
  const proposal = propose(env, {
    actionType: 'issue', sourceLocation: 'Main Warehouse', destinationLocation: '', quantity: 3,
    reasonCode: 'damaged',
  });
  assert.equal(proposal.reasonCode, 'damaged');
  const result = run(env, proposal);
  assert.equal(result.verified, true);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 45);

  const movement = env.db
    .prepare("SELECT * FROM movements WHERE workspace_id = ? AND operation = 'issue'")
    .get(env.workspace.workspaceId);
  assert.equal(movement.reason_code, 'damaged');
});

test('an adjustment sets the counted balance and keeps its reason', () => {
  const env = clothing();
  const proposal = propose(env, {
    actionType: 'adjust', sourceLocation: 'Main Warehouse', destinationLocation: '',
    quantity: null, adjustmentTarget: 37, reasonCode: 'physical_count',
  });
  assert.equal(proposal.adjustmentTarget, 37);
  assert.equal(proposal.safetyLevel, 'HIGH', 'corrections are always the sensitive case');
  assert.equal(proposal.approvalRequirement, 'CONFIRM_WITH_WARNING');

  const result = run(env, proposal);
  assert.equal(result.verified, true);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 37);

  const adjustment = env.db
    .prepare('SELECT * FROM adjustments WHERE workspace_id = ?')
    .get(env.workspace.workspaceId);
  assert.equal(adjustment.expected_qty, 48);
  assert.equal(adjustment.counted_qty, 37);
  assert.equal(adjustment.reason_code, 'physical_count');
});

test('Foundry never invents a reason for a correction', () => {
  const env = clothing();
  const built = proposals.build(env.db, env.ctx, intent({
    actionType: 'adjust', sourceLocation: 'Main Warehouse', destinationLocation: '',
    quantity: null, adjustmentTarget: 37, reasonCode: '',
  }));
  assert.equal(built.ok, false);
  assert.equal(built.needsReason, true);
  assert.match(built.question, /Why is the count changing from 48 to 37/);
});

// --- serialized and lot ------------------------------------------------------

test('a serialized unit moves as itself and ends up in exactly one place', () => {
  const env = setup();
  const item = makeSerialItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, {
    skuId: item.skuId,
    locationId: env.workspace.main.id,
    serials: [{ serial: 'DL-829193' }, { serial: 'DL-829194' }],
  });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Dell Latitude', variant: '', serials: ['DL-829193'],
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store', quantity: null,
  }));
  assert.ok(built.ok, built.question);
  const proposal = proposals.persist(env.db, env.ctx, built.proposal, {});
  assert.equal(proposal.quantity, 1);

  const result = run(env, proposal);
  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));

  const units = unitsFor(env.db, env.workspace.workspaceId, item.skuId);
  const moved = units.find((u) => u.serial === 'DL-829193');
  const stayed = units.find((u) => u.serial === 'DL-829194');
  assert.equal(moved.location_id, env.workspace.store.id);
  assert.equal(stayed.location_id, env.workspace.main.id, 'the other unit did not move');
  assert.ok(result.verification.checks.some((c) => c.label === 'DL-829193 location' && c.passed));
});

test('a quantity instruction is refused for serialized stock', () => {
  const env = setup();
  const item = makeSerialItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, {
    skuId: item.skuId, locationId: env.workspace.main.id, serials: [{ serial: 'DL-1' }],
  });
  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Dell Latitude', variant: '', quantity: 1,
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store',
  }));
  assert.equal(built.ok, false);
  assert.match(built.question, /tracked by individual unit/);
});

test('a named lot moves as that lot, not as generic stock', () => {
  const env = setup();
  const item = makeLotItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, {
    skuId: item.skuId, locationId: env.workspace.main.id, quantity: 84, lotCode: 'L240812',
  });
  engine.receive(env.db, env.ctx, {
    skuId: item.skuId, locationId: env.workspace.main.id, quantity: 120, lotCode: 'L240902',
  });
  const [first, second] = lotsFor(env.db, env.workspace.workspaceId, item.skuId);

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Trail Ration Pack', variant: '', lotCode: 'L240812', quantity: 20,
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store',
  }));
  assert.ok(built.ok, built.question);
  const proposal = proposals.persist(env.db, env.ctx, built.proposal, {});
  assert.equal(proposal.lotId, first.id);

  const result = run(env, proposal);
  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));

  const lotAt = (lotId, locationId) =>
    env.db.prepare('SELECT quantity FROM lot_balances WHERE lot_id = ? AND location_id = ?').get(lotId, locationId);
  assert.equal(lotAt(first.id, env.workspace.main.id).quantity, 64);
  assert.equal(lotAt(first.id, env.workspace.store.id).quantity, 20);
  assert.equal(lotAt(second.id, env.workspace.main.id).quantity, 120, 'the other lot is untouched');
  assert.equal(lotAt(second.id, env.workspace.store.id), undefined);
});

// --- idempotency -------------------------------------------------------------

test('executing the same approved action twice moves stock once', () => {
  const env = clothing();
  const proposal = propose(env);
  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);

  const first = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
  const second = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
  const third = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId, {
    idempotencyKey: `proposal:${proposal.proposalId}`,
  });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(third.replayed, true);
  assert.equal(second.executionId, first.executionId);
  assert.deepEqual(second.after, first.after);

  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 33);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 19);
  assert.equal(
    env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'transfer'")
      .get(env.workspace.workspaceId).n,
    2,
    'one transfer, two legs — not four'
  );
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM action_executions WHERE workspace_id = ?')
      .get(env.workspace.workspaceId).n,
    1
  );
});

test('a failed execution does not block a legitimate retry', () => {
  const env = clothing();
  const proposal = propose(env, { quantity: 40 });
  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);

  // Someone empties the warehouse in between.
  engine.issue(env.db, env.ctx, {
    skuId: env.navy4.id, locationId: env.workspace.main.id, quantity: 45, reasonCode: 'sold',
  });

  assert.throws(() => execution.execute(env.db, env.ctx, env.membership, proposal.proposalId), /only 3/);
  // The claim rolled back with the failure, so nothing is stuck.
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM action_executions WHERE workspace_id = ?')
      .get(env.workspace.workspaceId).n,
    0
  );
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 3);
});

// --- staleness ---------------------------------------------------------------

test('a proposal is invalidated when the stock it was based on has moved', () => {
  const env = clothing();
  const proposal = propose(env);

  engine.issue(env.db, env.ctx, {
    skuId: env.navy4.id, locationId: env.workspace.main.id, quantity: 17, reasonCode: 'sold',
  });

  const check = proposals.revalidate(env.db, env.ctx, proposal);
  assert.equal(check.ok, false);
  assert.equal(check.changed, true);
  assert.equal(check.current.sourceOnHand, 31);

  assert.throws(
    () => execution.approve(env.db, env.ctx, env.membership, proposal.proposalId),
    (err) => err.code === 'proposal_stale'
  );
  assert.equal(proposals.get(env.db, env.workspace.workspaceId, proposal.proposalId).status, 'INVALIDATED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 31);
});

test('a proposal that would now oversell is refused, not clamped', () => {
  const env = clothing();
  const proposal = propose(env, { quantity: 40 });
  engine.issue(env.db, env.ctx, {
    skuId: env.navy4.id, locationId: env.workspace.main.id, quantity: 30, reasonCode: 'sold',
  });

  const check = proposals.revalidate(env.db, env.ctx, proposal);
  assert.equal(check.ok, false);
  assert.match(check.problems.join(' '), /only 18 available/);
});

test('an expired proposal cannot be approved', () => {
  const env = clothing();
  const proposal = propose(env);
  env.db.prepare('UPDATE action_proposals SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), proposal.proposalId);

  const stale = proposals.get(env.db, env.workspace.workspaceId, proposal.proposalId);
  assert.equal(proposals.expired(stale), true);
  assert.throws(() => execution.approve(env.db, env.ctx, env.membership, proposal.proposalId), /expired/);
});

test('a tampered proposal is refused', () => {
  const env = clothing();
  const proposal = propose(env);
  env.db.prepare('UPDATE action_proposals SET quantity = 45 WHERE id = ?').run(proposal.proposalId);

  const tampered = proposals.get(env.db, env.workspace.workspaceId, proposal.proposalId);
  assert.equal(proposals.verifyIntegrity(tampered), false);
  assert.throws(() => execution.approve(env.db, env.ctx, env.membership, proposal.proposalId), /altered/);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 48);
});

test('changing the quantity supersedes rather than edits, and needs approving again', () => {
  const env = clothing();
  const original = propose(env);
  const revised = actionService.reviseQuantity(env.db, env.ctx, env.membership, original.proposalId, 12);

  assert.notEqual(revised.proposalId, original.proposalId);
  assert.equal(revised.quantity, 12);
  assert.equal(revised.proposalVersion, 2);
  assert.equal(revised.sourceProposalId, original.proposalId);
  assert.equal(revised.status, 'AWAITING_APPROVAL', 'a new number needs a new approval');
  assert.equal(proposals.get(env.db, env.workspace.workspaceId, original.proposalId).status, 'SUPERSEDED');

  const result = run(env, revised);
  assert.equal(result.verified, true);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 16);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 36);
});

// --- warnings ----------------------------------------------------------------

test('an unusually large removal is warned about, in proportion', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 9200 });

  const built = proposals.build(env.db, env.ctx, intent({
    actionType: 'issue', item: 'Copper Elbow', variant: '', quantity: 9000,
    sourceLocation: 'Main Warehouse', destinationLocation: '', reasonCode: 'sold',
  }));
  assert.ok(built.ok);
  assert.equal(built.proposal.safetyLevel, 'HIGH');
  assert.equal(built.proposal.approvalRequirement, 'CONFIRM_WITH_WARNING');
  assert.match(built.proposal.warnings.join(' '), /97\.8% of the stock available/);
});

test('a modest movement carries no warning', () => {
  const env = clothing();
  const built = proposals.build(env.db, env.ctx, intent({ quantity: 5 }));
  assert.deepEqual(built.proposal.warnings, []);
  assert.equal(built.proposal.approvalRequirement, 'CONFIRM');
});

test('policy classifies from arithmetic, never from wording', () => {
  const modest = policy.classify({ actionType: 'transfer', quantity: 5, availableAtSource: 100 });
  const most = policy.classify({ actionType: 'transfer', quantity: 95, availableAtSource: 100 });
  assert.equal(modest.safetyLevel, 'MUTATION');
  assert.equal(most.safetyLevel, 'HIGH');
  assert.equal(policy.classify({ actionType: 'adjust', adjustmentDelta: 1, availableAtSource: 100 }).safetyLevel, 'HIGH');
  assert.equal(policy.classify({ actionType: 'add_location' }).safetyLevel, 'LOW');
});

// --- permissions -------------------------------------------------------------

test('permissions are per membership and enforced on the server', () => {
  const env = clothing();
  const staff = authService.getMembership(env.db, env.workspace.workspaceId,
    env.db.prepare('SELECT account_id FROM users WHERE id = ?').get(env.workspace.staffId).account_id);

  // An owner holds everything the product defines, including purchasing.
  assert.deepEqual(permissions.permissionsFor(env.membership), permissions.ALL);
  // Staff handle stock, and from Mission 6 can see purchasing and book in what
  // arrives — but cannot commit the business to an order.
  assert.deepEqual(permissions.permissionsFor(staff), ['VIEW', 'OPERATE', 'VIEW_PURCHASING', 'RECEIVE_PO']);
  for (const withheld of ['ADJUST', 'ADMIN', 'CREATE_PO', 'APPROVE_PO', 'MANAGE_SUPPLIERS', 'MANAGE_REPLENISHMENT']) {
    assert.equal(permissions.can(staff, withheld), false, `staff should not hold ${withheld}`);
  }

  const transfer = propose(env);
  assert.doesNotThrow(() => permissions.assertCanPerform(staff, 'transfer'));

  const correction = proposals.build(env.db, env.ctx, intent({
    actionType: 'adjust', sourceLocation: 'Main Warehouse', destinationLocation: '',
    quantity: null, adjustmentTarget: 37, reasonCode: 'physical_count',
  }));
  const stored = proposals.persist(env.db, env.ctx, correction.proposal, {});

  assert.throws(
    () => execution.approve(env.db, env.ctx, staff, stored.proposalId),
    /do not have permission to correct counts/
  );
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 48);
  assert.equal(transfer.status, 'AWAITING_APPROVAL');
});

test('a view-only member cannot make anything happen', () => {
  const env = clothing();
  const viewer = { role: 'staff', permissions: JSON.stringify(['VIEW']) };
  assert.deepEqual(permissions.permissionsFor(viewer), ['VIEW']);
  for (const action of ['receive', 'issue', 'transfer', 'adjust']) {
    assert.throws(() => permissions.assertCanPerform(viewer, action), /do not have permission/);
  }
});

test('an explicit grant adds a permission without making someone an owner', () => {
  const member = { role: 'staff', permissions: permissions.encodeGrant(['OPERATE', 'ADJUST']) };
  assert.deepEqual(permissions.permissionsFor(member).sort(), ['ADJUST', 'OPERATE', 'VIEW']);
  assert.doesNotThrow(() => permissions.assertCanPerform(member, 'adjust'));
  assert.throws(() => permissions.assertCanPerform(member, 'add_location'), /do not have permission/);
});

// --- multi-line plans --------------------------------------------------------

test('several lines run together, and all of them land', () => {
  const env = clothing();
  const built = ['Navy 4', 'Navy 5'].map((variant, index) => {
    const result = proposals.build(env.db, env.ctx, intent({ variant, quantity: index === 0 ? 10 : 8 }));
    assert.ok(result.ok, result.question);
    return result.proposal;
  });
  const plan = actionService.createPlan(env.db, env.ctx, built, { instruction: 'move both' });

  execution.approvePlan(env.db, env.ctx, env.membership, plan.planId);
  const result = execution.executePlan(env.db, env.ctx, env.membership, plan.planId);

  assert.equal(result.verified, true);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 14);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy5.id, env.workspace.store.id), 8);
});

test('a plan is all or nothing: one bad line leaves the inventory untouched', () => {
  const env = clothing();
  const built = [
    proposals.build(env.db, env.ctx, intent({ variant: 'Navy 4', quantity: 10 })).proposal,
    proposals.build(env.db, env.ctx, intent({ variant: 'Navy 5', quantity: 15 })).proposal,
  ];
  const plan = actionService.createPlan(env.db, env.ctx, built, {});
  execution.approvePlan(env.db, env.ctx, env.membership, plan.planId);

  // Navy 5 drops below what its line needs.
  engine.issue(env.db, env.ctx, {
    skuId: env.navy5.id, locationId: env.workspace.main.id, quantity: 10, reasonCode: 'sold',
  });

  assert.throws(() => execution.executePlan(env.db, env.ctx, env.membership, plan.planId));

  // The good line did not run either.
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 4);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 48);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy5.id, env.workspace.main.id), 10);
  assert.equal(engine.verifyIntegrity(env.db, env.workspace.workspaceId).ok, true);
});

test('a plan executes once, however many times it is asked', () => {
  const env = clothing();
  const built = ['Navy 4', 'Navy 5'].map(
    (variant) => proposals.build(env.db, env.ctx, intent({ variant, quantity: 5 })).proposal
  );
  const plan = actionService.createPlan(env.db, env.ctx, built, {});
  execution.approvePlan(env.db, env.ctx, env.membership, plan.planId);

  const first = execution.executePlan(env.db, env.ctx, env.membership, plan.planId);
  const second = execution.executePlan(env.db, env.ctx, env.membership, plan.planId);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 9);
});

// --- from a finding ----------------------------------------------------------

test('a location imbalance becomes a reviewable transfer', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const scenario = scenarios.imbalanceScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const finding = attention
    .listAttention(db, workspace.workspaceId)
    .find((i) => i.category === 'location_imbalance' || i.relatedCategories.includes('location_imbalance'));
  assert.ok(finding);

  const result = actionService.proposeFromAttention(db, workspace.ctx, membership, finding.attentionId);
  assert.equal(result.kind, 'proposal');
  assert.equal(result.proposal.actionType, 'transfer');
  assert.equal(result.proposal.sourceType, 'ATTENTION_ITEM');
  assert.equal(result.proposal.sourceAttentionId, finding.attentionId);
  assert.equal(result.proposal.skuId, scenario.skuId);
  assert.equal(result.proposal.quantity, finding.metrics.suggestedTransferQuantity);
  assert.equal(result.proposal.status, 'AWAITING_APPROVAL', 'reviewed, never done automatically');
});

test('a stockout offers no action, and says why', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  scenarios.stockoutScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const [finding] = attention.listAttention(db, workspace.workspaceId);

  const result = actionService.proposeFromAttention(db, workspace.ctx, membership, finding.attentionId);
  assert.equal(result.kind, 'unsupported');
  assert.match(result.message, /Replenishment ordering is not supported yet/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get().n, 0, 'nothing was fabricated');
});

test('carrying out the transfer resolves the finding it came from', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  scenarios.imbalanceScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const finding = attention
    .listAttention(db, workspace.workspaceId)
    .find((i) => i.category === 'location_imbalance' || i.relatedCategories.includes('location_imbalance'));

  const { proposal } = actionService.proposeFromAttention(db, workspace.ctx, membership, finding.attentionId);
  execution.approve(db, workspace.ctx, membership, proposal.proposalId);
  const result = execution.execute(db, workspace.ctx, membership, proposal.proposalId);
  assert.equal(result.verified, true);

  const after = attention.getAttention(db, workspace.workspaceId, finding.attentionId);
  assert.equal(after.status, 'RESOLVED', 'the condition no longer holds');
  assert.ok(after.resolutionReason);
  assert.ok(after.firstDetectedAt, 'history is kept');
});

// --- "do it" -----------------------------------------------------------------

test('“do it” resolves the one pending action', async () => {
  const env = clothing();
  const proposal = propose(env);
  const result = await actionService.interpret(env.db, env.ctx, env.membership, 'go ahead');
  assert.equal(result.kind, 'existing');
  assert.equal(result.proposal.proposalId, proposal.proposalId);
});

test('“do it” asks which one when several are pending', async () => {
  const env = clothing();
  propose(env, { variant: 'Navy 4' });
  propose(env, { variant: 'Navy 5', quantity: 5 });

  const result = await actionService.interpret(env.db, env.ctx, env.membership, 'do it');
  assert.equal(result.kind, 'question');
  assert.match(result.question, /Which one/);
  assert.equal(result.choices.length, 2);
});

test('“do it” with nothing pending says so rather than guessing', async () => {
  const env = clothing();
  const result = await actionService.interpret(env.db, env.ctx, env.membership, 'do it');
  assert.equal(result.kind, 'question');
  assert.match(result.question, /nothing waiting for approval/);
});

// --- undo --------------------------------------------------------------------

test('undo is a new movement the other way, never a deletion', () => {
  const env = clothing();
  const proposal = propose(env);
  run(env, proposal);

  const before = env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n;

  const reversal = actionService.proposeCompensation(env.db, env.ctx, env.membership, proposal.proposalId);
  assert.equal(reversal.kind, 'proposal');
  assert.equal(reversal.proposal.sourceType, 'COMPENSATION');
  assert.equal(reversal.proposal.sourceLocationId, env.workspace.store.id);
  assert.equal(reversal.proposal.destinationLocationId, env.workspace.main.id);

  run(env, reversal.proposal);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 48);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 4);

  const after = env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n;
  assert.equal(after, before + 2, 'the original movements are still there');
});

test('a correction cannot be silently undone', () => {
  const env = clothing();
  const proposal = propose(env, {
    actionType: 'adjust', sourceLocation: 'Main Warehouse', destinationLocation: '',
    quantity: null, adjustmentTarget: 37, reasonCode: 'physical_count',
  });
  run(env, proposal);

  const result = actionService.proposeCompensation(env.db, env.ctx, env.membership, proposal.proposalId);
  assert.equal(result.kind, 'unsupported');
  assert.match(result.message, /another correction, with its own reason/);
});

// --- workspace isolation -----------------------------------------------------

test('an action cannot mix records from two inventories', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'A' });
  const b = seedAnotherWorkspace(db, a.accountId, 'B');
  const membershipA = authService.getMembership(db, a.workspaceId, a.accountId);

  const itemA = makeQuantityItem(db, a.ctx, { name: 'Widget', baseCode: 'W-1' });
  engine.receive(db, a.ctx, { skuId: itemA.skuId, locationId: a.main.id, quantity: 50 });

  // B's location is invisible from A, so it simply cannot be named.
  const built = proposals.build(db, a.ctx, intent({
    item: 'Widget', variant: '', sourceLocation: 'Main Warehouse',
    destinationLocation: 'Downtown Store', quantity: 5,
  }));
  assert.ok(built.ok);
  assert.equal(built.proposal.destinationLocationId, a.store.id, "A's own store, not B's");
  assert.notEqual(built.proposal.destinationLocationId, b.store.id);
});

test('a proposal from another inventory cannot be approved or run', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'A' });
  const b = seedWorkspace(db, { workspaceName: 'B' });
  const membershipB = authService.getMembership(db, b.workspaceId, b.accountId);

  const item = makeQuantityItem(db, a.ctx, { name: 'Widget', baseCode: 'W-1' });
  engine.receive(db, a.ctx, { skuId: item.skuId, locationId: a.main.id, quantity: 50 });
  const built = proposals.build(db, a.ctx, intent({
    item: 'Widget', variant: '', sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store', quantity: 5,
  }));
  const stored = proposals.persist(db, a.ctx, built.proposal, {});

  assert.equal(proposals.get(db, b.workspaceId, stored.proposalId), null);
  assert.throws(() => execution.approve(db, b.ctx, membershipB, stored.proposalId), /could not be found/);
  assert.throws(() => execution.execute(db, b.ctx, membershipB, stored.proposalId), /could not be found/);
  assert.equal(repo.getBalance(db, a.workspaceId, item.skuId, a.main.id), 50);
});

test('an idempotency key is scoped to one inventory', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'A' });
  const b = seedAnotherWorkspace(db, a.accountId, 'B');
  const mA = authService.getMembership(db, a.workspaceId, a.accountId);
  const mB = authService.getMembership(db, b.workspaceId, b.accountId);

  for (const [workspace, membership] of [[a, mA], [b, mB]]) {
    const item = makeQuantityItem(db, workspace.ctx, { name: 'Widget', baseCode: `W-${workspace.workspaceId.slice(-4)}` });
    engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 50 });
    const built = proposals.build(db, workspace.ctx, intent({
      item: 'Widget', variant: '', sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store', quantity: 5,
    }));
    const stored = proposals.persist(db, workspace.ctx, built.proposal, {});
    execution.approve(db, workspace.ctx, membership, stored.proposalId);
    const result = execution.execute(db, workspace.ctx, membership, stored.proposalId, { idempotencyKey: 'shared-key' });
    assert.equal(result.replayed, false, 'the same key in another inventory is a different claim');
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_executions').get().n, 2);
});

// --- verification failure ----------------------------------------------------

test('an unverifiable result is never reported as done', () => {
  const env = clothing();
  const proposal = propose(env);
  const verification = require('../../src/actions/verification');
  const original = verification.verify;

  verification.verify = () => ({
    verified: false,
    checks: [{ label: 'Stock at destination', expected: 19, observed: 4, passed: false }],
    problems: ['Stock at destination: expected 19, found 4.'],
  });
  let result;
  try {
    result = run(env, proposal);
  } finally {
    verification.verify = original;
  }

  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.verified, false, 'the run happened, but the result was not confirmed');
  assert.ok(result.verification.problems.length > 0);

  const stored = env.db
    .prepare('SELECT * FROM action_verifications WHERE execution_id = ?')
    .get(result.executionId);
  assert.equal(stored.verified, 0, 'the failure is on record');

  const events = proposals.events(env.db, env.workspace.workspaceId, proposal.proposalId);
  assert.ok(events.some((e) => e.event === 'SUCCEEDED_UNVERIFIED'));
});

// --- the audit trail ---------------------------------------------------------

test('the whole story of an action is answerable afterwards', () => {
  const env = clothing();
  const proposal = propose(env);
  const result = run(env, proposal);

  const events = proposals.events(env.db, env.workspace.workspaceId, proposal.proposalId);
  assert.deepEqual(events.map((e) => e.event), ['PROPOSED', 'APPROVED', 'EXECUTING', 'SUCCEEDED']);
  for (const event of events) assert.ok(event.actorName, 'every step names who did it');

  const final = proposals.get(env.db, env.workspace.workspaceId, proposal.proposalId);
  assert.equal(final.requestedByUserId, env.workspace.ownerId);
  assert.equal(final.approvedByUserId, env.workspace.ownerId);
  assert.ok(final.approvedAt && final.completedAt);
  assert.deepEqual(final.expectedBeforeState.sourceOnHand, 48);

  const stored = events.find((e) => e.event === 'SUCCEEDED');
  assert.equal(stored.detail.after.sourceOnHand, 33);

  // And the ledger says Foundry was involved.
  const movement = env.db
    .prepare("SELECT * FROM movements WHERE workspace_id = ? AND operation = 'transfer' LIMIT 1")
    .get(env.workspace.workspaceId);
  assert.match(movement.reference, new RegExp(proposal.proposalId));
});

// --- other business shapes ---------------------------------------------------

test('a food distributor moves quantity from a named lot only', () => {
  const env = setup({ workspaceName: 'Cold Chain Foods' });
  const item = makeLotItem(env.db, env.ctx, { name: 'Chilled Yoghurt', baseCode: 'CY-1' });
  engine.receive(env.db, env.ctx, {
    skuId: item.skuId, locationId: env.workspace.main.id, quantity: 80, lotCode: 'L240812',
    expiresAt: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
  });
  engine.receive(env.db, env.ctx, {
    skuId: item.skuId, locationId: env.workspace.main.id, quantity: 50, lotCode: 'L240902',
  });
  const [older, newer] = lotsFor(env.db, env.workspace.workspaceId, item.skuId);

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Chilled Yoghurt', variant: '', lotCode: 'L240812', quantity: 30,
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store',
  }));
  assert.ok(built.ok, built.question);
  const result = run(env, proposals.persist(env.db, env.ctx, built.proposal, {}));
  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));

  const at = (lotId, locationId) =>
    (env.db.prepare('SELECT quantity FROM lot_balances WHERE lot_id = ? AND location_id = ?')
      .get(lotId, locationId) || { quantity: 0 }).quantity;
  assert.equal(at(older.id, env.workspace.main.id), 50);
  assert.equal(at(older.id, env.workspace.store.id), 30);
  assert.equal(at(newer.id, env.workspace.main.id), 50, 'the newer lot never moved');
  assert.equal(at(newer.id, env.workspace.store.id), 0);
});

test('a school moves one named laptop, and only that one', () => {
  const env = setup({ workspaceName: 'Northgate School' });
  const item = makeSerialItem(env.db, env.ctx, { name: 'Student Laptop', baseCode: 'SL-1' });
  engine.receive(env.db, env.ctx, {
    skuId: item.skuId,
    locationId: env.workspace.main.id,
    serials: [{ serial: 'NG-0001' }, { serial: 'NG-0002' }, { serial: 'NG-0003' }],
  });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Student Laptop', variant: '', serials: ['NG-0002'], quantity: null,
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store',
  }));
  const result = run(env, proposals.persist(env.db, env.ctx, built.proposal, {}));
  assert.equal(result.verified, true);

  const units = unitsFor(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(units.find((u) => u.serial === 'NG-0002').location_id, env.workspace.store.id);
  for (const serial of ['NG-0001', 'NG-0003']) {
    assert.equal(units.find((u) => u.serial === serial).location_id, env.workspace.main.id);
  }
});

test('a healthy inventory is never given an invented action', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Steady Supplies' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  scenarios.healthyScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_executions').get().n, 0);
});

// --- configuration actions ---------------------------------------------------

test('adding a location is a low-consequence action that still needs approving', () => {
  const env = setup();
  const built = proposals.build(env.db, env.ctx, {
    actionType: 'add_location', destinationLocation: 'Service Van 3', serials: [],
  });
  assert.ok(built.ok, built.question);
  assert.equal(built.proposal.safetyLevel, 'LOW');
  assert.equal(built.proposal.approvalRequirement, 'CONFIRM');
  assert.equal(built.proposal.requiredPermission, 'ADMIN');

  const proposal = proposals.persist(env.db, env.ctx, built.proposal, {});
  const result = run(env, proposal);
  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));
  assert.ok(repo.listLocations(env.db, env.workspace.workspaceId).some((l) => l.name === 'Service Van 3'));
});

test('a duplicate location is refused before it is proposed', () => {
  const env = setup();
  const built = proposals.build(env.db, env.ctx, {
    actionType: 'add_location', destinationLocation: 'Main Warehouse', serials: [],
  });
  assert.equal(built.ok, false);
  assert.match(built.unsupported, /already a location/);
});

// --- not asking what the records already answer ------------------------------

test('no quantity given means all of it, rather than a question', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Banana', baseCode: 'BAN-1' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 1 });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Banana', variant: '', quantity: null,
    sourceLocation: '', destinationLocation: 'Downtown Store',
  }));

  assert.ok(built.ok, built.question || built.unsupported);
  assert.equal(built.proposal.quantity, 1, 'there is one, so it is one');
  assert.match(built.proposal.assumptions.join(' '), /only one/);
  // Moving everything is still worth flagging, whatever the number.
  assert.equal(built.proposal.approvalRequirement, 'CONFIRM_WITH_WARNING');
  assert.match(built.proposal.warnings.join(' '), /100% of the stock/);
});

test('no quantity on a larger balance proposes all of it, and says so', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Apple', baseCode: 'APP-1' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 50 });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Apple', variant: '', quantity: null,
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store',
  }));
  assert.equal(built.proposal.quantity, 50);
  assert.match(built.proposal.assumptions.join(' '), /all 50/);

  // And it is still adjustable before anything happens.
  const stored = proposals.persist(env.db, env.ctx, built.proposal, {});
  const revised = actionService.reviseQuantity(env.db, env.ctx, env.membership, stored.proposalId, 5);
  assert.equal(revised.quantity, 5);
  assert.equal(revised.warnings.length, 0, 'five out of fifty needs no warning');
});

test('nothing to move is said plainly, not asked about', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Banana', baseCode: 'BAN-1' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.store.id, quantity: 3 });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Banana', variant: '', quantity: null,
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store',
  }));
  assert.equal(built.ok, false);
  assert.match(built.unsupported, /none at Main Warehouse to move/);
});

test('stock that exists nowhere is a statement, not a question', () => {
  const env = setup();
  makeQuantityItem(env.db, env.ctx, { name: 'Banana', baseCode: 'BAN-1' });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Banana', variant: '', quantity: null,
    sourceLocation: '', destinationLocation: 'Downtown Store',
  }));
  assert.equal(built.ok, false);
  assert.equal(built.question, null, 'there is no question they could usefully answer');
  assert.match(built.unsupported, /no Banana in stock anywhere/);
  assert.match(built.unsupported, /Receive some before moving any/);
});

test('stock in two places asks which, and says what is in each', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Cherry', baseCode: 'CHE-1' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 3 });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.store.id, quantity: 9 });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Cherry', variant: '', quantity: null,
    sourceLocation: '', destinationLocation: 'Downtown Store',
  }));
  assert.equal(built.ok, false);
  assert.match(built.question, /Main Warehouse \(3\)/);
  assert.match(built.question, /Downtown Store \(9\)/);
  assert.match(built.question, /Which should it come out of/);
});

test('a correction can start from nothing, because finding stock is real', () => {
  const env = setup();
  makeQuantityItem(env.db, env.ctx, { name: 'Banana', baseCode: 'BAN-1' });

  // Two locations: it has to ask which, but it lists them.
  const ambiguous = proposals.build(env.db, env.ctx, intent({
    actionType: 'adjust', item: 'Banana', variant: '', quantity: null,
    sourceLocation: '', destinationLocation: '', adjustmentTarget: 5, reasonCode: 'found',
  }));
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.question, /Main Warehouse/);
  assert.match(ambiguous.question, /Downtown Store/);

  // Named, it corrects up from zero without complaint.
  const built = proposals.build(env.db, env.ctx, intent({
    actionType: 'adjust', item: 'Banana', variant: '', quantity: null,
    sourceLocation: 'Main Warehouse', destinationLocation: '', adjustmentTarget: 5, reasonCode: 'found',
  }));
  assert.ok(built.ok, built.question || built.unsupported);
  assert.equal(built.proposal.adjustmentTarget, 5);
  assert.equal(built.proposal.expectedBeforeState.sourceOnHand, 0);

  const result = run(env, proposals.persist(env.db, env.ctx, built.proposal, {}));
  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));
  assert.equal(result.after.sourceOnHand, 5);
});

test('a serialized unit is never asked about — it is in exactly one place', () => {
  const env = setup();
  const item = makeSerialItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, {
    skuId: item.skuId, locationId: env.workspace.store.id, serials: [{ serial: 'DL-1' }],
  });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'Dell Latitude', variant: '', serials: ['DL-1'], quantity: null,
    sourceLocation: '', destinationLocation: 'Main Warehouse',
  }));
  assert.ok(built.ok, built.question || built.unsupported);
  assert.equal(built.proposal.sourceLocationId, env.workspace.store.id);
  assert.match(built.proposal.assumptions.join(' '), /currently at Downtown Store/);
});

test('a variant named on its own is enough to find the product', () => {
  const env = clothing();

  // "Move 15 Navy 4 to the store" names no product — the variant is the whole
  // identifier, and refusing to look it up would be pedantry.
  const built = proposals.build(env.db, env.ctx, intent({ item: '', variant: 'Navy 4' }));
  assert.ok(built.ok, built.question || built.unsupported);
  assert.equal(built.proposal.skuId, env.navy4.id);

  // Still ambiguous where it genuinely is.
  const vague = proposals.build(env.db, env.ctx, intent({ item: '', variant: 'Navy' }));
  assert.equal(vague.ok, false);
  assert.match(vague.question, /Navy \/ 4, Navy \/ 5/);
});

// --- spelling ----------------------------------------------------------------

test('case never matters, for products or locations', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Copper Elbow', baseCode: 'CE-1' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 20 });

  for (const [name, from, to] of [
    ['COPPER ELBOW', 'MAIN WAREHOUSE', 'DOWNTOWN STORE'],
    ['copper elbow', 'main warehouse', 'downtown store'],
    ['CoPPer ElBoW', 'Main WAREHOUSE', 'downtown Store'],
  ]) {
    const built = proposals.build(env.db, env.ctx, intent({
      item: name, variant: '', quantity: 2, sourceLocation: from, destinationLocation: to,
    }));
    assert.ok(built.ok, `${name}: ${built.question || built.unsupported}`);
    assert.equal(built.proposal.skuId, item.skuId);
    assert.equal(built.proposal.sourceLocationId, env.workspace.main.id);
    assert.equal(built.proposal.destinationLocationId, env.workspace.store.id);
  }
});

test('a plain typo is understood, and Foundry says what it read', () => {
  const env = setup();
  const locationService = require('../../src/domain/location-service');
  locationService.createLocation(env.db, env.ctx, { name: 'Mornoe', kind: 'store' });
  const item = makeQuantityItem(env.db, env.ctx, { name: 'banana', baseCode: 'BAN-1' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 10 });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'bannana', variant: '', quantity: 2,
    sourceLocation: '', destinationLocation: 'monroe',
  }));
  assert.ok(built.ok, built.question || built.unsupported);
  assert.equal(built.proposal.skuId, item.skuId);

  const assumptions = built.proposal.assumptions.join(' ');
  assert.match(assumptions, /You wrote “bannana” — Foundry took that as banana/);
  assert.match(assumptions, /You wrote “monroe” — Foundry took that as Mornoe/);
});

test('a near-miss between two real names is asked about, never guessed', () => {
  const env = setup();
  const locationService = require('../../src/domain/location-service');
  // Exactly one letter from each — picking either would be a coin toss with
  // somebody's stock.
  locationService.createLocation(env.db, env.ctx, { name: 'Cold Room A', kind: 'other' });
  locationService.createLocation(env.db, env.ctx, { name: 'Cold Room B', kind: 'other' });

  const result = require('../../src/actions/resolver')
    .resolveLocation(env.db, env.workspace.workspaceId, 'Cold Room C', { role: 'location' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.match(result.message, /Cold Room A/);
  assert.match(result.message, /Cold Room B/);
});

test('a word that is simply wrong is still refused, and the options listed', () => {
  const env = setup();
  makeQuantityItem(env.db, env.ctx, { name: 'Copper Elbow', baseCode: 'CE-1' });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'jetpack', variant: '', quantity: 2,
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store',
  }));
  assert.equal(built.ok, false);
  assert.match(built.question, /nothing called “jetpack”/);

  const badLocation = require('../../src/actions/resolver')
    .resolveLocation(env.db, env.workspace.workspaceId, 'Antarctica', { role: 'location' });
  assert.equal(badLocation.ok, false);
  assert.match(badLocation.message, /no location called “Antarctica”/);
  assert.match(badLocation.message, /You have Downtown Store, Main Warehouse/);
});

test('very short words are never fuzzy-matched', () => {
  const resolver = require('../../src/actions/resolver');
  // "A1" and "A2" are different bins, not a typo of each other.
  assert.equal(resolver.tolerance('A1'), 0);
  assert.equal(resolver.tolerance('bin'), 0);
  assert.equal(resolver.tolerance('store'), 1);
  assert.equal(resolver.tolerance('warehouse'), 2);

  assert.equal(
    resolver.closestMatch('A1', [{ name: 'A2' }, { name: 'A3' }], (c) => c.name).ok,
    false,
    'two characters apart is not evidence of anything'
  );
});

test('a corrected spelling still executes against the right records', () => {
  const env = setup();
  const locationService = require('../../src/domain/location-service');
  const monroe = locationService.createLocation(env.db, env.ctx, { name: 'Mornoe', kind: 'store' });
  const item = makeQuantityItem(env.db, env.ctx, { name: 'banana', baseCode: 'BAN-1' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 10 });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'bannana', variant: '', quantity: 4,
    sourceLocation: '', destinationLocation: 'monroe',
  }));
  const result = run(env, proposals.persist(env.db, env.ctx, built.proposal, {}));

  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, monroe.id), 4);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 6);
});

test('asking for more than exists is answered at once, not after approval', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx, { name: 'banana', baseCode: 'BAN-1' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 12 });

  const built = proposals.build(env.db, env.ctx, intent({
    item: 'banana', variant: '', quantity: 500,
    sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store',
  }));
  assert.equal(built.ok, false);
  assert.match(built.unsupported, /only 12 at Main Warehouse, and you asked for 500/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get().n, 0);

  // Issuing more than exists is the same answer.
  const issue = proposals.build(env.db, env.ctx, intent({
    actionType: 'issue', item: 'banana', variant: '', quantity: 20,
    sourceLocation: 'Main Warehouse', destinationLocation: '', reasonCode: 'sold',
  }));
  assert.equal(issue.ok, false);
  assert.match(issue.unsupported, /only 12 at Main Warehouse/);
});

// --- lot-tracked moves -------------------------------------------------------

/**
 * "Which batch?" is a real question only when there is more than one batch.
 *
 * The engine will not move generic stock of a lot-tracked product, and it is
 * right not to. But a person who has one batch in a room should not be asked to
 * name it, and — the case that actually bit — should never be asked *after*
 * approving, by an execution that fails.
 */
test('one batch at the source is chosen, not asked about', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const lot = makeLotItem(db, w.ctx);
  engine.receive(db, w.ctx, {
    skuId: lot.skuId, locationId: w.main.id, quantity: 40, lotCode: 'B-1', expiresAt: '2026-12-01',
  });

  const built = proposals.build(db, w.ctx, {
    actionType: 'transfer',
    item: 'Trail Ration Pack',
    sourceLocation: '',
    destinationLocation: w.store.name,
    quantity: 10,
  });

  assert.ok(built.ok, JSON.stringify(built));
  assert.ok(built.proposal.lotId, 'the only batch should have been chosen');
  assert.match(built.proposal.assumptions.join(' '), /B-1 is the only batch at Main Warehouse/);
});

test('two batches at the source is a question, with the codes', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const lot = makeLotItem(db, w.ctx);
  engine.receive(db, w.ctx, { skuId: lot.skuId, locationId: w.main.id, quantity: 40, lotCode: 'B-1' });
  engine.receive(db, w.ctx, { skuId: lot.skuId, locationId: w.main.id, quantity: 25, lotCode: 'B-2' });

  const built = proposals.build(db, w.ctx, {
    actionType: 'transfer',
    item: 'Trail Ration Pack',
    sourceLocation: w.main.name,
    destinationLocation: w.store.name,
    quantity: 10,
  });

  assert.equal(built.ok, false);
  assert.match(built.question, /Which batch/);
  assert.match(built.question, /B-1 \(40\)/);
  assert.match(built.question, /B-2 \(25\)/);
});

test('a lot-tracked transfer Foundry proposed actually executes', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const lot = makeLotItem(db, w.ctx);
  engine.receive(db, w.ctx, { skuId: lot.skuId, locationId: w.main.id, quantity: 40, lotCode: 'B-1' });

  const built = proposals.build(db, w.ctx, {
    actionType: 'transfer',
    item: 'Trail Ration Pack',
    sourceLocation: '',
    destinationLocation: w.store.name,
    quantity: 10,
  });
  const saved = proposals.persist(db, w.ctx, built.proposal, {});
  execution.approve(db, w.ctx, membership, saved.proposalId);
  const done = execution.execute(db, w.ctx, membership, saved.proposalId);

  assert.equal(done.status, 'SUCCEEDED', done.errorMessage || '');
  assert.equal(repo.getBalance(db, w.workspaceId, lot.skuId, w.store.id), 10);
  assert.equal(repo.getBalance(db, w.workspaceId, lot.skuId, w.main.id), 30);
});
