'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

process.env.SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || 'mission12-client';
process.env.SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || 'mission12-shopify-secret';
process.env.CLOVER_CLIENT_ID = process.env.CLOVER_CLIENT_ID || 'mission12-clover-client';
process.env.CLOVER_CLIENT_SECRET = process.env.CLOVER_CLIENT_SECRET || 'mission12-clover-secret';
process.env.CLOVER_WEBHOOK_AUTH_CODE = process.env.CLOVER_WEBHOOK_AUTH_CODE || 'mission12-clover-webhook';
process.env.CLOVER_ENVIRONMENT = 'sandbox';

const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const sales = require('../../src/sales/sales-order-service');
const connections = require('../../src/connections/service');
const credentials = require('../../src/connections/credentials');
const providerService = require('../../src/connections/provider-service');
const shopifyBootstrap = require('../../src/connections/shopify-bootstrap');
const priceService = require('../../src/pricing/price-service');
const providers = require('../../src/connections/providers/registry');
const connectionTell = require('../../src/connections/tell');
const queryPlanner = require('../../src/attention/query-planner');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Mission 12 Business' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Black T-shirt Small', baseCode: 'TS-BLK-S' });
  inventory.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id, quantity: 30 });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'mission-12-test' });
  return { ...store, workspace, item, app };
}

function addProvider(env, type, config = {}) {
  const id = `con_${crypto.randomBytes(8).toString('hex')}`; const now = new Date().toISOString();
  env.db.prepare(`INSERT INTO workspace_connectors
    (id, workspace_id, connector_key, display_name, provider_type, status, capabilities, provides, config,
     expected_interval_minutes, setup_status, authorized_by_user_id, provider_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'connected', '[]', '[]', ?, 360, 'CONNECTED', ?, ?, ?, ?)`)
    .run(id, env.workspace.workspaceId, `${type}:${id}`, type === 'shopify' ? 'Shopify Store'
      : type === 'square' ? 'Square POS' : type === 'clover' ? 'Clover POS' : 'WooCommerce Store',
      type, JSON.stringify(config), env.workspace.ownerId, `${type}-account`, now, now);
  return connections.get(env.db, env.workspace.workspaceId, id);
}

function hmac(secret, raw) { return crypto.createHmac('sha256', secret).update(raw).digest('base64'); }

test('Connections UI offers real business providers and does not instruct owners to use PowerShell', async () => {
  const env = setup(); const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get('/settings/connections'); const text = plain(page.text);
  assert.equal(page.status, 200);
  assert.match(text, /Selling/); assert.match(text, /Business systems/); assert.match(text, /Supplier communication/);
  assert.match(text, /Shopify/); assert.match(text, /Square/); assert.match(text, /Clover/); assert.match(text, /WooCommerce/);
  assert.match(text, /Custom business system/); assert.match(text, /No scripts, manual JSON, or Check now/);
  assert.doesNotMatch(text, /PowerShell|curl/i);
  env.db.close();
});

test('an unmapped provider location in an empty inventory offers one-step creation instead of an empty dropdown', async () => {
  const store = makeDatabase(); const workspace = seedWorkspace(store.db, { workspaceName: 'Empty Square QA' });
  store.db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'empty-square-test' });
  const env = { ...store, workspace, app }; const connection = addProvider(env, 'square');
  credentials.put(env.db, workspace.workspaceId, connection.id, 'provider', { accessToken: 'encrypted' });
  await providerService.sync(env.db, workspace.workspaceId, connection.id, workspace.ownerId, { adapter: {
    discover: async () => ({ products: [], locations: [{ entityType: 'location', externalId: 'square-location-1',
      displayName: 'Default Test Account' }] }),
  } });
  const agent = request.agent(app); await signIn(agent, workspace.account.email, workspace.account.password);
  const detail = await agent.get(`/settings/connections/${connection.id}`); const text = plain(detail.text);
  assert.equal(detail.status, 200);
  assert.match(text, /One-time setup/);
  assert.match(text, /Create this location in Foundry/);
  assert.doesNotMatch(text, /Choose the matching Foundry record/);
  const created = await agent.post(`/settings/connections/${connection.id}/create-location-map`).type('form').send({
    _csrf: csrfFrom(detail.text), externalId: 'square-location-1', name: 'Square Store', kind: 'store',
  });
  assert.equal(created.status, 303);
  const location = env.db.prepare('SELECT * FROM locations WHERE workspace_id = ? AND name = ?')
    .get(workspace.workspaceId, 'Square Store');
  assert.equal(location.kind, 'store');
  assert.equal(connections.mapping(env.db, workspace.workspaceId, connection.id, 'location', 'square-location-1').foundry_record_id,
    location.id);
  assert.equal(connections.get(env.db, workspace.workspaceId, connection.id).setup_status, 'CONNECTED');
  env.db.close();
});

test('a new Square catalog item can create, price, stock and map all of its variants in one step', async () => {
  const store = makeDatabase(); const workspace = seedWorkspace(store.db, { workspaceName: 'Square Catalog QA' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'square-catalog-test' });
  const env = { ...store, workspace, app }; const connection = addProvider(env, 'square');
  credentials.put(env.db, workspace.workspaceId, connection.id, 'provider', { accessToken: 'encrypted' });
  connections.mapExternal(env.db, workspace.ctx, connection.id, {
    entityType: 'location', externalId: 'square-location-1', foundryRecordId: workspace.main.id,
  });
  await providerService.sync(env.db, workspace.workspaceId, connection.id, workspace.ownerId, { adapter: {
    discover: async () => ({ locations: [], products: [
      { entityType: 'sku', externalId: 'variation-small', parentExternalId: 'item-shirt', code: 'SQ-SHIRT-S',
        displayName: 'Square Shirt / Small', providerData: { itemName: 'Square Shirt', variationName: 'Small',
          trackInventory: true, priceMoney: { amount: 1200, currency: 'USD' },
          inventoryCounts: [{ externalLocationId: 'square-location-1', state: 'IN_STOCK', quantity: '10' }] } },
      { entityType: 'sku', externalId: 'variation-large', parentExternalId: 'item-shirt', code: 'SQ-SHIRT-L',
        displayName: 'Square Shirt / Large', providerData: { itemName: 'Square Shirt', variationName: 'Large',
          trackInventory: true, priceMoney: { amount: 1400, currency: 'USD' },
          inventoryCounts: [{ externalLocationId: 'square-location-1', state: 'IN_STOCK', quantity: '5' }] } },
    ] }),
  } });
  const agent = request.agent(app); await signIn(agent, workspace.account.email, workspace.account.password);
  const detail = await agent.get(`/settings/connections/${connection.id}`); const text = plain(detail.text);
  assert.match(text, /Create it in Foundry from Square/);
  assert.doesNotMatch(text, /Add the product in Foundry/);
  const created = await agent.post(`/settings/connections/${connection.id}/create-product-map`).type('form').send({
    _csrf: csrfFrom(detail.text), externalId: 'variation-small',
  });
  assert.equal(created.status, 303);
  const item = env.db.prepare('SELECT * FROM items WHERE workspace_id = ? AND name = ?').get(workspace.workspaceId, 'Square Shirt');
  const skus = env.db.prepare('SELECT * FROM skus WHERE workspace_id = ? AND item_id = ? ORDER BY code').all(workspace.workspaceId, item.id);
  assert.equal(skus.length, 2);
  assert.equal(connections.mapping(env.db, workspace.workspaceId, connection.id, 'sku', 'variation-small').foundry_record_id,
    skus.find((sku) => sku.code === 'SQ-SHIRT-S').id);
  assert.equal(connections.mapping(env.db, workspace.workspaceId, connection.id, 'sku', 'variation-large').foundry_record_id,
    skus.find((sku) => sku.code === 'SQ-SHIRT-L').id);
  assert.equal(priceService.currentForSku(env.db, workspace.workspaceId, skus.find((sku) => sku.code === 'SQ-SHIRT-S').id).amount_minor, 1200);
  assert.equal(repo.getBalance(env.db, workspace.workspaceId, skus.find((sku) => sku.code === 'SQ-SHIRT-S').id, workspace.main.id), 10);
  assert.equal(repo.getBalance(env.db, workspace.workspaceId, skus.find((sku) => sku.code === 'SQ-SHIRT-L').id, workspace.main.id), 5);
  env.db.close();
});

test('every commerce connector can bulk-add selected products while preserving variant groups', async (t) => {
  for (const providerType of ['square', 'shopify', 'clover', 'woocommerce']) {
    await t.test(providerType, async () => {
      const store = makeDatabase(); const workspace = seedWorkspace(store.db, { workspaceName: `${providerType} Bulk QA` });
      const app = createApp({ db: store.db, env: 'test', sessionSecret: `${providerType}-bulk-test` });
      const env = { ...store, workspace, app }; const connection = addProvider(env, providerType);
      credentials.put(env.db, workspace.workspaceId, connection.id, 'provider', { accessToken: 'encrypted' });
      connections.mapExternal(env.db, workspace.ctx, connection.id, {
        entityType: 'location', externalId: 'provider-location', foundryRecordId: workspace.main.id,
      });
      await providerService.sync(env.db, workspace.workspaceId, connection.id, workspace.ownerId, { adapter: {
        discover: async () => ({ locations: [], products: [
          { entityType: 'sku', externalId: 'mug-red', parentExternalId: 'mug', code: `${providerType}-MUG-R`,
            displayName: 'Provider Mug / Red', providerData: { itemName: 'Provider Mug', variationName: 'Red',
              priceMoney: { amount: 900, currency: 'USD' }, inventoryCounts: [] } },
          { entityType: 'sku', externalId: 'mug-blue', parentExternalId: 'mug', code: `${providerType}-MUG-B`,
            displayName: 'Provider Mug / Blue', providerData: { itemName: 'Provider Mug', variationName: 'Blue',
              priceMoney: { amount: 1000, currency: 'USD' }, inventoryCounts: [] } },
          { entityType: 'sku', externalId: 'cap', parentExternalId: 'cap-parent', code: `${providerType}-CAP`,
            displayName: 'Provider Cap', providerData: { itemName: 'Provider Cap', variationName: null,
              priceMoney: { amount: 1500, currency: 'USD' }, inventoryCounts: [] } },
        ] }),
      } });
      const agent = request.agent(app); await signIn(agent, workspace.account.email, workspace.account.password);
      const detail = await agent.get(`/settings/connections/${connection.id}`); const text = plain(detail.text);
      assert.equal(detail.status, 200);
      assert.match(text, /Select all products/);
      assert.match(text, /Add selected to Foundry/);
      const created = await agent.post(`/settings/connections/${connection.id}/create-products-map`).type('form').send({
        _csrf: csrfFrom(detail.text), externalIds: ['mug-red', 'cap'],
      });
      assert.equal(created.status, 303);
      assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?
        AND name IN ('Provider Mug', 'Provider Cap')`).get(workspace.workspaceId).n, 2);
      assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connection_mappings WHERE workspace_id = ?
        AND connector_id = ? AND entity_type = 'sku' AND external_id IN ('mug-red', 'mug-blue', 'cap')`)
        .get(workspace.workspaceId, connection.id).n, 3);
      assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM sku_prices WHERE workspace_id = ?
        AND source = ?`).get(workspace.workspaceId, `${providerType}_opening_catalog`).n, 3);
      env.db.close();
    });
  }
});

test('Shopify uses client credentials for an installed same-organization store and keeps OAuth fallback', async () => {
  const adapter = providers.get('shopify');
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://internal-test.myshopify.com/admin/oauth/access_token');
      assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials');
      return new Response(JSON.stringify({ access_token: 'same-org-token', expires_in: 3600,
        scope: 'read_orders,read_products,read_locations,read_inventory' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const direct = await adapter.tryDirectAuthorization({ input: { shop: 'internal-test' } });
    assert.equal(direct.credentials.accessToken, 'same-org-token');
    assert.equal(direct.credentials.authMode, 'client_credentials');
    assert.equal(direct.accountId, 'internal-test.myshopify.com');
    assert.ok(Date.parse(direct.expiresAt) > Date.now());

    global.fetch = async () => new Response(JSON.stringify({ error: 'shop_not_permitted',
      error_description: 'Client credentials cannot be performed on this shop.' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
    assert.equal(await adapter.tryDirectAuthorization({ input: { shop: 'external-store' } }), null);

    global.fetch = async () => new Response('<title>400 - Oauth error app_not_installed</title>', {
      status: 400, headers: { 'content-type': 'text/html' },
    });
    await assert.rejects(adapter.tryDirectAuthorization({ input: { shop: 'internal-test' } }),
      /not installed on internal-test\.myshopify\.com/);
  } finally { global.fetch = originalFetch; }
});

test('Square Sandbox personal token connects directly and creates a signed webhook subscription', async () => {
  const adapter = providers.get('square');
  const originalFetch = global.fetch;
  const previous = {
    environment: process.env.SQUARE_ENVIRONMENT,
    applicationId: process.env.SQUARE_APPLICATION_ID,
    accessToken: process.env.SQUARE_SANDBOX_ACCESS_TOKEN,
    applicationSecret: process.env.SQUARE_APPLICATION_SECRET,
  };
  try {
    process.env.SQUARE_ENVIRONMENT = 'sandbox';
    process.env.SQUARE_APPLICATION_ID = 'sandbox-square-app';
    process.env.SQUARE_SANDBOX_ACCESS_TOKEN = 'sandbox-personal-token';
    delete process.env.SQUARE_APPLICATION_SECRET;
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/v2/merchants/me')) return new Response(JSON.stringify({
        merchant: { id: 'merchant-1', business_name: 'Sandbox Shop' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (String(url).endsWith('/v2/webhooks/subscriptions') && !options.method) {
        return new Response(JSON.stringify({ subscriptions: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).endsWith('/v2/webhooks/subscriptions') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.subscription.event_types, ['payment.created', 'payment.updated',
          'refund.created', 'refund.updated', 'catalog.version.updated', 'location.created', 'location.updated']);
        return new Response(JSON.stringify({ subscription: { id: 'square-hook-1',
          signature_key: 'square-generated-signature' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected Square request: ${url}`);
    };
    assert.equal(adapter.metadata().available, true);
    const direct = await adapter.tryDirectAuthorization({ input: {} });
    assert.equal(direct.accountId, 'merchant-1');
    assert.equal(direct.accountName, 'Sandbox Shop');
    assert.equal(direct.credentials.authMode, 'sandbox_personal');
    const registered = await adapter.registerWebhooks({ credentials: direct.credentials,
      webhookUrl: 'https://foundry.example.test/api/v1/connections/square/webhooks/con_square' });
    assert.equal(registered.subscriptionId, 'square-hook-1');
    assert.equal(registered.credentials.webhookSignatureKey, 'square-generated-signature');
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries({ SQUARE_ENVIRONMENT: previous.environment,
      SQUARE_APPLICATION_ID: previous.applicationId, SQUARE_SANDBOX_ACCESS_TOKEN: previous.accessToken,
      SQUARE_APPLICATION_SECRET: previous.applicationSecret })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Square Sandbox hands the owner an unpaid Square checkout and never records a sale before payment', async () => {
  const env = setup(); const connection = addProvider(env, 'square');
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', {
    environment: 'sandbox', accessToken: 'encrypted',
  });
  await providerService.sync(env.db, env.workspace.workspaceId, connection.id, env.workspace.ownerId, { adapter: {
    discover: async () => ({
      products: [{ entityType: 'sku', externalId: 'variation-1', code: 'TS-BLK-S', displayName: 'Square test / Regular' }],
      locations: [{ entityType: 'location', externalId: 'location-1', displayName: env.workspace.store.name }],
    }),
  } });
  const previous = { environment: process.env.SQUARE_ENVIRONMENT, token: process.env.SQUARE_SANDBOX_ACCESS_TOKEN };
  const adapter = providers.get('square'); const originalCheckout = adapter.createSandboxCheckout;
  try {
    process.env.SQUARE_ENVIRONMENT = 'sandbox'; process.env.SQUARE_SANDBOX_ACCESS_TOKEN = 'sandbox-token';
    adapter.createSandboxCheckout = async ({ externalSku, externalLocationId, quantity }) => {
      assert.deepEqual({ externalSku, externalLocationId, quantity }, {
        externalSku: 'variation-1', externalLocationId: 'location-1', quantity: 1,
      });
      return { url: 'https://sandbox.square.link/u/customer-operated-test', orderId: 'draft-order-1' };
    };
    const agent = request.agent(env.app); await signIn(agent, env.workspace.account.email, env.workspace.account.password);
    const detail = await agent.get(`/settings/connections/${connection.id}`);
    const text = plain(detail.text);
    assert.match(text, /Run the sale in Square/);
    assert.match(text, /unpaid Square Sandbox checkout/);
    assert.match(text, /Foundry never presses the final payment button/);
    assert.doesNotMatch(detail.text, /squareupsandbox\.com\/dashboard\/take-payment/);
    const response = await agent.post(`/settings/connections/${connection.id}/square-sandbox-checkout`).type('form').send({
      _csrf: csrfFrom(detail.text), externalSku: 'variation-1', externalLocationId: 'location-1', quantity: '1',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, 'https://sandbox.square.link/u/customer-operated-test');
    assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 30);
  } finally {
    adapter.createSandboxCheckout = originalCheckout;
    if (previous.environment === undefined) delete process.env.SQUARE_ENVIRONMENT;
    else process.env.SQUARE_ENVIRONMENT = previous.environment;
    if (previous.token === undefined) delete process.env.SQUARE_SANDBOX_ACCESS_TOKEN;
    else process.env.SQUARE_SANDBOX_ACCESS_TOKEN = previous.token;
    env.db.close();
  }
});

test('connection lifecycle persists a Square-generated webhook signature securely', async () => {
  const env = setup(); const adapter = providers.get('square');
  const originalDirect = adapter.tryDirectAuthorization; const originalRegister = adapter.registerWebhooks;
  const originalDiscover = adapter.discover;
  const previous = { environment: process.env.SQUARE_ENVIRONMENT,
    applicationId: process.env.SQUARE_APPLICATION_ID, accessToken: process.env.SQUARE_SANDBOX_ACCESS_TOKEN };
  try {
    process.env.SQUARE_ENVIRONMENT = 'sandbox'; process.env.SQUARE_APPLICATION_ID = 'sandbox-square-app';
    process.env.SQUARE_SANDBOX_ACCESS_TOKEN = 'sandbox-personal-token';
    adapter.tryDirectAuthorization = async () => ({ credentials: { accessToken: 'sandbox-personal-token',
      environment: 'sandbox', authMode: 'sandbox_personal' }, accountId: 'merchant-1', accountName: 'Sandbox Shop',
    capabilities: ['ITEMS_READ'] });
    adapter.registerWebhooks = async ({ credentials }) => ({ credentials: { ...credentials,
      webhookSignatureKey: 'generated-signature' }, subscriptionId: 'hook-1' });
    adapter.discover = async () => ({ products: [], locations: [] });
    const connected = await providerService.beginAuthorization(env.db, env.workspace.ctx,
      { providerType: 'square' }, 'https://foundry.example.test');
    assert.equal(connected.connected, true);
    const stored = credentials.get(env.db, env.workspace.workspaceId, connected.connectorId, 'provider');
    assert.equal(stored.webhookSignatureKey, 'generated-signature');
    assert.equal(stored.accessToken, 'sandbox-personal-token');
    const row = env.db.prepare('SELECT ciphertext FROM connection_credentials WHERE connector_id = ?')
      .get(connected.connectorId);
    assert.doesNotMatch(row.ciphertext, /generated-signature|sandbox-personal-token/);
  } finally {
    adapter.tryDirectAuthorization = originalDirect; adapter.registerWebhooks = originalRegister;
    adapter.discover = originalDiscover; env.db.close();
    for (const [key, value] of Object.entries({ SQUARE_ENVIRONMENT: previous.environment,
      SQUARE_APPLICATION_ID: previous.applicationId, SQUARE_SANDBOX_ACCESS_TOKEN: previous.accessToken })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('a partial Shopify webhook setup failure is visible instead of claiming a healthy connection', async () => {
  const env = setup(); const adapter = providers.get('shopify');
  const originals = { direct: adapter.tryDirectAuthorization, register: adapter.registerWebhooks,
    discover: adapter.discover };
  try {
    adapter.tryDirectAuthorization = async () => ({ credentials: { shop: 'scope-test.myshopify.com',
      accessToken: 'encrypted-token' }, accountId: 'scope-test.myshopify.com', accountName: 'Scope Test',
    capabilities: ['read_orders'] });
    adapter.registerWebhooks = async () => [{ topic: 'FULFILLMENTS_CREATE',
      error: 'This app is missing read_fulfillments.' }];
    adapter.discover = async () => ({ products: [], locations: [] });
    const started = await providerService.beginAuthorization(env.db, env.workspace.ctx,
      { providerType: 'shopify', shop: 'scope-test' }, 'https://foundry.example.test');
    assert.equal(started.connected, true);
    const connection = connections.get(env.db, env.workspace.workspaceId, started.connectorId);
    assert.equal(connection.publicStatus, 'Needs attention');
    const issue = env.db.prepare(`SELECT * FROM connection_issues WHERE connector_id = ?
      AND issue_type = 'CONNECTION_WEBHOOK_SETUP_FAILED' AND status = 'OPEN'`).get(connection.id);
    assert.match(issue.detail, /read_fulfillments/);
  } finally {
    adapter.tryDirectAuthorization = originals.direct; adapter.registerWebhooks = originals.register;
    adapter.discover = originals.discover; env.db.close();
  }
});

test('connection lifecycle completes same-organization Shopify directly and redirects external stores to OAuth', async () => {
  const env = setup(); const adapter = providers.get('shopify');
  const originalDirect = adapter.tryDirectAuthorization; const originalDiscover = adapter.discover;
  try {
    adapter.tryDirectAuthorization = async ({ input }) => input.shop === 'internal-test'
      ? { credentials: { shop: 'internal-test.myshopify.com', accessToken: 'encrypted-after-save', authMode: 'client_credentials',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() }, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountId: 'internal-test.myshopify.com', accountName: 'internal-test', capabilities: ['read_orders'] }
      : null;
    adapter.discover = async () => ({ products: [], locations: [] });
    const direct = await providerService.beginAuthorization(env.db, env.workspace.ctx,
      { providerType: 'shopify', shop: 'internal-test' }, 'http://localhost');
    assert.equal(direct.connected, true); assert.equal(direct.redirectUrl, null);
    assert.equal(direct.connection.status, 'connected');
    assert.equal(credentials.get(env.db, env.workspace.workspaceId, direct.connectorId, 'provider').authMode, 'client_credentials');

    const external = await providerService.beginAuthorization(env.db, env.workspace.ctx,
      { providerType: 'shopify', shop: 'external-store' }, 'https://foundry.example.test');
    assert.equal(external.connected, undefined);
    assert.match(external.redirectUrl, /^https:\/\/external-store\.myshopify\.com\/admin\/oauth\/authorize\?/);
    assert.equal(new URL(external.redirectUrl).searchParams.get('redirect_uri'),
      `${providerService.providerOrigin('https://foundry.example.test')}/settings/connections/shopify/callback`);
  } finally { adapter.tryDirectAuthorization = originalDirect; adapter.discover = originalDiscover; env.db.close(); }
});

test('Shopify Dev Dashboard launch continues into OAuth instead of stopping on the Connections page', async () => {
  const env = setup(); const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const response = await agent.get('/settings/connections?shop=dashboard-launch.myshopify.com&host=signed-host');
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^https:\/\/dashboard-launch\.myshopify\.com\/admin\/oauth\/authorize\?/);
  const url = new URL(response.headers.location);
  assert.equal(url.searchParams.get('redirect_uri'),
    `${providerService.providerOrigin('http://127.0.0.1')}/settings/connections/shopify/callback`);
  assert.ok(url.searchParams.get('state'));
  env.db.close();
});

test('provider credentials are encrypted at rest and never placed in connection config', () => {
  const env = setup(); const connection = addProvider(env, 'woocommerce', { storeUrl: 'https://shop.example.test' });
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', { consumerSecret: 'super-secret-value' });
  const row = env.db.prepare('SELECT * FROM connection_credentials WHERE connector_id = ?').get(connection.id);
  assert.doesNotMatch(row.ciphertext, /super-secret-value/);
  assert.equal(credentials.get(env.db, env.workspace.workspaceId, connection.id, 'provider').consumerSecret, 'super-secret-value');
  assert.doesNotMatch(env.db.prepare('SELECT config FROM workspace_connectors WHERE id = ?').get(connection.id).config, /super-secret-value/);
  env.db.close();
});

test('Shopify signed order and fulfillment use Mission 10 exactly once', async () => {
  const env = setup(); const connection = addProvider(env, 'shopify', { shop: 'mission12.myshopify.com' });
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', { shop: 'mission12.myshopify.com', accessToken: 'encrypted-token' });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id, { entityType: 'sku', externalId: 'gid://shopify/ProductVariant/481729', foundryRecordId: env.item.skuId });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id, { entityType: 'location', externalId: 'gid://shopify/Location/123', foundryRecordId: env.workspace.store.id });
  const order = { id: 9001, name: '#1001', currency: 'USD', location_id: 123, created_at: '2026-08-27T10:00:00Z',
    customer: { id: 77, first_name: 'Ari', last_name: 'Buyer' },
    line_items: [{ variant_id: 481729, sku: 'TS-BLK-S', quantity: 3, price: '12.00' }] };
  const raw = JSON.stringify(order); const endpoint = `/api/v1/connections/shopify/webhooks/${connection.id}`;
  const first = await request(env.app).post(endpoint).set('X-Shopify-Topic', 'orders/create')
    .set('X-Shopify-Webhook-Id', 'shop-delivery-1').set('X-Shopify-Hmac-Sha256', hmac(process.env.SHOPIFY_CLIENT_SECRET, raw))
    .set('Content-Type', 'application/json').send(raw);
  assert.equal(first.status, 200); assert.equal(first.body.accepted, 1);
  const mapped = connections.mapping(env.db, env.workspace.workspaceId, connection.id, 'sales_order', '9001');
  const foundryOrder = sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id);
  assert.equal(foundryOrder.totals.allocated, 3);
  assert.equal(foundryOrder.lines[0].unit_price_minor, 1200, 'provider order price is snapshotted without changing the catalog price');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 30);
  const replay = await request(env.app).post(endpoint).set('X-Shopify-Topic', 'orders/create')
    .set('X-Shopify-Webhook-Id', 'shop-delivery-1').set('X-Shopify-Hmac-Sha256', hmac(process.env.SHOPIFY_CLIENT_SECRET, raw))
    .set('Content-Type', 'application/json').send(raw);
  assert.equal(replay.body.replayed, 1);
  const fulfilledRaw = JSON.stringify({ id: 501, order_id: 9001, location_id: 123,
    updated_at: '2026-08-27T11:00:00Z', line_items: [{ variant_id: 481729, sku: 'TS-BLK-S', quantity: 1 }] });
  const fulfilled = await request(env.app).post(endpoint).set('X-Shopify-Topic', 'fulfillments/create')
    .set('X-Shopify-Webhook-Id', 'shop-delivery-2').set('X-Shopify-Hmac-Sha256', hmac(process.env.SHOPIFY_CLIENT_SECRET, fulfilledRaw))
    .set('Content-Type', 'application/json').send(fulfilledRaw);
  assert.equal(fulfilled.body.accepted, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 29);
  const finalRaw = JSON.stringify({ id: 502, order_id: 9001, location_id: 123,
    updated_at: '2026-08-27T12:00:00Z', line_items: [{ variant_id: 481729, sku: 'TS-BLK-S', quantity: 2 }] });
  const final = await request(env.app).post(endpoint).set('X-Shopify-Topic', 'fulfillments/create')
    .set('X-Shopify-Webhook-Id', 'shop-delivery-3').set('X-Shopify-Hmac-Sha256', hmac(process.env.SHOPIFY_CLIENT_SECRET, finalRaw))
    .set('Content-Type', 'application/json').send(finalRaw);
  assert.equal(final.body.accepted, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 27);
  const refundRaw = JSON.stringify({ id: 701, order_id: 9001, created_at: '2026-08-27T13:00:00Z',
    refund_line_items: [{ quantity: 1, restock_type: 'return', location_id: 123,
      line_item: { variant_id: 481729, product_id: 100, sku: 'TS-BLK-S' } }] });
  const returned = await request(env.app).post(endpoint).set('X-Shopify-Topic', 'refunds/create')
    .set('X-Shopify-Webhook-Id', 'shop-delivery-refund-1')
    .set('X-Shopify-Hmac-Sha256', hmac(process.env.SHOPIFY_CLIENT_SECRET, refundRaw))
    .set('Content-Type', 'application/json').send(refundRaw);
  assert.equal(returned.body.accepted, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 28,
    'Shopify restock evidence uses the existing return movement path');
  const returnReplay = await request(env.app).post(endpoint).set('X-Shopify-Topic', 'refunds/create')
    .set('X-Shopify-Webhook-Id', 'shop-delivery-refund-1')
    .set('X-Shopify-Hmac-Sha256', hmac(process.env.SHOPIFY_CLIENT_SECRET, refundRaw))
    .set('Content-Type', 'application/json').send(refundRaw);
  assert.equal(returnReplay.body.replayed, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 28);
  env.db.close();
});

test('Shopify absolute order updates increase and release commitments without replay inflation', async () => {
  const env = setup(); const connection = addProvider(env, 'shopify');
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', {
    shop: 'mission12.myshopify.com', accessToken: 'encrypted-token',
  });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id, {
    entityType: 'sku', externalId: 'gid://shopify/ProductVariant/481729', foundryRecordId: env.item.skuId,
  });
  const endpoint = `/api/v1/connections/shopify/webhooks/${connection.id}`;
  const send = (topic, delivery, payload) => {
    const raw = JSON.stringify(payload);
    return request(env.app).post(endpoint).set('X-Shopify-Topic', topic)
      .set('X-Shopify-Webhook-Id', delivery)
      .set('X-Shopify-Hmac-Sha256', hmac(process.env.SHOPIFY_CLIENT_SECRET, raw))
      .set('Content-Type', 'application/json').send(raw);
  };
  const base = { id: 9100, name: '#1100', currency: 'USD', created_at: '2026-08-27T10:00:00Z',
    updated_at: '2026-08-27T10:00:00Z', line_items: [{ variant_id: 481729, sku: 'TS-BLK-S', quantity: 3, price: '12.00' }] };
  assert.equal((await send('orders/create', 'shop-snapshot-create', base)).body.accepted, 1);
  const mapping = connections.mapping(env.db, env.workspace.workspaceId, connection.id, 'sales_order', '9100');
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapping.foundry_record_id).totals.allocated, 3);

  const increased = { ...base, updated_at: '2026-08-27T11:00:00Z',
    line_items: [{ ...base.line_items[0], quantity: 5 }] };
  assert.equal((await send('orders/updated', 'shop-snapshot-grow', increased)).body.accepted, 1);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapping.foundry_record_id).totals.allocated, 5);
  const replay = await send('orders/updated', 'shop-snapshot-grow', increased);
  assert.equal(replay.body.replayed, 1);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapping.foundry_record_id).totals.allocated, 5);

  const reduced = { ...base, updated_at: '2026-08-27T12:00:00Z',
    line_items: [{ ...base.line_items[0], quantity: 2 }] };
  assert.equal((await send('orders/updated', 'shop-snapshot-reduce', reduced)).body.accepted, 1);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapping.foundry_record_id).totals.allocated, 2);
  const cancelled = { ...reduced, cancelled_at: '2026-08-27T13:00:00Z', cancel_reason: 'customer' };
  assert.equal((await send('orders/cancelled', 'shop-snapshot-cancel', cancelled)).body.accepted, 1);
  const final = sales.getOrder(env.db, env.workspace.workspaceId, mapping.foundry_record_id);
  assert.equal(final.status, 'CANCELLED'); assert.equal(final.totals.allocated, 0);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 30,
    'order snapshots change demand, not physical stock');
  env.db.close();
});

test('Square signed completed payment becomes one existing inventory issue', async () => {
  const env = setup(); const connection = addProvider(env, 'square');
  const signatureKey = 'square-signature-key';
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', { environment: 'sandbox', accessToken: 'encrypted', webhookSignatureKey: signatureKey });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id, { entityType: 'sku', externalId: 'variation-1', foundryRecordId: env.item.skuId });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id, { entityType: 'location', externalId: 'location-1', foundryRecordId: env.workspace.store.id });
  const body = { event_id: 'square-event-1', type: 'payment.updated', created_at: '2026-08-27T12:00:00Z',
    merchant_id: 'square-account', data: { object: { payment: { id: 'payment-1', status: 'COMPLETED', order_id: 'order-1', location_id: 'location-1', created_at: '2026-08-27T12:00:00Z', updated_at: '2026-08-27T12:00:00Z' },
      order: { id: 'order-1', location_id: 'location-1', line_items: [{ catalog_object_id: 'variation-1', quantity: '2' }] } } } };
  const raw = JSON.stringify(body); const endpoint = `/api/v1/connections/square/webhooks/${connection.id}`;
  const url = `${providerService.providerOrigin('http://localhost')}${endpoint}`;
  const signature = crypto.createHmac('sha256', signatureKey).update(`${url}${raw}`).digest('base64');
  const result = await request(env.app).post(endpoint).set('Host', 'localhost').set('X-Square-HmacSha256-Signature', signature)
    .set('Content-Type', 'application/json').send(raw);
  assert.equal(result.status, 200); assert.equal(result.body.accepted, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 28);
  const replayBody = { ...body, event_id: 'square-event-2', type: 'payment.updated' };
  const replayRaw = JSON.stringify(replayBody);
  const replaySignature = crypto.createHmac('sha256', signatureKey).update(`${url}${replayRaw}`).digest('base64');
  const replay = await request(env.app).post(endpoint).set('Host', 'localhost')
    .set('X-Square-HmacSha256-Signature', replaySignature).set('Content-Type', 'application/json').send(replayRaw);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 28,
    'payment.created and payment.updated for one Square payment must issue stock once');
  const agent = request.agent(env.app); await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const salesPage = await agent.get('/sales'); const salesText = plain(salesPage.text);
  assert.equal(salesPage.status, 200);
  assert.match(salesText, /Completed sales/);
  assert.match(salesText, /Square POS/);
  assert.match(salesText, /Black T-shirt Small/);
  assert.match(salesText, /2 units/);
  env.db.close();
});

test('Square completed refund is durable review evidence and never invents a physical return', async () => {
  const env = setup(); const connection = addProvider(env, 'square'); const signatureKey = 'square-refund-signature';
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', {
    environment: 'sandbox', accessToken: 'encrypted', webhookSignatureKey: signatureKey,
  });
  const endpoint = `/api/v1/connections/square/webhooks/${connection.id}`;
  const webhookUrl = `${providerService.providerOrigin('http://localhost')}${endpoint}`;
  const send = (body) => {
    const raw = JSON.stringify(body);
    const signature = crypto.createHmac('sha256', signatureKey).update(`${webhookUrl}${raw}`).digest('base64');
    return request(env.app).post(endpoint).set('Host', 'localhost')
      .set('X-Square-HmacSha256-Signature', signature).set('Content-Type', 'application/json').send(raw);
  };
  const refund = { event_id: 'refund-delivery-1', type: 'refund.updated', created_at: '2026-08-27T15:00:00Z',
    merchant_id: 'square-account', data: { object: { refund: { id: 'refund-1', status: 'COMPLETED',
      payment_id: 'payment-1', order_id: 'order-1', created_at: '2026-08-27T14:59:00Z',
      updated_at: '2026-08-27T15:00:00Z', amount_money: { amount: 1200, currency: 'USD' },
      reason: 'Customer returned item' } } } };
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  const first = await send(refund);
  assert.equal(first.status, 200); assert.equal(first.body.accepted, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  const issue = env.db.prepare(`SELECT * FROM connection_issues WHERE connector_id = ?
    AND issue_type = 'RETURN_REVIEW_REQUIRED' AND status = 'OPEN'`).get(connection.id);
  assert.match(issue.detail, /financial evidence only/);
  const replay = await send({ ...refund, event_id: 'refund-delivery-2', type: 'refund.created' });
  assert.equal(replay.body.replayed, 1);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connector_feed_events WHERE connector_id = ?
    AND event_type = 'return.reported'`).get(connection.id).n, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  env.db.close();
});

test('Clover signed paid-order webhook uses the existing inventory engine and replays exactly once', async () => {
  const env = setup(); const connection = addProvider(env, 'clover');
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', {
    environment: 'sandbox', merchantId: 'clover-account', accessToken: 'encrypted',
    webhookAuthCode: process.env.CLOVER_WEBHOOK_AUTH_CODE,
  });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id,
    { entityType: 'sku', externalId: 'clover-item-1', foundryRecordId: env.item.skuId });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id,
    { entityType: 'location', externalId: 'clover-account', foundryRecordId: env.workspace.store.id });
  let order = { id: 'clover-order-1', modifiedTime: 1787932800000, paymentState: 'PAID',
    lineItems: { elements: [{ id: 'clover-line-1', item: { id: 'clover-item-1', sku: 'TS-BLK-S' },
      unitQty: 2000, price: 1200 }] }, refunds: { elements: [] } };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /\/v3\/merchants\/clover-account\/orders\/clover-order-1/);
    return new Response(JSON.stringify(order), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const body = { appId: process.env.CLOVER_CLIENT_ID, merchants: { 'clover-account': [
      { objectId: 'O:clover-order-1', type: 'UPDATE', ts: 1787932800000 },
    ] } };
    const endpoint = '/api/v1/connections/clover/webhooks';
    const first = await request(env.app).post(endpoint).set('X-Clover-Auth', process.env.CLOVER_WEBHOOK_AUTH_CODE).send(body);
    assert.equal(first.status, 200); assert.equal(first.body.accepted, 1);
    assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 28);
    const replay = await request(env.app).post(endpoint).set('X-Clover-Auth', process.env.CLOVER_WEBHOOK_AUTH_CODE).send(body);
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, 1);
    assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 28);

    order = { ...order, modifiedTime: 1787932860000, paymentState: 'REFUNDED',
      refunds: { elements: [{ id: 'clover-refund-1', amount: 2400 }] } };
    const refunded = await request(env.app).post(endpoint)
      .set('X-Clover-Auth', process.env.CLOVER_WEBHOOK_AUTH_CODE).send({
        appId: process.env.CLOVER_CLIENT_ID, merchants: { 'clover-account': [
          { objectId: 'O:clover-order-1', type: 'UPDATE', ts: 1787932860000 },
        ] },
      });
    assert.equal(refunded.status, 200); assert.equal(refunded.body.accepted, 1);
    assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 28);
    const issue = env.db.prepare(`SELECT detail FROM connection_issues WHERE connector_id = ?
      AND issue_type = 'RETURN_REVIEW_REQUIRED' AND status = 'OPEN'`).get(connection.id);
    assert.match(issue.detail, /financial evidence only/);
  } finally { global.fetch = originalFetch; env.db.close(); }
});

test('Clover uses the current expiring OAuth token flow and refreshes before provider calls', async () => {
  const adapter = providers.get('clover'); const originalFetch = global.fetch;
  try {
    const authorization = adapter.authorizationUrl({ state: 'state-1',
      input: { redirectUri: 'https://foundry.example.test/settings/connections/clover/callback' } });
    const authUrl = new URL(authorization.url);
    assert.equal(authUrl.origin, 'https://sandbox.dev.clover.com');
    assert.equal(authUrl.pathname, '/oauth/v2/authorize');
    assert.equal(authUrl.searchParams.get('client_id'), process.env.CLOVER_CLIENT_ID);
    assert.equal(authUrl.searchParams.get('state'), 'state-1');
    global.fetch = async (url, options) => {
      if (String(url).endsWith('/oauth/v2/token')) {
        const input = JSON.parse(options.body);
        assert.equal(input.client_secret, process.env.CLOVER_CLIENT_SECRET);
        return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1',
          access_token_expiration: 1787932800, refresh_token_expiration: 1819468800 }), { status: 200 });
      }
      if (String(url).endsWith('/v3/merchants/merchant-1')) {
        assert.equal(options.headers.authorization, 'Bearer access-1');
        return new Response(JSON.stringify({ id: 'merchant-1', name: 'Clover Test Merchant' }), { status: 200 });
      }
      if (String(url).endsWith('/oauth/v2/refresh')) {
        return new Response(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2',
          access_token_expiration: Math.floor(Date.now() / 1000) + 1800,
          refresh_token_expiration: Math.floor(Date.now() / 1000) + 86400 }), { status: 200 });
      }
      throw new Error(`Unexpected Clover request: ${url}`);
    };
    const exchanged = await adapter.exchangeAuthorization({
      query: { code: 'authorization-code', merchant_id: 'merchant-1' }, metadata: { environment: 'sandbox' },
    });
    assert.equal(exchanged.accountId, 'merchant-1'); assert.equal(exchanged.credentials.refreshToken, 'refresh-1');
    const refreshed = await adapter.refreshCredentials({ ...exchanged.credentials,
      accessTokenExpiration: Math.floor(Date.now() / 1000) - 1 });
    assert.equal(refreshed.refreshed, true); assert.equal(refreshed.credentials.accessToken, 'access-2');
    assert.equal(refreshed.credentials.refreshToken, 'refresh-2');
  } finally { global.fetch = originalFetch; }
});

test('one batched Clover webhook routes each merchant only to its own Foundry workspace', async () => {
  const store = makeDatabase();
  const first = seedWorkspace(store.db, { workspaceName: 'Clover Merchant One' });
  const second = seedWorkspace(store.db, { workspaceName: 'Clover Merchant Two', email: 'clover-two@example.test' });
  const firstItem = makeQuantityItem(store.db, first.ctx, { name: 'First Clover item', baseCode: 'CLOVER-ONE' });
  const secondItem = makeQuantityItem(store.db, second.ctx, { name: 'Second Clover item', baseCode: 'CLOVER-TWO' });
  inventory.receive(store.db, first.ctx, { skuId: firstItem.skuId, locationId: first.store.id, quantity: 10 });
  inventory.receive(store.db, second.ctx, { skuId: secondItem.skuId, locationId: second.store.id, quantity: 20 });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'clover-isolation' });
  const firstConnection = addProvider({ db: store.db, workspace: first }, 'clover');
  const secondConnection = addProvider({ db: store.db, workspace: second }, 'clover');
  store.db.prepare('UPDATE workspace_connectors SET provider_account_id = ? WHERE id = ?').run('merchant-one', firstConnection.id);
  store.db.prepare('UPDATE workspace_connectors SET provider_account_id = ? WHERE id = ?').run('merchant-two', secondConnection.id);
  for (const [workspace, connection, merchant, item] of [
    [first, firstConnection, 'merchant-one', firstItem], [second, secondConnection, 'merchant-two', secondItem],
  ]) {
    credentials.put(store.db, workspace.workspaceId, connection.id, 'provider', { environment: 'sandbox',
      merchantId: merchant, accessToken: 'encrypted', webhookAuthCode: process.env.CLOVER_WEBHOOK_AUTH_CODE });
    connections.mapExternal(store.db, workspace.ctx, connection.id,
      { entityType: 'sku', externalId: `item-${merchant}`, foundryRecordId: item.skuId });
    connections.mapExternal(store.db, workspace.ctx, connection.id,
      { entityType: 'location', externalId: merchant, foundryRecordId: workspace.store.id });
  }
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const merchant = String(url).includes('merchant-one') ? 'merchant-one' : 'merchant-two';
    return new Response(JSON.stringify({ id: `order-${merchant}`, modifiedTime: 1787932800000, paymentState: 'PAID',
      lineItems: { elements: [{ id: `line-${merchant}`, item: { id: `item-${merchant}` }, unitQty: 1000 }] } }),
    { status: 200 });
  };
  try {
    const response = await request(app).post('/api/v1/connections/clover/webhooks')
      .set('X-Clover-Auth', process.env.CLOVER_WEBHOOK_AUTH_CODE).send({
        appId: process.env.CLOVER_CLIENT_ID, merchants: {
          'merchant-one': [{ objectId: 'O:order-merchant-one', type: 'UPDATE', ts: 1787932800000 }],
          'merchant-two': [{ objectId: 'O:order-merchant-two', type: 'UPDATE', ts: 1787932800000 }],
        },
      });
    assert.equal(response.status, 200); assert.equal(response.body.accepted, 2);
    assert.equal(repo.getBalance(store.db, first.workspaceId, firstItem.skuId, first.store.id), 9);
    assert.equal(repo.getBalance(store.db, second.workspaceId, secondItem.skuId, second.store.id), 19);
  } finally { global.fetch = originalFetch; store.db.close(); }
});

test('unknown Clover SKU and location become safe Needs You mapping requests', async (t) => {
  for (const missing of ['sku', 'location']) {
    await t.test(missing, async () => {
      const env = setup(); const connection = addProvider(env, 'clover');
      credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', {
        environment: 'sandbox', merchantId: 'clover-account', accessToken: 'encrypted',
        webhookAuthCode: process.env.CLOVER_WEBHOOK_AUTH_CODE,
      });
      if (missing === 'location') connections.mapExternal(env.db, env.workspace.ctx, connection.id,
        { entityType: 'sku', externalId: 'clover-item-unknown', foundryRecordId: env.item.skuId });
      if (missing === 'sku') connections.mapExternal(env.db, env.workspace.ctx, connection.id,
        { entityType: 'location', externalId: 'clover-account', foundryRecordId: env.workspace.store.id });
      const order = { id: `clover-order-${missing}`, modifiedTime: 1787932800000, paymentState: 'PAID',
        lineItems: { elements: [{ id: `line-${missing}`, item: { id: 'clover-item-unknown' }, unitQty: 1000 }] } };
      const originalFetch = global.fetch;
      global.fetch = async () => new Response(JSON.stringify(order), { status: 200 });
      try {
        const response = await request(env.app).post('/api/v1/connections/clover/webhooks')
          .set('X-Clover-Auth', process.env.CLOVER_WEBHOOK_AUTH_CODE).send({
            appId: process.env.CLOVER_CLIENT_ID, merchants: { 'clover-account': [
              { objectId: `O:${order.id}`, type: 'UPDATE', ts: 1787932800000 },
            ] },
          });
        assert.equal(response.status, 200); assert.equal(response.body.needsMapping, 1);
        assert.ok(env.db.prepare(`SELECT 1 FROM connection_issues WHERE connector_id = ?
          AND issue_type = ? AND status = 'OPEN'`).get(connection.id, missing === 'sku' ? 'UNKNOWN_SKU' : 'UNKNOWN_LOCATION'));
        assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 30);
      } finally { global.fetch = originalFetch; env.db.close(); }
    });
  }
});

test('WooCommerce signed order commits demand and completion fulfills through the Sales Order engine', async () => {
  const env = setup(); const storeUrl = 'https://shop.example.test';
  const connection = addProvider(env, 'woocommerce', { storeUrl }); const secret = 'woo-webhook-secret';
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', { storeUrl, consumerKey: 'ck_test', consumerSecret: 'cs_test', webhookSecret: secret });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id, { entityType: 'sku', externalId: '555', foundryRecordId: env.item.skuId });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id, { entityType: 'location', externalId: storeUrl, foundryRecordId: env.workspace.store.id });
  const order = { id: 42, number: '42', status: 'processing', currency: 'USD', date_created_gmt: '2026-08-27T13:00:00Z',
    billing: { first_name: 'Wendy', last_name: 'Woo' }, line_items: [{ product_id: 555, variation_id: 0, sku: 'TS-BLK-S', quantity: 4, price: 12 }] };
  const endpoint = `/api/v1/connections/woocommerce/webhooks/${connection.id}`; const raw = JSON.stringify(order);
  const created = await request(env.app).post(endpoint).set('X-WC-Webhook-Topic', 'order.created')
    .set('X-WC-Webhook-Delivery-ID', 'woo-1').set('X-WC-Webhook-Signature', hmac(secret, raw))
    .set('Content-Type', 'application/json').send(raw);
  assert.equal(created.body.accepted, 1);
  const completedOrder = { ...order, status: 'completed', date_modified_gmt: '2026-08-27T14:00:00Z' };
  const completeRaw = JSON.stringify(completedOrder);
  const completed = await request(env.app).post(endpoint).set('X-WC-Webhook-Topic', 'order.updated')
    .set('X-WC-Webhook-Delivery-ID', 'woo-2').set('X-WC-Webhook-Signature', hmac(secret, completeRaw))
    .set('Content-Type', 'application/json').send(completeRaw);
  assert.equal(completed.body.accepted, 2);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 26);
  env.db.close();
});

test('WooCommerce snapshots adjust commitments and cancellation/refund releases demand without inventing stock', async () => {
  const env = setup(); const storeUrl = 'https://safe-woo.example.test';
  const connection = addProvider(env, 'woocommerce', { storeUrl }); const secret = 'woo-lifecycle-secret';
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider',
    { storeUrl, consumerKey: 'ck_test', consumerSecret: 'cs_test', webhookSecret: secret });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id,
    { entityType: 'sku', externalId: '555', foundryRecordId: env.item.skuId });
  connections.mapExternal(env.db, env.workspace.ctx, connection.id,
    { entityType: 'location', externalId: storeUrl, foundryRecordId: env.workspace.store.id });
  const endpoint = `/api/v1/connections/woocommerce/webhooks/${connection.id}`;
  const send = (topic, delivery, body) => {
    const raw = JSON.stringify(body);
    return request(env.app).post(endpoint).set('X-WC-Webhook-Topic', topic)
      .set('X-WC-Webhook-Delivery-ID', delivery).set('X-WC-Webhook-Signature', hmac(secret, raw))
      .set('Content-Type', 'application/json').send(raw);
  };
  const base = { id: 84, number: '84', status: 'processing', currency: 'USD',
    date_created_gmt: '2026-08-28T13:00:00Z', billing: { first_name: 'Wendy', last_name: 'Woo' },
    line_items: [{ product_id: 555, variation_id: 0, sku: 'TS-BLK-S', quantity: 4, price: 12 }] };
  assert.equal((await send('order.created', 'woo-life-1', base)).body.accepted, 1);
  const mapped = connections.mapping(env.db, env.workspace.workspaceId, connection.id, 'sales_order', '84');
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id).totals.allocated, 4);
  const smaller = { ...base, date_modified_gmt: '2026-08-28T13:10:00Z',
    line_items: [{ ...base.line_items[0], quantity: 2 }] };
  assert.equal((await send('order.updated', 'woo-life-2', smaller)).body.accepted, 1);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id).totals.allocated, 2);
  const refunded = { ...smaller, status: 'refunded', date_modified_gmt: '2026-08-28T13:20:00Z',
    refunds: [{ id: 900, total: '-24.00', reason: 'Customer cancelled before shipment' }] };
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  const result = await send('order.updated', 'woo-life-3', refunded);
  assert.equal(result.body.accepted, 2);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id).totals.allocated, 0);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  assert.ok(env.db.prepare(`SELECT 1 FROM connection_issues WHERE connector_id = ?
    AND issue_type = 'RETURN_REVIEW_REQUIRED' AND status = 'OPEN'`).get(connection.id));
  env.db.close();
});

test('Custom business system publishes the normalized contract behind its workspace-scoped token', async () => {
  const env = setup();
  const membership = authService.getMembership(env.db, env.workspace.workspaceId, env.workspace.accountId);
  const created = connections.create(env.db, env.workspace.ctx, membership,
    { providerType: 'reference_webhook', displayName: 'Warehouse ERP' });
  const schema = await request(env.app).get('/api/v1/events/schema').set('Authorization', `Bearer ${created.token}`);
  assert.equal(schema.status, 200); assert.equal(schema.body.version, '1.0');
  assert.ok(schema.body.eventTypes.includes('sale.completed'));
  assert.ok(schema.body.eventTypes.includes('sales_order.fulfilled'));
  assert.ok(schema.body.eventTypes.includes('inventory.transfer'));
  assert.match(schema.body.idempotency, /eventId/);
  const unauthorized = await request(env.app).get('/api/v1/events/schema');
  assert.equal(unauthorized.status, 401);
  env.db.close();
});

test('provider discovery auto-maps exact codes and creates one Needs You request for an uncertain new SKU', async () => {
  const env = setup(); const connection = addProvider(env, 'shopify');
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', { accessToken: 'secret' });
  const fake = { discover: async () => ({ products: [
    { entityType: 'sku', externalId: 'exact', code: 'TS-BLK-S', displayName: 'Black T-shirt Small' },
    { entityType: 'sku', externalId: 'unknown', code: 'NEW-99', displayName: 'New product' },
  ], locations: [{ entityType: 'location', externalId: 'loc', displayName: 'Downtown Store' }] }) };
  const result = await providerService.sync(env.db, env.workspace.workspaceId, connection.id, env.workspace.ownerId, { adapter: fake });
  assert.equal(result.autoMapped, 2); assert.equal(result.needsMapping, 1);
  assert.equal(connections.mapping(env.db, env.workspace.workspaceId, connection.id, 'sku', 'exact').foundry_record_id, env.item.skuId);
  assert.equal(connections.mapping(env.db, env.workspace.workspaceId, connection.id, 'location', 'loc').foundry_record_id, env.workspace.store.id);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM connection_issues WHERE connector_id = ? AND status = 'OPEN'").get(connection.id).n, 1);
  const mappings = await queryPlanner.ask(env.db, env.workspace.workspaceId, "Which Shopify products aren't mapped?", {});
  assert.equal(mappings.plan.intent, 'connection_mapping_issues'); assert.match(mappings.answer, /1 product or location match/);
  const diagnostic = await queryPlanner.ask(env.db, env.workspace.workspaceId, "Why aren't today's Shopify sales showing?", {});
  assert.equal(diagnostic.plan.intent, 'connection_diagnostics'); assert.match(diagnostic.answer, /Shopify Store/);
  assert.equal(connectionTell.matches('Pause Shopify ingestion'), true);
  connectionTell.apply(env.db, env.workspace.ctx, { role: 'owner' }, 'Pause Shopify ingestion');
  assert.ok(connections.get(env.db, env.workspace.workspaceId, connection.id).paused_at);
  connectionTell.apply(env.db, env.workspace.ctx, { role: 'owner' }, 'Resume Shopify');
  assert.equal(connections.get(env.db, env.workspace.workspaceId, connection.id).paused_at, null);
  const mappedByName = connectionTell.apply(env.db, env.workspace.ctx, { role: 'owner' }, 'Map Shopify New product to TS-BLK-S');
  assert.match(mappedByName.message, /Mapped external sku unknown/);
  const resynced = await providerService.sync(env.db, env.workspace.workspaceId, connection.id, env.workspace.ownerId, { adapter: fake });
  assert.equal(resynced.needsMapping, 0, 'an approved mapping remains approved on later discovery');
  assert.equal(connections.mapping(env.db, env.workspace.workspaceId, connection.id, 'sku', 'unknown').foundry_record_id, env.item.skuId);
  providerService.ignoreExternal(env.db, env.workspace.workspaceId, connection.id, 'sku', 'unknown');
  env.db.prepare(`DELETE FROM connection_mappings WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'sku' AND external_id = 'unknown'`)
    .run(env.workspace.workspaceId, connection.id);
  const afterIgnore = await providerService.sync(env.db, env.workspace.workspaceId, connection.id, env.workspace.ownerId, { adapter: fake });
  assert.equal(afterIgnore.needsMapping, 0, 'an ignored provider record stays ignored on later discovery');
  assert.equal(env.db.prepare(`SELECT mapping_status FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'sku' AND external_id = 'unknown'`)
    .get(env.workspace.workspaceId, connection.id).mapping_status, 'IGNORED');
  env.db.close();
});

test('Shopify and Square catalog webhooks surface new products and locations without stopping either connection', async (t) => {
  await t.test('Shopify', async () => {
    const env = setup(); const connection = addProvider(env, 'shopify'); const adapter = providers.get('shopify');
    credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', {
      shop: 'mission12.myshopify.com', accessToken: 'encrypted-token',
    });
    const originalDiscover = adapter.discover;
    adapter.discover = async () => ({ products: [{ entityType: 'sku', externalId: 'gid://shopify/ProductVariant/new',
      code: 'SHOP-NEW', displayName: 'New Shopify product' }], locations: [{ entityType: 'location',
      externalId: 'gid://shopify/Location/new', displayName: 'New Shopify location' }] });
    try {
      const payload = { id: 500, title: 'New Shopify product', updated_at: '2026-08-27T16:00:00Z', variants: [] };
      const raw = JSON.stringify(payload);
      const response = await request(env.app).post(`/api/v1/connections/shopify/webhooks/${connection.id}`)
        .set('X-Shopify-Topic', 'products/update').set('X-Shopify-Webhook-Id', 'shop-catalog-new')
        .set('X-Shopify-Hmac-Sha256', hmac(process.env.SHOPIFY_CLIENT_SECRET, raw))
        .set('Content-Type', 'application/json').send(raw);
      assert.equal(response.status, 200); assert.equal(response.body.accepted, 1);
      assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connection_external_records WHERE connector_id = ?
        AND mapping_status = 'UNMAPPED'`).get(connection.id).n, 2);
      assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connection_issues WHERE connector_id = ?
        AND status = 'OPEN' AND issue_type IN ('UNKNOWN_SKU','UNKNOWN_LOCATION')`).get(connection.id).n, 2);
      assert.equal(connections.get(env.db, env.workspace.workspaceId, connection.id).status, 'connected');
    } finally { adapter.discover = originalDiscover; env.db.close(); }
  });

  await t.test('Square', async () => {
    const env = setup(); const connection = addProvider(env, 'square'); const adapter = providers.get('square');
    const signatureKey = 'square-catalog-signature';
    credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', {
      environment: 'sandbox', accessToken: 'encrypted-token', webhookSignatureKey: signatureKey,
    });
    const originalDiscover = adapter.discover;
    adapter.discover = async () => ({ products: [{ entityType: 'sku', externalId: 'square-new-variation',
      code: 'SQUARE-NEW', displayName: 'New Square product' }], locations: [{ entityType: 'location',
      externalId: 'square-new-location', displayName: 'New Square location' }] });
    try {
      const payload = { event_id: 'square-catalog-new', type: 'catalog.version.updated',
        created_at: '2026-08-27T16:00:00Z', merchant_id: 'square-account',
        data: { object: { catalog_version: { updated_at: '2026-08-27T16:00:00Z' } } } };
      const raw = JSON.stringify(payload); const endpoint = `/api/v1/connections/square/webhooks/${connection.id}`;
      const url = `${providerService.providerOrigin('http://localhost')}${endpoint}`;
      const signature = crypto.createHmac('sha256', signatureKey).update(`${url}${raw}`).digest('base64');
      const response = await request(env.app).post(endpoint).set('Host', 'localhost')
        .set('X-Square-HmacSha256-Signature', signature).set('Content-Type', 'application/json').send(raw);
      assert.equal(response.status, 200); assert.equal(response.body.accepted, 1);
      assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connection_external_records WHERE connector_id = ?
        AND mapping_status = 'UNMAPPED'`).get(connection.id).n, 2);
      assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connection_issues WHERE connector_id = ?
        AND status = 'OPEN' AND issue_type IN ('UNKNOWN_SKU','UNKNOWN_LOCATION')`).get(connection.id).n, 2);
      assert.equal(connections.get(env.db, env.workspace.workspaceId, connection.id).status, 'connected');
    } finally { adapter.discover = originalDiscover; env.db.close(); }
  });
});

test('empty inventory can bootstrap Shopify catalogue, prices, mappings and opening stock exactly once', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Empty Shopify Inventory' });
  store.db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
  const connection = addProvider({ db: store.db, workspace }, 'shopify');
  credentials.put(store.db, workspace.workspaceId, connection.id, 'provider', {
    shop: 'bootstrap.myshopify.com', accessToken: 'encrypted-token',
  });
  const snapshot = {
    currency: 'USD',
    locations: [
      { externalId: 'gid://shopify/Location/1', name: 'Shop location', active: true },
      { externalId: 'gid://shopify/Location/2', name: 'Closed location', active: false },
    ],
    products: [
      { externalId: 'gid://shopify/Product/10', title: 'Trail Board', status: 'ACTIVE', isGiftCard: false,
        variants: [
          { externalId: 'gid://shopify/ProductVariant/11', title: 'Blue / 160', sku: 'BOARD-BLU-160',
            price: '125.50', tracked: true,
            selectedOptions: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: '160' }],
            inventoryLevels: [{ externalLocationId: 'gid://shopify/Location/1', name: 'Shop location', active: true, onHand: 7 }] },
          { externalId: 'gid://shopify/ProductVariant/12', title: 'Red / 170', sku: 'BOARD-RED-170',
            price: '130.00', tracked: true,
            selectedOptions: [{ name: 'Color', value: 'Red' }, { name: 'Size', value: '170' }],
            inventoryLevels: [{ externalLocationId: 'gid://shopify/Location/1', name: 'Shop location', active: true, onHand: 3 }] },
        ] },
      { externalId: 'gid://shopify/Product/20', title: 'Gift Card', status: 'ACTIVE', isGiftCard: true,
        variants: [{ externalId: 'gid://shopify/ProductVariant/21', title: '$25', sku: null, price: '25.00',
          tracked: false, selectedOptions: [], inventoryLevels: [] }] },
    ],
  };
  const adapter = { bootstrapSnapshot: async () => snapshot };
  const first = await shopifyBootstrap.bootstrap(store.db, workspace.ctx, connection.id, { adapter, snapshot });
  assert.deepEqual({ items: first.items, skus: first.skus, locations: first.locations, prices: first.prices,
    openingUnits: first.openingUnits, ignored: first.ignored, replayed: first.replayed },
  { items: 1, skus: 2, locations: 1, prices: 2, openingUnits: 10, ignored: 2, replayed: false });
  const skus = store.db.prepare('SELECT * FROM skus WHERE workspace_id = ? ORDER BY code').all(workspace.workspaceId);
  assert.equal(skus.length, 2, 'exact provider variants are created without invented combinations');
  assert.equal(store.db.prepare('SELECT SUM(on_hand) n FROM balances WHERE workspace_id = ?').get(workspace.workspaceId).n, 10);
  assert.equal(priceService.currentForSku(store.db, workspace.workspaceId, skus[0].id).amount_minor, 12550);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM connection_mappings WHERE connector_id = ?').get(connection.id).n, 3);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n, 2);
  const replay = await shopifyBootstrap.bootstrap(store.db, workspace.ctx, connection.id, { adapter, snapshot });
  assert.equal(replay.replayed, true);
  assert.equal(store.db.prepare('SELECT SUM(on_hand) n FROM balances WHERE workspace_id = ?').get(workspace.workspaceId).n, 10,
    'replaying bootstrap cannot duplicate opening stock');
  store.db.close();
});

test('adding Clover and WooCommerce leaves the normalized engine provider-neutral', () => {
  const catalog = providers.catalog().map((row) => row.type);
  assert.deepEqual(catalog, ['shopify', 'square', 'clover', 'woocommerce', 'reference_webhook',
    'erp_future', 'gmail', 'microsoft365']);
  const source = require('node:fs').readFileSync(require.resolve('../../src/connections/event-ingestion'), 'utf8');
  assert.doesNotMatch(source, /shopify|square|clover|woocommerce/i);
});

test('provider history reconciliation reports drift without rewriting inventory', async () => {
  const env = setup(); const connection = addProvider(env, 'shopify');
  credentials.put(env.db, env.workspace.workspaceId, connection.id, 'provider', { accessToken: 'secret' });
  const adapter = providers.get('shopify'); const original = adapter.historySummary;
  adapter.historySummary = async () => ({ operationalRecords: 1, periodStart: connection.created_at });
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  try {
    const result = await providerService.reviewHistory(env.db, env.workspace.workspaceId, connection.id);
    assert.deepEqual(result, { expected: 1, observed: 0, status: 'MISMATCH' });
    assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
    assert.ok(env.db.prepare("SELECT 1 FROM connection_issues WHERE connector_id = ? AND issue_type = 'RECONCILIATION_MISMATCH'").get(connection.id));
  } finally { adapter.historySummary = original; env.db.close(); }
});
