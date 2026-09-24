'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDatabase, seedWorkspace, cleanupAll } = require('../helpers');
const fixture = require('../helpers/autonomy-entry-fixture');
const authority = require('../../src/autopilot/authority-proposal');
const daily = require('../../src/autopilot/daily');
const policies = require('../../src/autopilot/policy-service');
const engine = require('../../src/autopilot/policy-engine');
const work = require('../../src/autopilot/work-items');
const orders = require('../../src/purchasing/po-service');
const misses = require('../../src/manager/misses');
test.after(cleanupAll);

test('own-data proposals do not invent suppliers or money, and confirmation grants only the bounded purchasing job', () => {
  const { db } = makeDatabase();
  const empty = seedWorkspace(db);
  assert.equal(authority.propose(db, empty.workspaceId).available, false);
  const env = fixture.seed(db);
  const proposal = authority.propose(db, env.workspace.workspaceId);
  assert.equal(proposal.maximumValue, 200);
  assert.equal(proposal.maximumValuePerWeek, 200);
  assert.equal(proposal.evidence.length, 3);
  assert.deepEqual(proposal.itemScope, [env.item.skuId]);
  assert.equal(policies.list(db, env.workspace.workspaceId, { activeOnly: true }).length, 0);
  assert.throws(() => authority.approve(db, env.workspace.ctx, env.membership, 'stale'), /records or authority changed/);
  authority.approve(db, env.workspace.ctx, env.membership, proposal.integrityHash);
  const approved = policies.list(db, env.workspace.workspaceId, { activeOnly: true });
  assert.equal(approved.length, 1);
  assert.equal(approved[0].thresholds.maxValuePerWeek, 200);
  assert.deepEqual(approved[0].supplierScope, [env.supplier.id]);
  assert.deepEqual(approved[0].itemScope, [env.item.skuId]);
  assert.equal(require('../../src/autopilot/capabilities').granted(db, env.workspace.workspaceId, 'supplier_emails'), false);
  assert.throws(() => authority.approve(db, env.workspace.ctx, env.membership, proposal.integrityHash), /records or authority changed/);
});

test('unknown prices, different currencies and over-budget automatic purchases fail closed', () => {
  const { db } = makeDatabase();
  const env = fixture.seed(db);
  const proposal = authority.propose(db, env.workspace.workspaceId);
  authority.approve(db, env.workspace.ctx, env.membership, proposal.integrityHash);
  const policy = policies.list(db, env.workspace.workspaceId, { activeOnly: true })[0];
  const plan = { actionType: 'approve_purchase_order', supplierId: env.supplier.id, skuId: env.item.skuId,
    quantity: 2, value: 201, currency: 'USD', conditions: {} };
  const limits = require('../../src/autopilot/modes').limits(db, env.workspace.workspaceId);
  assert.match(engine.evaluateAgainstPolicy(db, env.workspace.workspaceId, plan, policy, limits, Date.now()).reason, /seven-day budget/);
  for (const value of [null, undefined, NaN, Infinity, 0]) {
    assert.match(engine.evaluateAgainstPolicy(db, env.workspace.workspaceId, { ...plan, value }, policy, limits, Date.now()).reason, /unknown/);
  }
  assert.match(engine.evaluateAgainstPolicy(db, env.workspace.workspaceId, { ...plan, value: 20, currency: 'EUR' }, policy, limits, Date.now()).reason, /currency/);
  assert.throws(() => policies.validate(db, env.workspace.workspaceId, { ...policy, thresholds: { maxValuePerWeek: -1 } }), /positive/);
});

test('batch approvals reject changed business documents and foreign inventories before approving any selection', () => {
  const { db } = makeDatabase();
  const env = fixture.seed(db);
  const choices = daily.report(db, env.workspace.workspaceId).waiting.slice(0, 2);
  const selections = choices.map((item) => ({ id: item.id, hash: item.approvalHash }));
  db.prepare('UPDATE purchase_orders SET integrity_hash = ? WHERE id = ?').run('changed-document', choices[1].purchaseOrderId);
  assert.throws(() => daily.approveBatch(db, env.workspace.ctx, env.membership, selections), /Nothing in this batch/);
  assert.equal(work.get(db, env.workspace.workspaceId, choices[0].id).executionStatus, 'WAITING_FOR_APPROVAL');
  assert.throws(() => daily.approveBatch(db, env.workspace.ctx, env.membership, [selections[0], selections[0]]), /distinct/);
  const other = seedWorkspace(db);
  assert.throws(() => daily.approveBatch(db, other.ctx, { role: 'owner' }, selections), /not in this inventory/);
});

test('five UI-equivalent manual PO approvals execute real orders, make one unapproved policy suggestion and cannot replay', () => {
  const { db } = makeDatabase();
  const env = fixture.seed(db);
  const selections = daily.report(db, env.workspace.workspaceId).waiting.slice(0, 5).map((item) => ({ id: item.id, hash: item.approvalHash }));
  const results = daily.approveBatch(db, env.workspace.ctx, env.membership, selections);
  assert.equal(results.filter((item) => item.done).length, 5);
  for (const selection of selections) assert.equal(orders.get(db, env.workspace.workspaceId, work.get(db, env.workspace.workspaceId, selection.id).purchaseOrderId).status, 'ORDERED');
  const suggestions = require('../../src/manager/operating-instructions').list(db, env.workspace.workspaceId, { status: 'PENDING' }).filter((item) => item.source === 'repeated_approval_suggestion');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].resolvedChanges[0].currency, 'USD');
  assert.deepEqual(suggestions[0].resolvedChanges[0].itemScope, [env.item.skuId]);
  assert.equal(policies.list(db, env.workspace.workspaceId, { activeOnly: true }).length, 0);
  assert.throws(() => daily.approveBatch(db, env.workspace.ctx, env.membership, selections), /Nothing in this batch/);
});

test('missing decision references remain visible without breaking the digest or approving any part of a batch', () => {
  const { db } = makeDatabase();
  const env = fixture.seed(db);
  const choices = daily.report(db, env.workspace.workspaceId).waiting.slice(0, 2);
  const selections = choices.map((item) => ({ id: item.id, hash: item.approvalHash }));
  db.prepare('UPDATE work_items SET recommended_action = ? WHERE id = ?').run(JSON.stringify({ purchaseOrderId: 'missing-purchase-record' }), choices[1].id);
  db.prepare('UPDATE work_items SET purchase_order_id = NULL WHERE id = ?').run(choices[1].id);
  const invalid = daily.report(db, env.workspace.workspaceId).waiting.find((item) => item.id === choices[1].id);
  assert.equal(invalid.approvalHash, null);
  assert.match(invalid.approvalBlockedReason, /missing or invalid/);
  assert.throws(() => daily.approveBatch(db, env.workspace.ctx, env.membership, selections));
  assert.equal(work.get(db, env.workspace.workspaceId, choices[0].id).executionStatus, 'WAITING_FOR_APPROVAL');
});

test('digest calendar dates separate Saturday completions from Sunday and pending work is not completed', () => {
  const { db } = makeDatabase();
  const env = fixture.seed(db);
  assert.equal(daily.report(db, env.workspace.workspaceId, env.saturday).completed.length, 1);
  assert.equal(daily.report(db, env.workspace.workspaceId, env.sunday).completed.length, 0);
  assert.equal(daily.report(db, env.workspace.workspaceId, env.saturday).waiting.length, 6);
  assert.throws(() => daily.report(db, env.workspace.workspaceId, '2026-02-30'), /valid calendar/);
  assert.equal(daily.generate(db, env.workspace.workspaceId).created, true);
  assert.equal(daily.generate(db, env.workspace.workspaceId).created, false);
  assert.equal(daily.history(db, env.workspace.workspaceId).length, 1);
  assert.equal(daily.history(db, env.workspace.workspaceId)[0].summary.waiting, 6);
});

test('miss reports keep actual and expected behavior, require review authority, and never claim a fix', () => {
  const { db } = makeDatabase();
  const env = fixture.seed(db);
  const id = misses.report(db, env.workspace.ctx, env.membership, { question: 'Which products sold most last month?', actualBehavior: 'Ignored the month', expectedBehavior: 'Use the requested month and cite actual sales' });
  assert.equal(misses.list(db, env.workspace.ctx, env.membership)[0].status, 'OPEN');
  assert.equal(misses.list(db, { workspaceId: env.workspace.workspaceId, actorId: env.workspace.staffId }, { role: 'staff' }).length, 0);
  assert.throws(() => misses.review(db, env.workspace.ctx, { role: 'staff' }, id, 'Fix date handling'), /permission|allowed/i);
  misses.review(db, env.workspace.ctx, env.membership, id, 'Add a dated sales grounding regression before closing.');
  assert.equal(misses.list(db, env.workspace.ctx, env.membership)[0].status, 'REVIEWED');
  assert.equal(policies.list(db, env.workspace.workspaceId).length, 0);
});

test('connected authority proposes actual mailbox recipients and recorded label prices, while old POs cannot be automatically resent', async () => {
  const { db } = makeDatabase();
  const env = fixture.seed(db);
  fixture.seedConnectedAuthority(db, env);
  const proposal = authority.propose(db, env.workspace.workspaceId);
  assert.equal(proposal.email[0].recipient, 'supplier@example.test');
  assert.equal(proposal.shipping[0].maximumValueMinor, 700);
  authority.approve(db, env.workspace.ctx, env.membership, proposal.integrityHash);
  const operations = require('../../src/autonomous/service');
  assert.equal(operations.activeGrant(db, env.workspace.workspaceId, 'shipping.purchase_label').currency, 'USD');
  assert.equal(require('../../src/shipping/operation-policy').get(db, env.workspace.workspaceId).mode, 'AUTOMATIC');
  const messages = require('../../src/purchasing/supplier-communications');
  const order = env.historical[0];
  const message = messages.forOrder(db, env.workspace.workspaceId, order.id)[0];
  const operation = operations.create(db, env.workspace.ctx, { operationType: 'supplier.communicate', idempotencyKey: 'old-initial-PO',
    decision: { supplierId: env.supplier.id, purchaseOrderId: order.id, communicationId: message.id },
    authorityDimensions: { supplierId: env.supplier.id, valueMinor: 10000, currency: 'USD', confidence: 'high', risk: 'high' } });
  const result = await operations.run(db, env.workspace.ctx, env.membership, operation.id);
  assert.equal(result.operation.status, 'NEEDS_HUMAN');
  assert.equal(result.authority.checks.find((check) => check.name === 'initialOrderAge').passed, false);
  assert.notEqual(messages.get(db, env.workspace.workspaceId, message.id).status, 'SENT');
});

test('domain adapters cannot bypass an explicit monetary/currency grant or a revoked grant', async () => {
  const { db } = makeDatabase();
  const env = fixture.seed(db);
  const operations = require('../../src/autonomous/service');
  require('../../src/autopilot/modes').setMode(db, env.workspace.ctx, env.membership, 'POLICY_AUTOMATED');
  let executed = 0;
  operations.registerAdapter('shipping.track', { authorize: () => ({ allowed: true, checks: [{ name: 'domain', passed: true }] }),
    execute: () => { executed += 1; return {}; }, verify: () => ({ passed: true }) });
  operations.grant(db, env.workspace.ctx, env.membership, 'shipping.track', { maximumValueMinor: 700, currency: 'USD' });
  for (const [index, value, currency] of [[0, 701, 'USD'], [1, 100, 'EUR'], [2, null, 'USD']]) {
    const operation = operations.create(db, env.workspace.ctx, { operationType: 'shipping.track', idempotencyKey: `invalid-bound-${index}`,
      authorityDimensions: { valueMinor: value, currency } });
    assert.equal((await operations.run(db, env.workspace.ctx, env.membership, operation.id)).operation.status, 'NEEDS_HUMAN');
  }
  operations.revoke(db, env.workspace.ctx, env.membership, 'shipping.track');
  const revoked = operations.create(db, env.workspace.ctx, { operationType: 'shipping.track', idempotencyKey: 'revoked-bound', authorityDimensions: { valueMinor: 100, currency: 'USD' } });
  assert.equal((await operations.run(db, env.workspace.ctx, env.membership, revoked.id)).operation.status, 'NEEDS_HUMAN');
  assert.equal(executed, 0);
});
