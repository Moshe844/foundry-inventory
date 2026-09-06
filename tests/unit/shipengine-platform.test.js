'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const platform = require('../../src/shipping/shipengine-platform');
const accounts = require('../../src/shipping/accounts');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Owner Funded Shop' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership };
}

function config() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    apiKey: 'TEST_platform', partnerId: 'partner-keeper',
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    tokenIssuer: 'keeper-foundry', tokenKeyId: 'keeper-key', scope: 'elements',
  };
}

test('each workspace receives its own ShipEngine seller and owner-funded setup state', async () => {
  const env = setup();
  const cfg = config();
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        account_id: 7319, api_key: { encrypted_api_key: 'TEST_seller_7319' },
      }),
    };
  };
  const opened = await platform.enrol(env.db, env.workspace.ctx, env.membership, {
    companyName: 'Owner Funded Shop', ownerName: 'Moshe Ekstein', email: 'owner@example.test',
    countryCode: 'US',
  }, { configuration: cfg, fetch: fakeFetch });
  assert.equal(opened.sellerId, '7319');
  assert.equal(opened.billingReady, false);
  assert.equal(request.url, 'https://api.shipengine.com/v1/partners/accounts');
  assert.equal(request.options.headers['api-key'], 'TEST_platform');
  assert.equal(JSON.parse(request.options.body).external_account_id, env.workspace.workspaceId);

  const carrier = accounts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(carrier.source, 'platform');
  assert.equal(carrier.apiKey, 'TEST_seller_7319');
  assert.notEqual(carrier.apiKey, cfg.apiKey, 'the platform key can never buy this seller\'s labels');

  const token = platform.createToken('7319', { configuration: cfg });
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.partner, 'partner-keeper');
  assert.equal(payload.tenant, '7319');
  assert.ok(payload.exp > payload.iat);

  const ready = await platform.completeOnboarding(env.db, env.workspace.ctx, env.membership, {
    provider: { carrierIds: async (ctx) => {
      assert.equal(ctx.shipengineApiKey, 'TEST_seller_7319');
      return ['se-carrier'];
    } },
  });
  assert.equal(ready.billingReady, true);
  assert.equal(accounts.describe(env.db, env.workspace.workspaceId).billingReady, true);
  env.db.close();
});

test('ShipEngine setup is not marked complete when no seller carrier was activated', async () => {
  const env = setup();
  const now = new Date().toISOString();
  env.db.prepare(`INSERT INTO workspace_connectors
    (id, workspace_id, connector_key, display_name, provider_type, provides, config, status,
     capabilities, credential_ref, setup_status, created_at, updated_at)
    VALUES ('conn-se', ?, 'shipping-shipengine-platform', 'ShipEngine', 'shipengine',
      '["shipping"]', '{"platform":true}', 'connected', '["rates"]',
      'credentials:conn-se:provider', 'AUTHORIZING', ?, ?)`)
    .run(env.workspace.workspaceId, now, now);
  require('../../src/connections/credentials').put(env.db, env.workspace.workspaceId,
    'conn-se', 'provider', { apiKey: 'TEST_seller', sellerId: '44' });
  env.db.prepare(`INSERT INTO shipping_referral_accounts
    (id, workspace_id, connector_id, partner, referral_customer_id, name, billing_ready,
     created_at, updated_at) VALUES ('shipref-se', ?, 'conn-se', 'shipengine', '44',
      'Owner Funded Shop', 0, ?, ?)`)
    .run(env.workspace.workspaceId, now, now);

  await assert.rejects(platform.completeOnboarding(env.db, env.workspace.ctx, env.membership, {
    provider: { carrierIds: async () => [] },
  }), /has not activated a carrier/i);
  assert.equal(platform.describe(env.db, env.workspace.workspaceId).billingReady, false);
  env.db.close();
});

