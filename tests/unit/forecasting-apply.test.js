'use strict';

/**
 * Acting on a prediction.
 *
 * The forecasting modules are all opinion until something applies one, and this
 * is the boundary where opinion becomes a change to the running business. The
 * tests below are about that boundary rather than about arithmetic: who may
 * cross it, what happens when the answer changes between raising a
 * recommendation and acting on it, and what is left behind afterwards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const supplierService = require('../../src/purchasing/supplier-service');
const purchasingPolicy = require('../../src/purchasing/policy-service');
const modes = require('../../src/autopilot/modes');
const capabilities = require('../../src/autopilot/capabilities');

const planning = require('../../src/forecasting/planning-service');
const recommendations = require('../../src/forecasting/recommendations');
const applyService = require('../../src/forecasting/apply');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

/** A product whose reorder point has drifted well away from its trade. */
function drifted() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Applying Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small' });
  const supplier = supplierService.createSupplier(db, workspace.ctx, membership, {
    name: 'ABC Apparel', defaultLeadTimeDays: 10,
  });
  supplierService.linkItem(db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, supplierSku: 'BS-1', purchaseUnit: 'unit',
    unitsPerPurchaseUnit: 1, lastUnitCost: 4.5, leadTimeDays: 10, isPreferred: true,
  });

  inventory.receive(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 6 * 110 + 300, occurredAt: ago(115),
  });
  for (let day = 110; day >= 1; day -= 1) {
    inventory.issue(db, workspace.ctx, {
      skuId: item.skuId, locationId: workspace.main.id, quantity: 6,
      reasonCode: 'sold', occurredAt: ago(day),
    });
  }
  purchasingPolicy.setPolicy(db, workspace.ctx, membership, item.skuId,
    { reorderPoint: 20, targetStock: 400 });

  const swept = planning.sweepAndRecord(db, workspace.workspaceId, { now: NOW });
  const change = swept.recorded.find((row) => row.kind === 'reorder_point');
  return { db, workspace, membership, ctx: workspace.ctx, skuId: item.skuId, change, swept };
}

test('an owner accepting a recommendation changes the setting and records why', () => {
  const env = drifted();
  assert.ok(env.change, 'a reorder point of 20 against 6 a day should be challenged');

  const outcome = applyService.accept(env.db, env.ctx, env.membership, env.change.id);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.field, 'reorderPoint');

  const policy = purchasingPolicy.effectivePolicy(env.db, env.workspace.workspaceId, env.skuId);
  assert.equal(policy.reorderPoint, outcome.value, 'the configured rule now holds the new figure');
  assert.ok(outcome.value > 20, 'and it moved in the direction the advice argued for');

  const stored = recommendations.get(env.db, env.workspace.workspaceId, env.change.id);
  assert.equal(stored.status, 'APPLIED');
  assert.equal(stored.resultingDetail.from, 20, 'what it was is kept');
  assert.equal(stored.resultingDetail.to, outcome.value, 'and what it became');
  assert.equal(stored.resultingDetail.automatic, false, 'a person did this');
  assert.ok(stored.resultingDetail.because, 'the argument is kept with the change');
  env.db.close();
});

test('an owner does not need to grant StockChief authority to press a button themselves', () => {
  const env = drifted();
  // Nothing granted at all: watching only, no capabilities.
  assert.notEqual(env.change.authorityVerdict, 'authorized');

  const outcome = applyService.accept(env.db, env.ctx, env.membership, env.change.id);
  assert.equal(outcome.applied, true,
    'authority governs what StockChief does unattended, not what the owner may do');
  env.db.close();
});

test('accepting twice changes nothing the second time', () => {
  const env = drifted();
  const first = applyService.accept(env.db, env.ctx, env.membership, env.change.id);
  const second = applyService.accept(env.db, env.ctx, env.membership, env.change.id);

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.replayed, true);
  assert.equal(
    purchasingPolicy.effectivePolicy(env.db, env.workspace.workspaceId, env.skuId).reorderPoint,
    first.value, 'the level did not move twice'
  );
  env.db.close();
});

test('declining is remembered, and a declined recommendation cannot then be applied', () => {
  const env = drifted();
  const declined = applyService.decline(env.db, env.ctx, env.change.id, 'We buy this seasonally.');
  assert.equal(declined.status, 'DECLINED');
  assert.equal(declined.resultingDetail.reason, 'We buy this seasonally.');

  assert.equal(purchasingPolicy.effectivePolicy(env.db, env.workspace.workspaceId, env.skuId).reorderPoint, 20,
    'the owner kept their own figure');
  assert.throws(() => applyService.accept(env.db, env.ctx, env.membership, env.change.id),
    /already turned down/);
  env.db.close();
});

test('StockChief acting alone needs the capability, and re-asks at the moment it acts', () => {
  const env = drifted();

  // 1. Nothing granted: it declines to act and says so rather than throwing.
  const refused = applyService.accept(env.db, env.ctx, env.membership, env.change.id, { automatic: true, now: NOW });
  assert.equal(refused.applied, false);
  assert.equal(refused.refused, true);
  assert.equal(purchasingPolicy.effectivePolicy(env.db, env.workspace.workspaceId, env.skuId).reorderPoint, 20);

  // 2. Granted: it may keep the level current.
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  capabilities.set(env.db, env.ctx, env.membership, 'replenishment_settings', true);

  // 3. But paused, it still may not — the verdict is taken now, not earlier.
  modes.pause(env.db, env.ctx, env.membership, 'Stock take this weekend');
  const paused = applyService.accept(env.db, env.ctx, env.membership, env.change.id, { automatic: true, now: NOW });
  assert.equal(paused.applied, false);
  assert.match(paused.because || '', /Stock take this weekend/);
  assert.equal(purchasingPolicy.effectivePolicy(env.db, env.workspace.workspaceId, env.skuId).reorderPoint, 20,
    'a paused StockChief changes nothing');
  env.db.close();
});

test('StockChief never applies an order or a transfer from here', () => {
  const env = drifted();
  const order = env.swept.recorded.find((row) => row.kind === 'order_now');
  if (!order) { env.db.close(); return; }

  assert.throws(() => applyService.accept(env.db, env.ctx, env.membership, order.id),
    /does not apply that kind/,
    'spending money and moving stock keep their own doors');

  const applied = applyService.applyAuthorised(env.db, env.ctx, env.membership, { now: NOW });
  assert.ok(applied.applied.every((row) => row.field !== undefined),
    'the automatic pass only ever touches replenishment levels');
  env.db.close();
});
