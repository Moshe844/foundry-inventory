'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeDatabase, makeApp, seedWorkspace, cleanupAll, signIn, plain } = require('../helpers');
const modes = require('../../src/autopilot/modes');
const catalog = require('../../src/autonomous/catalog');
const operations = require('../../src/autonomous/service');
const overview = require('../../src/autonomous/overview');
const needsYou = require('../../src/manager/needs-you-inbox');
const adapterCoverage = require('../../src/autonomous/domain-adapters');
const connections = require('../../src/connections/service');
const authService = require('../../src/domain/auth-service');
const ingestion = require('../../src/connections/event-ingestion');

test.after(cleanupAll);
const owner = { role:'owner' };

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName:'Universal operator' });
  modes.setMode(db, workspace.ctx, owner, modes.MODES.POLICY_AUTOMATED);
  return { db, workspace };
}

test('the operation catalog is closed and every new operation starts automatic-off', () => {
  const { db, workspace } = setup();
  assert.throws(() => operations.create(db, workspace.ctx, {
    operationType:'model.invented_action', idempotencyKey:'bad:1', title:'Bad',
  }), /Unknown autonomous operation type/);
  const operation = operations.create(db, workspace.ctx, {
    operationType:'transfer.request', idempotencyKey:'transfer:1', title:'Balance two stores',
  });
  assert.equal(operation.automatic, false);
  assert.equal(operations.activeGrant(db, workspace.workspaceId, 'transfer.request'), null);
  assert.ok(catalog.DEFINITIONS.every((definition) => definition.defaultsToAutomatic === false));
});

test('every operation enabled for autonomous execution has a domain-owned adapter', () => {
  const coverage = adapterCoverage.load();
  assert.ok(coverage.required.length >= 10, 'all currently autonomous domains participate');
  assert.deepEqual(coverage.required.filter((type) => !coverage.registered.includes(type)), []);
  assert.ok(catalog.DEFINITIONS.every((definition) => !definition.autonomousNow
    || definition.adapterModule), 'the canonical catalog declares the owner; there is no second coverage list');
});

test('a real provider event runs through authorize, execute and verify exactly once', () => {
  const { db, workspace } = setup();
  const membership = authService.getMembership(db, workspace.workspaceId,
    workspace.accountId);
  const connection = connections.create(db, workspace.ctx, membership,
    { providerType:'reference_webhook', displayName:'Contract test POS' });
  const auth = connections.authenticate(db, `Bearer ${connection.token}`);
  const first = ingestion.ingest(db, auth,
    { eventId:'catalog-change-1', type:'product.changed', data:{ externalId:'p-1' } });
  const replay = ingestion.ingest(db, auth,
    { eventId:'catalog-change-1', type:'product.changed', data:{ externalId:'p-1' } });
  assert.equal(first.accepted, true);
  assert.equal(replay.replayed, true);
  const operation = operations.list(db, workspace.workspaceId)
    .find((entry) => entry.operationType === 'integration.process_event');
  assert.equal(operation.status, 'COMPLETED');
  assert.equal(operation.attemptCount, 1);
  const phases = db.prepare(`SELECT phase FROM autonomous_operation_events
    WHERE operation_id = ? ORDER BY rowid`).all(operation.id).map((row) => row.phase);
  assert.ok(phases.includes('EXECUTE'));
  assert.ok(phases.includes('VERIFY'));
  assert.ok(phases.includes('DONE'));
});

test('quantity, value, supplier, customer, location, confidence, risk, role and daily bounds are deterministic', () => {
  const { db, workspace } = setup();
  operations.grant(db, workspace.ctx, owner, 'transfer.request', {
    maximumQuantity:20, maximumValueMinor:50000, maximumDailyCount:2,
    supplierIds:['supplier-1'], customerIds:['customer-1'], locationIds:['location-1'],
    allowedRoles:['owner'], minimumConfidence:'high', maximumRisk:'medium',
  });
  const operation = operations.create(db, workspace.ctx, {
    operationType:'transfer.request', idempotencyKey:'bounded:1',
    authorityDimensions:{ quantity:12, valueMinor:25000, supplierId:'supplier-1',
      customerId:'customer-1', locationId:'location-1', confidence:'high', risk:'medium' },
  });
  assert.equal(operations.evaluateAuthority(db, workspace.workspaceId, operation, { membership:owner }).allowed, true);
  for (const [key, value] of [['quantity',21], ['valueMinor',50001], ['supplierId','wrong'],
    ['customerId','wrong'], ['locationId','wrong'], ['confidence','low'], ['risk','high']]) {
    const changed = { ...operation, authorityDimensions:{ ...operation.authorityDimensions, [key]:value } };
    assert.equal(operations.evaluateAuthority(db, workspace.workspaceId, changed, { membership:owner }).allowed, false, key);
  }
  assert.equal(operations.evaluateAuthority(db, workspace.workspaceId, operation, { membership:{ role:'staff' } }).allowed, false);
});

test('revoked authority takes effect before execution and produces one useful intervention', async () => {
  const { db, workspace } = setup();
  let executions = 0;
  operations.registerAdapter('inventory.create_item', {
    execute:async () => { executions += 1; return { created:true }; },
    verify:async () => ({ passed:true }),
  });
  operations.grant(db, workspace.ctx, owner, 'inventory.create_item', { maximumQuantity:1 });
  const operation = operations.create(db, workspace.ctx, { operationType:'inventory.create_item',
    idempotencyKey:'item:1', authorityDimensions:{ quantity:1, confidence:'high', risk:'low' } });
  operations.revoke(db, workspace.ctx, owner, 'inventory.create_item');
  const result = await operations.run(db, workspace.ctx, owner, operation.id);
  assert.equal(result.operation.status, 'NEEDS_HUMAN');
  assert.equal(executions, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM autonomous_operation_interventions WHERE operation_id = ?').get(operation.id).n, 1);
});

test('a verification failure suspends its domain and retry never repeats a persisted effect', async () => {
  const { db, workspace } = setup();
  let executions = 0; let verified = false;
  operations.registerAdapter('inventory.receive', {
    execute:async () => { executions += 1; return { receiptId:'receipt-1' }; },
    verify:async () => verified ? { passed:true, reason:'Receipt exists once.' } : { passed:false, reason:'Receipt is not visible.' },
  });
  operations.grant(db, workspace.ctx, owner, 'inventory.receive', { maximumQuantity:10 });
  const operation = operations.create(db, workspace.ctx, { operationType:'inventory.receive',
    idempotencyKey:'receipt:1', authorityDimensions:{ quantity:5, confidence:'high', risk:'medium' },
    expectedOutcome:{ onHandIncrease:5 } });
  const failed = await operations.run(db, workspace.ctx, owner, operation.id);
  assert.equal(failed.operation.status, 'NEEDS_HUMAN');
  assert.equal(modes.get(db, workspace.workspaceId).suspendedScope, 'inventory');
  assert.equal(needsYou.fromAutonomousOperations(db, workspace.workspaceId).length, 1,
    'one stopped operation becomes one human decision');
  // Simulate an operator confirming the delayed read model, then clear only the safety stop.
  modes.clearSuspension(db, workspace.ctx, owner); verified = true;
  const recovered = await operations.run(db, workspace.ctx, owner, operation.id);
  assert.equal(recovered.operation.status, 'COMPLETED');
  assert.equal(executions, 1, 'the domain mutation is not repeated');
  assert.deepEqual(recovered.operation.actualOutcome, { receiptId:'receipt-1' });
  assert.equal(needsYou.fromAutonomousOperations(db, workspace.workspaceId).length, 0,
    'verified recovery clears the decision everywhere');
});

test('a domain-owned recovery is verified before the operation is called complete', async () => {
  const { db, workspace } = setup();
  let executions = 0; let recoveries = 0; let fixed = false;
  operations.registerAdapter('shipping.track', {
    execute:async () => { executions += 1; return { shipmentId:'shipment-1' }; },
    verify:async () => fixed ? { passed:true, reason:'Carrier state is current.' } : { passed:false, reason:'Carrier state lagged.' },
    recover:async () => { recoveries += 1; fixed = true; return { refreshed:true }; },
  });
  operations.grant(db, workspace.ctx, owner, 'shipping.track', { maximumDailyCount:10, maximumRisk:'low' });
  const operation = operations.create(db, workspace.ctx, { operationType:'shipping.track',
    idempotencyKey:'tracking:1', authorityDimensions:{ confidence:'high', risk:'low' } });
  const result = await operations.run(db, workspace.ctx, owner, operation.id);
  assert.equal(result.operation.status, 'COMPLETED');
  assert.equal(result.recovered, true);
  assert.equal(executions, 1);
  assert.equal(recoveries, 1);
  assert.equal(result.operation.attemptCount, 1);
});

test('Brief in-progress projection includes work outside the legacy autopilot table', () => {
  const { db, workspace } = setup();
  operations.create(db, workspace.ctx, { operationType:'accounting.sync', idempotencyKey:'sync:1',
    title:'Checking QuickBooks', summary:'Comparing balances before any write.' });
  const active = overview.inProgress(db, workspace.workspaceId);
  assert.equal(active.length, 1);
  assert.equal(active[0].title, 'Checking QuickBooks');
  assert.match(active[0].link, /autopilot\/history/);
});

test('the real Brief and work-history pages expose active universal work', async () => {
  const env = makeApp();
  const workspace = seedWorkspace(env.db, { workspaceName:'Browser operation view' });
  operations.create(env.db, workspace.ctx, { operationType:'accounting.sync', idempotencyKey:'sync:http',
    title:'Checking QuickBooks', summary:'Comparing balances before any write.',
    expectedOutcome:{ booksAgree:true } });
  const agent = request.agent(env.app);
  await signIn(agent, workspace.account.email);
  const home = await agent.get('/').expect(200);
  assert.match(plain(home.text), /In progress 1 Foundry is on it now/);
  const history = await agent.get('/autopilot/history').expect(200);
  assert.match(plain(history.text), /Universal operations .* Checking QuickBooks/);
  assert.doesNotMatch(history.text, /\{&quot;booksAgree&quot;/, 'customers never see raw JSON');
  assert.match(plain(history.text), /Expected · Books Agree: true/);
});
