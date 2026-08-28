'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const modes = require('../../src/autopilot/modes');
const planner = require('../../src/autopilot/planner');
const policyService = require('../../src/autopilot/policy-service');
const runner = require('../../src/autopilot/runner');
const signalEngine = require('../../src/signals/signal-engine');
const workItems = require('../../src/autopilot/work-items');
const { makeDatabase, cleanupAll } = require('../helpers');
const {
  seedAuthorityWorkspace,
  approveTransferPolicy,
  balanceAt,
} = require('../helpers/autopilot-authority-fixture');

test.after(cleanupAll);

function scenario(requiredQuantity = 5) {
  const { db } = makeDatabase();
  return seedAuthorityWorkspace(db, { requiredQuantity });
}

function enableRunIt(env) {
  return modes.setMode(env.db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
}

test('authority E2E 1: Run it plus an approved five-unit policy executes a qualifying five-unit transfer', () => {
  const env = scenario(5);
  const policy = approveTransferPolicy(env, { maximumQuantity: 5 });
  enableRunIt(env);
  const before = { source: balanceAt(env, env.source.id), destination: balanceAt(env, env.destination.id) };

  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'authority-e2e-1', now: env.now });

  assert.equal(result.executed, 1);
  assert.equal(balanceAt(env, env.source.id), before.source - 5);
  assert.equal(balanceAt(env, env.destination.id), before.destination + 5);
  const [done] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.equal(done.executionStatus, workItems.STATUS.COMPLETED);
  assert.equal(done.policyId, policy.id);
  assert.equal(done.policyEvaluation.policyVersion, 1);
  assert.equal(done.verificationStatus, 'VERIFIED');
});

test('authority E2E 2: a real eight-unit need is not shrunk to a five-unit policy and goes to Needs you', () => {
  const env = scenario(8);
  approveTransferPolicy(env, { maximumQuantity: 5 });
  enableRunIt(env);
  const before = { source: balanceAt(env, env.source.id), destination: balanceAt(env, env.destination.id) };

  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'authority-e2e-2', now: env.now });

  assert.equal(result.executed, 0);
  assert.equal(result.awaiting, 1);
  assert.deepEqual({ source: balanceAt(env, env.source.id), destination: balanceAt(env, env.destination.id) }, before);
  const [waiting] = workItems.awaitingApproval(env.db, env.workspace.workspaceId);
  assert.equal(waiting.recommendedAction.quantity, 8, 'the evaluator sees the full need');
  assert.equal(waiting.policyEvaluation.decision, 'refused');
  assert.match(waiting.policyEvaluation.reason, /at most 5 units.*this is 8/i);
});

test('authority E2E 3: Run it without a matching policy prepares the real transfer for approval', () => {
  const env = scenario(5);
  enableRunIt(env);

  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'authority-e2e-3', now: env.now });

  assert.equal(result.executed, 0);
  assert.equal(result.awaiting, 1);
  const [waiting] = workItems.awaitingApproval(env.db, env.workspace.workspaceId);
  assert.equal(waiting.recommendedAction.quantity, 5);
  assert.equal(waiting.policyId, null);
  assert.match(waiting.policyEvaluation.reason, /No policy authorises/i);
});

test('authority E2E 4: an approved policy in Prepare my work mode still waits', () => {
  const env = scenario(5);
  approveTransferPolicy(env, { maximumQuantity: 5 });
  modes.setMode(env.db, env.ctx, env.membership, modes.MODES.SUPERVISED);

  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'authority-e2e-4', now: env.now });

  assert.equal(result.executed, 0);
  assert.equal(result.awaiting, 1);
  const [waiting] = workItems.awaitingApproval(env.db, env.workspace.workspaceId);
  assert.match(waiting.policyEvaluation.reason, /supervised/i);
  assert.equal(balanceAt(env, env.destination.id), 4);
});

test('authority E2E 5: Pause prevents every automatic execution', () => {
  const env = scenario(5);
  approveTransferPolicy(env, { maximumQuantity: 5 });
  enableRunIt(env);
  modes.pause(env.db, env.ctx, env.membership, 'QA kill-switch proof');

  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'authority-e2e-5', now: env.now });

  assert.equal(result.executed, 0);
  assert.equal(balanceAt(env, env.destination.id), 4);
  assert.equal(modes.get(env.db, env.workspace.workspaceId).paused, true);
});

test('authority E2E 6: Resume in Run it mode promotes and executes eligible waiting work', () => {
  const env = scenario(5);
  approveTransferPolicy(env, { maximumQuantity: 5 });
  enableRunIt(env);
  modes.pause(env.db, env.ctx, env.membership, 'QA pause before resume');
  runner.run(env.db, env.ctx, env.membership, { trigger: 'authority-e2e-6-paused', now: env.now });

  modes.resume(env.db, env.ctx, env.membership);
  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'authority-e2e-6-resumed', now: env.now });

  assert.equal(result.executed, 1);
  assert.equal(balanceAt(env, env.destination.id), 9);
  const [done] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.equal(done.executionStatus, workItems.STATUS.COMPLETED);
});

test('authority E2E 7: an automatic action records the exact policy version and fresh dated evidence used', () => {
  const env = scenario(5);
  const first = approveTransferPolicy(env, { maximumQuantity: 4, name: 'Transfer boundary' });
  const revised = policyService.revise(env.db, env.ctx, env.membership, first.id, { maximumQuantity: 5 });
  const active = policyService.approve(env.db, env.ctx, env.membership, revised.id);
  enableRunIt(env);

  const [measured] = signalEngine.skuSignals(env.db, env.workspace.workspaceId, {
    skuIds: [env.sku.id], now: env.now,
  });
  const expected = planner.planBalanceTransfer(env.db, env.workspace.workspaceId, measured);
  const result = runner.run(env.db, env.ctx, env.membership, { trigger: 'authority-e2e-7', now: env.now });

  assert.equal(result.executed, 1);
  const [done] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.equal(done.policyId, active.id);
  assert.equal(done.policyEvaluation.policyId, active.id);
  assert.equal(done.policyEvaluation.policyVersion, 2);
  assert.deepEqual(done.sourceEvidence, expected.evidence);
  assert.ok(done.sourceEvidence.some((fact) => fact.label === 'Main Warehouse issued (30 days)' && fact.value === 14));
  const evaluations = env.db.prepare(
    'SELECT policy_id, policy_version, decision FROM policy_evaluations WHERE workspace_id = ? AND work_item_id = ? ORDER BY rowid'
  ).all(env.workspace.workspaceId, done.id);
  assert.ok(evaluations.some((row) => row.policy_id === active.id && row.policy_version === 2 && row.decision === 'authorized'));
  assert.ok(workItems.eventsFor(env.db, env.workspace.workspaceId, done.id)
    .some((event) => event.event === 'authority_rechecked' && event.detail.policyVersion === 2));
});
