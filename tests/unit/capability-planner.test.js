'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const registry = require('../../src/manager/capability-registry');
const planner = require('../../src/manager/capability-planner');
const intentRouter = require('../../src/manager/intent-router');

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

