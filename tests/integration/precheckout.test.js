'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const connections = require('../../src/connections/service');
const operatingGuards = require('../../src/domain/operating-guards');
const purchasingPolicy = require('../../src/purchasing/policy-service');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Checkout Guard' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Protected Tee', baseCode: 'TEE-1' });
  inventory.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id,
    quantity: 10, reference: 'opening' });
  const created = connections.create(store.db, workspace.ctx, membership, {
    providerType: 'reference_webhook', displayName: 'Checkout POS',
  });
  return { ...store, workspace, membership, item, token: created.token, connection: created.connection,
    app: createApp({ db: store.db, env: 'test', sessionSecret: 'precheckout-test' }) };
}

function check(env, body, token = env.token) {
  return request(env.app).post('/api/v1/precheckout').set('Authorization', `Bearer ${token}`).send(body);
}

test('pre-checkout reads live availability without mutating inventory', async () => {
  const env = setup();
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  const result = await check(env, { locationName: 'Downtown Store', lines: [{ skuCode: 'TEE-1', quantity: 2 }] });
  assert.equal(result.status, 200);
  assert.equal(result.body.decision, 'ALLOW');
  assert.equal(result.body.lines[0].available, 10);
  assert.equal(result.body.lines[0].projectedAvailable, 8);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1);
  env.db.close();
});

test('owner stock-protection rule is the only hard checkout block', async () => {
  const env = setup();
  operatingGuards.set(env.db, env.workspace.ctx, env.membership, {
    skuId: env.item.skuId, locationId: env.workspace.store.id, threshold: 8,
    comparator: operatingGuards.COMPARATORS.BELOW, releaseCondition: operatingGuards.RELEASES.MANUAL,
  });
  const allowed = await check(env, { locationName: 'Downtown Store', lines: [{ skuCode: 'TEE-1', quantity: 2 }] });
  assert.equal(allowed.body.decision, 'ALLOW', 'balance equal to below-threshold limit remains allowed');
  const blocked = await check(env, { locationName: 'Downtown Store', lines: [{ skuCode: 'TEE-1', quantity: 3 }] });
  assert.equal(blocked.body.decision, 'BLOCK');
  assert.equal(blocked.body.mayProceed, false);
  assert.equal(blocked.body.lines[0].code, 'STOCK_PROTECTION_RULE');
  env.db.close();
});

test('reorder-point crossing warns but does not invent a hard block', async () => {
  const env = setup();
  purchasingPolicy.setPolicy(env.db, env.workspace.ctx, env.membership, env.item.skuId, { reorderPoint: 8 });
  const result = await check(env, { lines: [{ skuCode: 'TEE-1', quantity: 2 }] });
  assert.equal(result.body.decision, 'WARN');
  assert.equal(result.body.mayProceed, true);
  assert.equal(result.body.lines[0].code, 'BELOW_REORDER_POINT');
  env.db.close();
});

test('unknown checkout SKU warns and creates a mapping issue without stock mutation', async () => {
  const env = setup();
  const result = await check(env, { lines: [{ externalSku: 'outside-99', name: 'Unknown shirt', quantity: 1 }] });
  assert.equal(result.body.decision, 'WARN');
  assert.equal(result.body.lines[0].code, 'UNKNOWN_SKU');
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM connection_issues WHERE workspace_id = ? AND issue_type = 'UNKNOWN_SKU'")
    .get(env.workspace.workspaceId).n, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 10);
  env.db.close();
});

test('checkout connection key is workspace-isolated and revoked on disconnect', async () => {
  const env = setup();
  const another = seedAnotherWorkspace(env.db, env.workspace.accountId, 'Other Inventory');
  const otherItem = makeQuantityItem(env.db, another.ctx, { name: 'Other Tee', baseCode: 'OTHER-1' });
  inventory.receive(env.db, another.ctx, { skuId: otherItem.skuId, locationId: another.store.id, quantity: 99 });
  const issued = connections.issueCheckoutToken(env.db, env.workspace.ctx, env.membership, env.connection.id);
  const own = await check(env, { lines: [{ skuCode: 'TEE-1', quantity: 1 }] }, issued.token);
  assert.equal(own.body.lines[0].available, 10);
  const other = await check(env, { lines: [{ skuCode: 'OTHER-1', quantity: 1 }] }, issued.token);
  assert.equal(other.body.lines[0].code, 'UNKNOWN_SKU');
  connections.disconnect(env.db, env.workspace.workspaceId, env.connection.id);
  const revoked = await check(env, { lines: [{ skuCode: 'TEE-1', quantity: 1 }] }, issued.token);
  assert.equal(revoked.status, 401);
  env.db.close();
});

test('pre-checkout supports browser preflight without credentials', async () => {
  const env = setup();
  const response = await request(env.app).options('/api/v1/precheckout')
    .set('Origin', 'https://checkout.example.test')
    .set('Access-Control-Request-Method', 'POST');
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  env.db.close();
});
