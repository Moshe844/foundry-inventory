'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createApp } = require('../../src/app');
const { ProductBrain, canonical } = require('../../src/product-brain/registry');
const navigation = require('../../src/product-brain/navigation');
const prompts = require('../../src/foundry/prompts');
const auth = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

test('every real application route is registered with capability and permission metadata', () => {
  const { db } = makeDatabase();
  const app = createApp({ db, env: 'test', sessionSecret: 'product-brain-route-contract' });
  const coverage = app.locals.productBrainCoverage;
  assert.ok(coverage.routeCount > 300);
  assert.ok(coverage.userFacing > 300);
  assert.ok(coverage.internal > 0);
  assert.equal(app.locals.productBrain.routes.some((route) => !route.family), false);
  assert.equal(app.locals.productBrain.routes.some((route) => !route.internal
    && route.family !== 'auth' && (!route.capabilityId || !route.permission)), false);
  assert.equal(app.locals.productBrain.routes.some((route) => !route.internal
    && (!Array.isArray(route.prerequisites) || !Array.isArray(route.sideEffects))), false);
  assert.equal(app.locals.productBrain.routes.some((route) => !route.internal
    && !['GET', 'HEAD'].includes(route.method) && route.sideEffects.length === 0), false);
});

test('a new important route outside a declared product family fails validation', () => {
  const router = express.Router();
  router.get('/brand-new-unregistered-area', (req, res) => res.send('no contract'));
  const brain = new ProductBrain();
  brain.registerRouter('unregistered-test', router);
  assert.throws(() => brain.validate(), (error) => error.code === 'PRODUCT_BRAIN_INVALID'
    && /brand-new-unregistered-area/.test(error.message));
});

test('every deterministic action type belongs to a canonical capability', () => {
  const permissions = require('../../src/actions/permissions');
  for (const actionType of Object.keys(permissions.ACTION_PERMISSION)) {
    const contract = canonical.actionContract(actionType);
    assert.ok(contract, `${actionType} must have a contract`);
    assert.equal(contract.permission, permissions.permissionForAction(actionType));
    assert.ok(canonical.capability(contract.capabilityId));
    assert.ok(Array.isArray(contract.prerequisites));
    assert.ok(contract.sideEffects.length > 0);
  }
});

test('forecasting truth comes from the product brain and the onboarding prompt agrees', () => {
  const forecasting = canonical.capability('forecasting.plan');
  assert.equal(forecasting.status, 'available');
  assert.equal(forecasting.destination, 'planning');
  assert.match(prompts.ENGINE_BRIEF, /forecasting\.plan \(Demand forecasting\): AVAILABLE/);
  assert.doesNotMatch(prompts.ENGINE_BRIEF, /does NOT have[^.]*demand forecasting/i);
});

test('permission-valid where questions resolve exactly and inaccessible pages are not exposed', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const owner = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const ownerResult = navigation.resolve(db, workspace.workspaceId, owner, 'Where do I find forecasting?');
  assert.equal(ownerResult.href, '/planning');
  assert.equal(ownerResult.canNavigate, true);

  const staffResult = navigation.resolve(db, workspace.workspaceId, { role: 'staff' }, 'Where is accounting?');
  assert.equal(staffResult.canNavigate, false);
  assert.equal(staffResult.href, undefined);
  assert.match(staffResult.answer, /cannot expose|does not include/i);
});

test('record-specific receiving resolves to the exact purchase order action', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const owner = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Navigation Shirt' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, owner, { name: 'Navigation Supply' });
  suppliers.linkItem(db, workspace.ctx, owner, { supplierId: supplier.id, skuId: item.skuId,
    supplierSku: 'NAV-1', purchaseUnit: 'each', unitsPerPurchaseUnit: 1,
    minimumOrderQuantity: 1, orderMultiple: 1, leadTimeDays: 3, lastUnitCost: 4 });
  const po = purchaseOrders.createOrder(db, workspace.ctx, owner, {
    supplierId: supplier.id, lines: [{ skuId: item.skuId, quantityPurchaseUnits: 5 }],
  });
  const result = navigation.resolve(db, workspace.workspaceId, owner,
    `Take me to receive ${po.poNumber}`);
  assert.equal(result.href, `/purchasing/orders/${po.id}/receive`);
  assert.equal(result.navigateNow, true);

  const receipts = navigation.resolve(db, workspace.workspaceId, owner,
    `I need to see the deliveries already booked for ${po.poNumber}—where are they?`);
  assert.equal(receipts.href, `/purchasing/orders/${po.id}/detail#receipts`);
  assert.equal(receipts.label, `Show deliveries for ${po.poNumber}`);
});

test('unavailable capabilities explain the real prerequisite without inventing a route', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const result = navigation.resolve(db, workspace.workspaceId, { role: 'owner' },
    'Can Foundry manage manufacturing orders?');
  assert.equal(result.canNavigate, false);
  assert.match(result.answer, /not available/i);
  assert.match(result.answer, /manufacturing domain/i);
});

test('warehouse capability truth and its exact destination come from the product brain', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const result = navigation.resolve(db, workspace.workspaceId, { role: 'owner' },
    'Where do I scan warehouse bins?');
  assert.equal(result.available, true);
  assert.equal(result.canNavigate, true);
  assert.equal(result.href, '/warehouse');
});

test('available capability questions are answered from deterministic product metadata', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const owner = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const result = navigation.resolve(db, workspace.workspaceId, owner,
    'Can Foundry forecast demand?');
  assert.equal(result.capabilityId, 'forecasting.plan');
  assert.equal(result.available, true);
  assert.equal(result.canNavigate, true);
  assert.equal(result.href, '/planning');
  assert.match(result.answer, /available/i);
});

test('natural wording may propose only a canonical destination and permission remains deterministic', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const provider = { complete: async () => ({ data: { destinationId: 'accounting', reason: 'money area' } }) };
  const denied = await navigation.resolveNatural(db, workspace.workspaceId, { role: 'staff' },
    'Could you point me toward the place that explains all the money?', { provider });
  assert.equal(denied.canNavigate, false);
  assert.equal(denied.href, undefined);
  assert.match(denied.answer, /cannot expose|does not include/i);
});

test('a stray destination alias cannot override the meaning of the full sentence', () => {
  const result = navigation.destinationMatch(
    'Show me where I take care of people buying stuff from us', canonical
  );
  assert.equal(result, undefined);
});

test('where stock is held remains a business-data question, not website navigation', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  let modelCalled = false;
  const provider = { complete: async () => {
    modelCalled = true;
    return { data: { destinationId: 'inventory', reason: 'incorrect navigation guess' } };
  } };
  const result = await navigation.resolveNatural(db, workspace.workspaceId, { role: 'owner' },
    'Where is our Navy 4?', { provider });
  assert.equal(result, null);
  assert.equal(modelCalled, false, 'business data must not be sent through website navigation');
});

test('a navigation interpreter cannot invent a route outside the canonical brain', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const provider = { complete: async () => ({ data: { destinationId: '/invented-secret-page', reason: 'guess' } }) };
  const result = await navigation.resolveNatural(db, workspace.workspaceId, { role: 'owner' },
    'Please find the mysterious control room page', { provider });
  assert.equal(result.canNavigate, false);
  assert.equal(result.href, undefined);
  assert.match(result.answer, /could not safely match/i);
});

test('slow navigation interpretation times out into a safe immediate answer', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  let suppliedSignal = null;
  const provider = { complete: async (request) => {
    suppliedSignal = request.signal;
    return new Promise(() => {});
  } };
  const started = Date.now();
  const result = await navigation.resolveNatural(db, workspace.workspaceId, { role: 'owner' },
    'Where is the mysterious control room screen?', { provider, navigationTimeoutMs: 20 });
  assert.ok(Date.now() - started < 500);
  assert.equal(suppliedSignal.aborted, true);
  assert.equal(result.canNavigate, false);
  assert.match(result.answer, /could not safely match/i);
});
