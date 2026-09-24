'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { createApp } = require('../../src/app');
const shipping = require('../../src/shipping');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function platformEnvironment() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    SHIPENGINE_PLATFORM_API_KEY: 'platform-test-key',
    SHIPENGINE_PARTNER_ID: 'partner-test',
    SHIPENGINE_PLATFORM_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    SHIPENGINE_PLATFORM_TOKEN_ISSUER: 'foundry-tests',
    SHIPENGINE_PLATFORM_TOKEN_KEY_ID: 'test-key-id',
    SHIPENGINE_PLATFORM_SCOPE: 'elements',
  };
}

function withEnvironment(values, action) {
  const before = {};
  for (const [name, value] of Object.entries(values)) {
    before[name] = process.env[name];
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  return Promise.resolve().then(action).finally(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('shipping settings require a business-owned provider account instead of using shared developer funds', async () => {
  await withEnvironment({
    SHIPENGINE_PLATFORM_API_KEY: null,
    SHIPENGINE_PARTNER_ID: null,
    SHIPENGINE_PLATFORM_PRIVATE_KEY: null,
    SHIPENGINE_PLATFORM_PRIVATE_KEY_PATH: null,
    SHIPENGINE_PLATFORM_TOKEN_ISSUER: null,
    SHIPENGINE_PLATFORM_TOKEN_KEY_ID: null,
    SHIPENGINE_PLATFORM_SCOPE: null,
  }, async () => {
    const store = makeDatabase();
    const workspace = seedWorkspace(store.db, { workspaceName: 'Separate postage business' });
    const app = createApp({ db: store.db, env: 'test', sessionSecret: 'shipengine-settings' });
    const agent = request.agent(app);
    await signIn(agent, workspace.account.email, workspace.account.password);

    const page = await agent.get('/settings/shipping');
    const words = plain(page.text);
    assert.equal(page.status, 200);
    assert.match(words, /No carrier account is connected/);
    assert.match(words, /Step 1 — connect a ShipEngine sandbox/);
    assert.match(words, /key beginning with TEST/);
    assert.doesNotMatch(words, /UPS Rates, labels and tracking/);
    assert.match(words, /Production guided setup is not enabled on this installation yet/);
    assert.match(words, /Connect with a shipping-platform key/);
    assert.match(words, /Verify and connect/);
    assert.match(words, /developer key must never pay customer postage/i);
    assert.match(words, /One setup, based on how the business ships today/);
    assert.match(words, /Who pays what/);
    assert.match(words, /None in the current product/);
    assert.match(words, /What StockChief does after the handoff/);
    assert.match(words, /Choose customer notification timing/);
    assert.match(page.text, /<details[^>]+id="existing-carrier-connection"/);
    assert.doesNotMatch(words, /Later — choose how StockChief handles labels/);
    assert.doesNotMatch(words, /Rules you have set/);
    assert.doesNotMatch(words, /Add a rule/);
    assert.doesNotMatch(words, /Set up shipping Keeper will not be charged/);
    store.db.close();
  });
});

test('sample inventory presents one direct ShipEngine sandbox connection step', async () => {
  await withEnvironment({
    SHIPENGINE_PLATFORM_API_KEY: null,
    SHIPENGINE_PARTNER_ID: null,
    SHIPENGINE_PLATFORM_PRIVATE_KEY: null,
  }, async () => {
    const store = makeDatabase();
    const workspace = seedWorkspace(store.db, { workspaceName: 'Disposable shipping qualification' });
    store.db.prepare("UPDATE workspaces SET data_mode = 'synthetic' WHERE id = ?").run(workspace.workspaceId);
    const app = createApp({ db: store.db, env: 'test', sessionSecret: 'shipengine-sandbox-ui' });
    const agent = request.agent(app);
    await signIn(agent, workspace.account.email, workspace.account.password);

    const page = await agent.get('/settings/shipping');
    const words = plain(page.text);
    assert.equal(page.status, 200);
    assert.match(words, /Connect ShipEngine sandbox/);
    assert.match(words, /ShipEngine sandbox API key/);
    assert.match(words, /Handling mode and automation rules appear only after this connection passes/);
    assert.match(page.text, /name="provider" value="shipengine"/);
    assert.doesNotMatch(page.text, /<select[^>]+name="provider"/);
    assert.doesNotMatch(page.text, /<details[^>]+id="existing-carrier-connection"/);
    assert.doesNotMatch(words, /Production guided setup is not enabled/);
    assert.doesNotMatch(words, /Later — choose how StockChief handles labels/);
    assert.doesNotMatch(words, /Rules you have set/);
    store.db.close();
  });
});

test('workspace seller opens embedded onboarding, mints a scoped token, and becomes ready after a carrier is active', async () => {
  await withEnvironment(platformEnvironment(), async () => {
    const store = makeDatabase();
    const workspace = seedWorkspace(store.db, { workspaceName: 'Merchant funded postage' });
    store.db.prepare('UPDATE locations SET address = ? WHERE id = ?')
      .run('12 Main Street, Monroe, NY 10950', workspace.main.id);
    const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
    await shipping.shipenginePlatform.enrol(store.db, workspace.ctx, membership, {
      companyName: 'Merchant funded postage', ownerName: 'Olive Owner',
      email: workspace.account.email, countryCode: 'US',
    }, {
      configuration: shipping.shipenginePlatform.configuration(),
      fetch: async () => ({
        ok: true, status: 201,
        text: async () => JSON.stringify({
          account_id: 8675309,
          api_key: { encrypted_api_key: 'TEST_seller_not_platform' },
        }),
      }),
    });

    const app = createApp({ db: store.db, env: 'test', sessionSecret: 'shipengine-onboarding' });
    const agent = request.agent(app);
    await signIn(agent, workspace.account.email, workspace.account.password);

    const page = await agent.get('/settings/shipping?setup=shipengine');
    const words = plain(page.text);
    assert.equal(page.status, 200);
    assert.match(words, /Shipping for Merchant funded postage/);
    assert.match(words, /setup unfinished/);
    assert.match(words, /StockChief never charges StockChief's platform account/);
    assert.match(page.text, /Advanced connection details/);
    assert.match(page.text, /shipengine-elements-sdk\.mjs/);
    assert.match(page.text, /12 Main Street/);
    assert.match(page.text, /enabledShipEngineCarriers: \['stamps_com', 'dhl_express_worldwide'\]/);

    const token = await agent.get('/settings/shipping/shipengine/token');
    assert.equal(token.status, 200);
    const segments = token.text.split('.');
    assert.equal(segments.length, 3);
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    assert.equal(claims.partner, 'partner-test');
    assert.equal(claims.tenant, '8675309');

    const provider = shipping.provider.get('shipengine');
    const originalCarrierIds = provider.carrierIds;
    provider.carrierIds = async (ctx) => {
      assert.equal(ctx.shipengineApiKey, 'TEST_seller_not_platform');
      return ['se-merchant-carrier'];
    };
    try {
      const complete = await agent.post('/settings/shipping/shipengine/complete')
        .set('x-csrf-token', csrfFrom(page.text))
        .send({ _csrf: csrfFrom(page.text) });
      assert.equal(complete.status, 200);
      assert.deepEqual(complete.body, {
        ok: true, redirect: '/settings/shipping?connected=shipengine#account',
      });
    } finally {
      provider.carrierIds = originalCarrierIds;
    }

    const ready = plain((await agent.get('/settings/shipping')).text);
    assert.match(ready, /ready to buy labels/);
    assert.match(ready, /Manage carriers and payment/);
    assert.match(ready, /Later — choose how StockChief handles labels/);
    assert.match(ready, /Rules you have set/);
    assert.match(ready, /Add a rule/);
    store.db.close();
  });
});
