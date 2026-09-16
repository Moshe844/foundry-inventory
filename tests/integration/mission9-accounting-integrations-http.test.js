'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, plain, csrfFrom } = require('../helpers');
const publicApi = require('../../src/connections/public-api');
const providerService = require('../../src/connections/provider-service');
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
  assert.equal(response.status, 200); assert.equal(response.body.sourceOfTruth, 'StockChief canonical inventory engine');
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
  assert.match(listing, /Any ERP or business system/);
  assert.match(listing, /Start verified ERP connection/);
  assert.doesNotMatch(listing, /More ERP connectors[\s\S]{0,300}Not available here/);
  assert.match(listing, /Advanced: connect custom software with APIs and webhooks/);
  assert.match(listing, /How to prove this API works/);
  assert.match(listing, /How to prove this webhook works/);
  assert.doesNotMatch(listing, /PowerShell|curl/i);
  page = await agent.get(`/settings/connections/${id}`); const detail = plain(page.text);
  assert.equal(page.status, 200); assert.match(detail, /Connected without changing the books/);
  assert.match(detail, /Browser Books Company/); assert.match(detail, /Observe only/);
  assert.match(detail, /Shadow comparison/); assert.match(detail, /Request posting authority/);
  assert.doesNotMatch(detail, /products mapped|Before-checkout stock warning/);
});

test('accounting authorization stays in a popup and its HTTPS callback does not depend on the localhost cookie', async () => {
  const f = setup();
  const previous = {
    clientId: process.env.QUICKBOOKS_CLIENT_ID,
    clientSecret: process.env.QUICKBOOKS_CLIENT_SECRET,
    xeroClientId: process.env.XERO_CLIENT_ID,
    xeroClientSecret: process.env.XERO_CLIENT_SECRET,
    publicUrl: process.env.FOUNDRY_PUBLIC_URL,
    fetch: global.fetch,
  };
  process.env.QUICKBOOKS_CLIENT_ID = 'popup-client';
  process.env.QUICKBOOKS_CLIENT_SECRET = 'popup-secret';
  process.env.XERO_CLIENT_ID = 'xero-popup-client';
  process.env.XERO_CLIENT_SECRET = 'xero-popup-secret';
  process.env.FOUNDRY_PUBLIC_URL = 'https://foundry-public.example.test';
  assert.equal(providerService.authorizationOrigin('xero', 'http://localhost:4000'),
    'http://localhost:4000');
  assert.equal(providerService.authorizationOrigin('quickbooks', 'http://localhost:4000'),
    'https://foundry-public.example.test');
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/oauth2/v1/tokens/bearer')) return new Response(JSON.stringify({
      access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (value.includes('/companyinfo/')) return new Response(JSON.stringify({
      CompanyInfo: { Id: 'realm-popup', CompanyName: 'Popup Books' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`Unexpected provider request: ${value}`);
  };
  try {
    const xeroStarted = await providerService.beginAuthorization(f.db, f.workspace.ctx,
      { providerType: 'xero', popup: '1' }, 'http://localhost:4000');
    const xeroAuthorization = new URL(xeroStarted.redirectUrl);
    assert.equal(xeroAuthorization.hostname, 'login.xero.com');
    assert.equal(xeroAuthorization.searchParams.get('redirect_uri'),
      'http://localhost:4000/settings/connections/xero/callback');

    const agent = request.agent(f.app);
    await signIn(agent, f.workspace.account.email);
    const page = await agent.get('/settings/connections');
    assert.match(page.text, /data-oauth-connect="quickbooks"/);
    const started = await agent.post('/settings/connections/connect').type('form').send({
      _csrf: csrfFrom(page.text), providerType: 'quickbooks', popup: '1',
    });
    assert.equal(started.status, 303);
    const authorization = new URL(started.headers.location);
    assert.equal(authorization.hostname, 'appcenter.intuit.com');
    assert.equal(authorization.searchParams.get('redirect_uri'),
      'https://foundry-public.example.test/settings/connections/quickbooks/callback');

    // Deliberately use a fresh HTTP client: the public callback hostname does
    // not share the localhost session cookie that opened the popup.
    const returned = await request(f.app).get('/settings/connections/quickbooks/callback').query({
      state: authorization.searchParams.get('state'), code: 'provider-code', realmId: 'realm-popup',
    });
    assert.equal(returned.status, 200);
    assert.match(returned.text, /QuickBooks Online is connected/);
    assert.match(returned.text, /foundry:connection-return/);
    assert.match(returned.text, /window\.close/);
    assert.match(returned.text, /http:\/\/127\.0\.0\.1/);
  } finally {
    if (previous.clientId === undefined) delete process.env.QUICKBOOKS_CLIENT_ID;
    else process.env.QUICKBOOKS_CLIENT_ID = previous.clientId;
    if (previous.clientSecret === undefined) delete process.env.QUICKBOOKS_CLIENT_SECRET;
    else process.env.QUICKBOOKS_CLIENT_SECRET = previous.clientSecret;
    if (previous.xeroClientId === undefined) delete process.env.XERO_CLIENT_ID;
    else process.env.XERO_CLIENT_ID = previous.xeroClientId;
    if (previous.xeroClientSecret === undefined) delete process.env.XERO_CLIENT_SECRET;
    else process.env.XERO_CLIENT_SECRET = previous.xeroClientSecret;
    if (previous.publicUrl === undefined) delete process.env.FOUNDRY_PUBLIC_URL;
    else process.env.FOUNDRY_PUBLIC_URL = previous.publicUrl;
    global.fetch = previous.fetch;
  }
});
