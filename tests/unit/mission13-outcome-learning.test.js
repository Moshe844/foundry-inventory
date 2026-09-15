'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const policies = require('../../src/purchasing/policy-service');
const learning = require('../../src/learning/service');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'Learning Company' });
  const membership = auth.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name:'Trail Shoe', baseCode:'TRAIL' });
  const supplier = suppliers.createSupplier(store.db, workspace.ctx, membership,
    { name:'ABC Supply', defaultLeadTimeDays:10 });
  suppliers.linkItem(store.db, workspace.ctx, membership, { supplierId:supplier.id, skuId:item.skuId,
    supplierSku:'ABC-TRAIL', purchaseUnit:'unit', unitsPerPurchaseUnit:1, lastUnitCost:10 });
  return { ...store, workspace, membership, item, supplier };
}

function deliveredOrder(env, number, actualDays, promisedDays = 10) {
  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId:env.supplier.id, destinationLocationId:env.workspace.main.id,
    lines:[{ skuId:env.item.skuId, quantityPurchaseUnits:2, unitCost:10 }],
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, order.id, { markOrdered:true });
  const sent = new Date(Date.UTC(2026, 0, 1 + number * 20));
  const expected = new Date(sent.getTime() + promisedDays * 86400000).toISOString().slice(0,10);
  const receivedAt = new Date(sent.getTime() + actualDays * 86400000).toISOString();
  env.db.prepare(`UPDATE purchase_orders SET ordered_at=?,approved_at=?,expected_date=?,
    expected_date_source='manual' WHERE id=?`).run(sent.toISOString(), sent.toISOString(), expected, order.id);
  const fresh = poService.get(env.db, env.workspace.workspaceId, order.id);
  receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey:`learning-receipt-${number}`, receivedAt,
    lines:[{ lineId:fresh.lines[0].id, quantityUnits:2, locationId:env.workspace.main.id }],
  });
  return order.id;
}

test('decision snapshots keep exact versions and immutable evidence while outcomes remain queryable', () => {
  const env = setup();
  const decision = learning.captureDecision(env.db, env.workspace.workspaceId, {
    sourceKind:'POLICY_CHANGE', sourceId:'decision-1', decisionKind:'TEST_DECISION',
    subjectType:'SKU', subjectId:env.item.skuId, modelId:'planner', modelVersion:'4.2',
    ruleId:'cash-rule', ruleVersion:'3', policyId:'policy-1', policyVersion:7,
    evidence:{ stock:12 }, decision:{ buy:8 }, expectedOutcome:{ cashUseMinor:8000 },
  });
  const measured = learning.captureDecision(env.db, env.workspace.workspaceId, {
    sourceKind:'POLICY_CHANGE', sourceId:'decision-1', decisionKind:'TEST_DECISION',
    subjectType:'SKU', subjectId:env.item.skuId, modelId:'planner', modelVersion:'4.2',
    ruleId:'cash-rule', ruleVersion:'3', policyId:'policy-1', policyVersion:7,
    evidence:{ stock:12 }, decision:{ buy:8 }, expectedOutcome:{ cashUseMinor:8000 },
    actualOutcome:{ cashUseMinor:7800 }, outcomeStatus:'MEASURED',
  });
  assert.equal(measured.policyVersion, 7);
  assert.equal(measured.actualOutcome.cashUseMinor, 7800);
  learning.observe(env.db, decision, { metricName:'CASH_USE_MINOR', predictedValue:8000,
    actualValue:7800, unit:'minor_currency_units', idempotencyKey:'cash-1' });
  assert.throws(() => env.db.prepare('UPDATE learning_outcome_observations SET actual_value=1').run(), /immutable/);
  assert.throws(() => learning.captureDecision(env.db, env.workspace.workspaceId, {
    sourceKind:'POLICY_CHANGE', sourceId:'decision-1', decisionKind:'TEST_DECISION',
    subjectType:'SKU', subjectId:env.item.skuId, modelVersion:'4.2', ruleVersion:'3', policyVersion:7,
    evidence:{ stock:999 }, decision:{ buy:8 }, expectedOutcome:{ cashUseMinor:8000 },
  }), /immutable/);
});

test('systematically late supplier evidence creates one proposal but changes nothing before approval', () => {
  const env = setup();
  const ids = [deliveredOrder(env, 0, 15), deliveredOrder(env, 1, 16), deliveredOrder(env, 2, 15),
    deliveredOrder(env, 3, 15), deliveredOrder(env, 4, 15)];
  const found = learning.detectBias(env.db, env.workspace.workspaceId, { now:Date.UTC(2026,5,1) });
  const item = found.find((entry) => entry.improvementKind === 'SUPPLIER_LEAD_TIME');
  assert.ok(item);
  assert.equal(item.currentValue.days, 10);
  assert.equal(item.proposedValue.days, 16);
  assert.deepEqual(item.evidence.deliveryIds, ids);
  assert.equal(env.db.prepare('SELECT default_lead_time_days n FROM suppliers WHERE id=?').get(env.supplier.id).n, 10);
  assert.equal(learning.listProposals(env.db, env.workspace.workspaceId).length, 1);
});

test('approved learning rolls out through a domain adapter, verifies read-back, and can roll back', () => {
  const env = setup();
  [0,1,2,3].forEach((n) => deliveredOrder(env, n, 15));
  const item = learning.detectBias(env.db, env.workspace.workspaceId, { now:Date.UTC(2026,5,1) })[0];
  const applied = learning.rollout(env.db, env.workspace.ctx, env.membership, item.id,
    { expectedHash:item.integrityHash });
  assert.equal(applied.applied, true);
  assert.equal(applied.rollout.status, 'ACTIVE');
  assert.equal(JSON.parse(applied.rollout.verification).verified, true);
  assert.equal(env.db.prepare('SELECT default_lead_time_days n FROM suppliers WHERE id=?').get(env.supplier.id).n, 15);
  const replay = learning.rollout(env.db, env.workspace.ctx, env.membership, item.id);
  assert.equal(replay.replayed, true);
  const watched = learning.monitor(env.db, env.workspace.workspaceId, item.id,
    { impact:-4, unit:'days of additional error', evidence:{ deliveredOrders:3 } });
  assert.equal(watched.bad, true);
  assert.equal(watched.proposal.status, 'ROLLBACK_RECOMMENDED');
  const reverted = learning.rollback(env.db, env.workspace.ctx, env.membership, item.id);
  assert.deepEqual(reverted.restored, { days:10 });
  assert.equal(env.db.prepare('SELECT default_lead_time_days n FROM suppliers WHERE id=?').get(env.supplier.id).n, 10);
  assert.equal(learning.rollback(env.db, env.workspace.ctx, env.membership, item.id).replayed, true);
});

test('automatic learning defaults off and a narrow grant cannot escape its target or bounds', () => {
  const env = setup();
  [0,1,2].forEach((n) => deliveredOrder(env, n, 12));
  const item = learning.detectBias(env.db, env.workspace.workspaceId, { now:Date.UTC(2026,5,1) })[0];
  assert.equal(learning.rollout(env.db, env.workspace.ctx, env.membership, item.id, { automatic:true }).needsApproval, true);
  learning.grantAuthority(env.db, env.workspace.ctx, env.membership, 'SUPPLIER_LEAD_TIME', {
    targetIds:[env.supplier.id], maximumAbsoluteChange:1, maximumPercentChange:50, maximumMateriality:'HIGH',
  });
  assert.equal(learning.authorityFor(env.db, item).allowed, false, 'a two-day move is outside the narrow bound');
  learning.grantAuthority(env.db, env.workspace.ctx, env.membership, 'SUPPLIER_LEAD_TIME', {
    targetIds:[env.supplier.id], maximumAbsoluteChange:3, maximumPercentChange:50, maximumMateriality:'HIGH',
  });
  const promoted = learning.applyAuthorized(env.db, env.workspace.workspaceId);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].applied, true);
  assert.equal(promoted[0].rollout.automatic, 1);
  learning.revokeAuthority(env.db, env.workspace.ctx, env.membership, 'SUPPLIER_LEAD_TIME');
  assert.equal(learning.activeAuthority(env.db, env.workspace.workspaceId, 'SUPPLIER_LEAD_TIME'), null);
});

test('repeated under-forecasting proposes a safety-stock change and preserves inventory/accounting truth', () => {
  const env = setup();
  for (let n=0; n<5; n += 1) {
    const decision = learning.captureDecision(env.db, env.workspace.workspaceId, {
      sourceKind:'FORECAST', sourceId:`forecast-${n}`, decisionKind:'DEMAND_FORECAST',
      subjectType:'SKU', subjectId:env.item.skuId, modelId:'seasonal-naive', modelVersion:'2.1',
      evidence:{ sample:n }, decision:{ horizonUnits:10 }, expectedOutcome:{ demandUnits:10 },
      actualOutcome:{ demandUnits:14 }, outcomeStatus:'MEASURED',
    });
    learning.observe(env.db, decision, { metricName:'FORECAST_ERROR_UNITS', predictedValue:10,
      actualValue:14, unit:'units', idempotencyKey:`under-${n}` });
  }
  const beforeMovements = env.db.prepare('SELECT COUNT(*) n FROM movements WHERE workspace_id=?')
    .get(env.workspace.workspaceId).n;
  const item = learning.detectBias(env.db, env.workspace.workspaceId).find((entry) => entry.improvementKind === 'SAFETY_STOCK');
  assert.ok(item);
  assert.deepEqual(item.currentValue, { units:0 });
  assert.deepEqual(item.proposedValue, { units:4 });
  learning.rollout(env.db, env.workspace.ctx, env.membership, item.id, { expectedHash:item.integrityHash });
  assert.equal(policies.effectivePolicy(env.db, env.workspace.workspaceId, env.item.skuId).safetyStock, 4);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM movements WHERE workspace_id=?').get(env.workspace.workspaceId).n,
    beforeMovements, 'learning changes policy, never physical stock');
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM accounting_journal_entries WHERE workspace_id=?')
    .get(env.workspace.workspaceId).n, 0, 'learning never invents accounting entries');
});

test('the outcome dashboard measures forecast, supplier, excess, cash, margin and intervention fields without guessing', () => {
  const env = setup();
  [0,1,2].forEach((n) => deliveredOrder(env, n, 12));
  const result = learning.measurements(env.db, env.workspace.workspaceId, { now:Date.UTC(2026,5,1) });
  assert.equal(result.supplierLeadTime[0].samples, 3);
  assert.equal(result.supplierLeadTime[0].meanErrorDays, 2);
  assert.equal(result.interventionRate, null, 'unknown is not presented as zero activity');
  assert.equal(result.automationRate, null, 'automation is not claimed before eligible operations are measured');
  assert.deepEqual(result.automationTarget,{ minimumPercent:90,aspirationPercent:95,status:'NOT_MEASURED' });
  for (const key of ['stockoutsAvoided','currentSlowInventoryValueMinor','cashUseMinor','marginImpactMinor','observations']) {
    assert.equal(typeof result[key], 'number');
  }
});
