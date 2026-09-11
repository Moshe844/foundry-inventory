'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, plain } = require('../helpers');
const publicApi = require('../../src/connections/public-api');
const accountingSync = require('../../src/accounting/integration-sync');
const connections = require('../../src/connections/service');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase(); const workspace = seedWorkspace(store.db, { workspaceName: 'Mission 9 Browser' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Integrated shoe', baseCode: 'M9-SHOE' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'mission9-http' });
  return { ...store, workspace, item, app };
}

test('public API reads and changes inventory only through scoped canonical commands', async () => {
  const f = setup();
  const read = publicApi.create(f.db, f.workspace.ctx, { name: 'Reporting', scopes: ['inventory:read'] });
  const operate = publicApi.create(f.db, f.workspace.ctx, { name: 'Warehouse', scopes: ['inventory:read', 'inventory:write'] });
  let response = await request(f.app).get('/api/v1/public/inventory').set('Authorization', `Bearer ${read.token}`);
  assert.equal(response.status, 200); assert.equal(response.body.sourceOfTruth, 'Foundry canonical inventory engine');
  response = await request(f.app).post('/api/v1/public/commands/inventory/receive')
    .set('Authorization', `Bearer ${read.token}`).set('Idempotency-Key', 'receive-1')
    .send({ skuId: f.item.skuId, locationId: f.workspace.main.id, quantity: 4 });
  assert.equal(response.status, 403);
  response = await request(f.app).post('/api/v1/public/commands/inventory/receive')
    .set('Authorization', `Bearer ${operate.token}`).set('Idempotency-Key', 'receive-1')
    .send({ skuId: f.item.skuId, locationId: f.workspace.main.id, quantity: 4,
      reasonCode: 'purchase_receipt', reference: 'external-command-1' });
  assert.equal(response.status, 201); assert.equal(response.body.verifiedOnHand, 4);
  response = await request(f.app).post('/api/v1/public/commands/inventory/receive')
    .set('Authorization', `Bearer ${operate.token}`).set('Idempotency-Key', 'receive-1')
    .send({ skuId: f.item.skuId, locationId: f.workspace.main.id, quantity: 4,
      reasonCode: 'purchase_receipt', reference: 'external-command-1' });
  assert.equal(response.status, 200); assert.equal(response.body.replayed, true); assert.equal(response.body.verifiedOnHand, 4);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(f.workspace.workspaceId).n, 1);
});

test('Connections UI exposes accounting safety stages and developer integrations without scripts', async () => {
  const f = setup(); const now = new Date().toISOString(); const id = 'con_mission9_browser';
  f.db.prepare(`INSERT INTO workspace_connectors
    (id, workspace_id, connector_key, display_name, provider_type, status, capabilities, provides, config,
     expected_interval_minutes, setup_status, authorized_by_user_id, provider_account_id, provider_account_name, created_at, updated_at)
    VALUES (?, ?, ?, 'QuickBooks Sandbox', 'quickbooks', 'connected', '["accounting:read","accounting:shadow"]',
      '["company identity","trial-balance comparison"]', '{}', 360, 'AUTHORITY_REQUIRED', ?, 'realm-browser',
      'Browser Books Company', ?, ?)`)
    .run(id, f.workspace.workspaceId, `quickbooks:${id}`, f.workspace.ownerId, now, now);
  accountingSync.initialize(f.db, connections.get(f.db, f.workspace.workspaceId, id), f.workspace.ownerId,
    { label: 'QuickBooks company', value: 'Browser Books Company', externalId: 'realm-browser' });
  const agent = request.agent(f.app); await signIn(agent, f.workspace.account.email);
  let page = await agent.get('/settings/connections');
  assert.equal(page.status, 200); const listing = plain(page.text);
  assert.match(listing, /Accounting/); assert.match(listing, /QuickBooks Online/); assert.match(listing, /Xero/);
  assert.match(listing, /Developer API and outbound webhooks/); assert.doesNotMatch(listing, /PowerShell|curl/i);
  page = await agent.get(`/settings/connections/${id}`); const detail = plain(page.text);
  assert.equal(page.status, 200); assert.match(detail, /Connected without changing the books/);
  assert.match(detail, /Browser Books Company/); assert.match(detail, /Observe only/);
  assert.match(detail, /Shadow comparison/); assert.match(detail, /Request posting authority/);
  assert.doesNotMatch(detail, /products mapped|Before-checkout stock warning/);
});
