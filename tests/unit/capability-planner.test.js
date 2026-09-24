'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const registry = require('../../src/manager/capability-registry');
const planner = require('../../src/manager/capability-planner');
const intentRouter = require('../../src/manager/intent-router');
const authService = require('../../src/domain/auth-service');
const operating = require('../../src/manager/operating-instructions');

test.after(cleanupAll);

function planResponse(overrides = {}) {
  return {
    capabilityId: 'catalog.transform-internal-codes', intentClass: 'CATALOG_CHANGE',
    confidence: 'high', goal: 'Change the TS internal-code prefix to ME.',
    reason: 'This changes customer-owned identifiers, not supplier mappings.',
    resolvedReference: '', clarifyingQuestion: '',
    parameters: { fromText: 'TS', toText: 'ME', transformMode: 'prefix', documentReference: '' },
    ...overrides,
  };
}

test('the capability registry is one stable list of business operations, not sentence handlers', () => {
  const entries = registry.list();
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  for (const id of [
    'inventory.record-movement', 'catalog.transform-internal-codes',
    'catalog.remove-imported-records', 'purchasing.manage', 'rules.manage',
    'events.record-physical-fact', 'inventory.investigate', 'data.import-file',
  ]) assert.ok(registry.get(id), `${id} must be registered`);
  assert.ok(entries.every((entry) => entry.handler && entry.safety));
});

test('the planner chooses a typed capability from real workspace context', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Capability Co' });
  makeQuantityItem(db, workspace.ctx, { name: 'Travel Mug', baseCode: 'TS-100' });
  const provider = fakeProvider(planResponse());

  const result = await planner.plan(db, workspace.ctx,
    'Standardize our catalogue: anything starting TS should start ME instead.', { provider });

  assert.equal(result.capabilityId, 'catalog.transform-internal-codes');
  assert.equal(result.handler, 'catalog_code_change');
  assert.deepEqual(result.parameters, {
    fromText: 'TS', toText: 'ME', transformMode: 'prefix', documentReference: '',
  });
  assert.match(provider.calls[0].system, /Choose by meaning, not by matching example wording/);
  assert.match(provider.calls[0].prompt, /Travel Mug/);
  assert.match(provider.calls[0].prompt, /TS-100/);
  db.close();
});

test('an unfamiliar paraphrase is planned by capability instead of needing another regex patch', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Paraphrase Co' });
  const wording = 'Standardize our catalogue: anything starting TS should start ME instead.';
  assert.equal(intentRouter.fallbackClassify(wording).intentClass, 'UNKNOWN',
    'this wording is deliberately outside the offline sentence grammar');

  const result = await intentRouter.classify(db, workspace.ctx, wording, {
    provider: fakeProvider(planResponse()),
  });
  assert.equal(result.capabilityId, 'catalog.transform-internal-codes');
  assert.equal(result.handler, 'catalog_code_change');
  assert.equal(result.intentClass, 'CATALOG_CHANGE');
  const stored = JSON.parse(db.prepare('SELECT payload FROM manager_intents WHERE id = ?').get(result.id).payload);
  assert.equal(stored.capabilityId, result.capabilityId);
  assert.deepEqual(stored.parameters, result.parameters);
  db.close();
});

test('the capability planner receives approved teachings but no unapproved preview', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Teaching Context Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const change = {
    domain: 'workflow_preference', operation: 'set', itemText: '', variantText: '', locationText: '',
    sourceLocationText: '', supplierText: '', reorderPoint: -1, targetStock: -1, safetyStock: -1,
    locationMinimum: -1, locationTarget: -1, leadTimeDays: -1, unitsPerPurchaseUnit: -1,
    minimumOrderQuantity: -1, orderMultiple: -1, maximumQuantity: -1, maximumValue: -1,
    cooldownHours: -1, daysOfStock: -1, purchaseUnit: '', contactName: '', email: '', orderingMethod: '',
    preferTransferBeforePurchasing: false, approvalRequired: true, guardAction: '', guardMode: '',
    guardMetric: '', guardComparator: '', guardThreshold: -1, guardReleaseCondition: '',
    guardReleaseThreshold: -1, workflowScope: 'reporting',
    preferenceText: 'Lead weekly reports with exceptions, then supporting detail.',
  };
  const ruleProvider = fakeProvider({ understood: true, summary: 'Reporting order', changes: [change], clarifyingQuestion: '', unsupportedReason: '' });
  const proposal = await operating.interpret(db, workspace.ctx, membership,
    'Lead weekly reports with exceptions, then supporting detail.', { provider: ruleProvider });

  const before = planner.workspaceSnapshot(db, workspace.ctx);
  assert.deepEqual(before.approvedTeachings, []);
  operating.approve(db, workspace.ctx, membership, proposal.id, proposal.integrityHash);

  const after = planner.workspaceSnapshot(db, workspace.ctx);
  assert.equal(after.approvedTeachings.length, 1);
  assert.match(after.approvedTeachings[0].effect, /exceptions, then supporting detail/i);
  assert.equal(after.approvedTeachings[0].grantsAuthority, false);
  db.close();
});

test('lasting-preference wording routes to the teach-once capability offline', () => {
  for (const wording of [
    'Remember that customer orders should show pickup first.',
    'From now on, lead weekly reports with exceptions.',
    'I prefer supplier emails to be concise.',
  ]) {
    assert.equal(intentRouter.fallbackClassify(wording).intentClass, 'OPERATING_INSTRUCTION', wording);
  }
});

test('explicit teaching language cannot be overridden by a wrong capability plan', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Teaching Route Co' });
  const wrongPlan = fakeProvider(planResponse({
    capabilityId: 'inventory.record-movement', intentClass: 'INVENTORY_ACTION',
    goal: 'Change inventory', reason: 'wrong on purpose',
  }));

  const result = await intentRouter.classify(db, workspace.ctx,
    'Remember that supplier emails should be concise.', { provider: wrongPlan });

  assert.equal(result.intentClass, 'OPERATING_INSTRUCTION');
  assert.equal(result.handler, 'operating_instruction');
  assert.equal(wrongPlan.calls.length, 0, 'the explicit teach-once boundary is deterministic');
  db.close();
});
