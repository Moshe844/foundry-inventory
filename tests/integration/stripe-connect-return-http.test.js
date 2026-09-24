'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const connect = require('../../src/payments/connect');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

test('Stripe can return through the registered local hostname without a second StockChief login', async () => {
  const heldClient = process.env.STRIPE_CONNECT_CLIENT_ID;
  const heldSecret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_test_return';
  process.env.STRIPE_SECRET_KEY = 'sk_test_return';
  const { db } = makeDatabase();
  try {
    const workspace = seedWorkspace(db, { workspaceName: 'Return Test' });
    const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
    const begun = connect.authorizeUrl(db, workspace.ctx, membership, {});
    const app = createApp({ db, env: 'test', sessionSecret: 'stripe-return-host-test' });

    // Deliberately no request.agent and no signed-in cookie: this is what the
    // registered 127.0.0.1 callback receives when StockChief was opened on localhost.
    const response = await request(app).get('/settings/connections/payments/return')
      .query({ state: begun.state, error: 'access_denied',
        error_description: 'Connection was cancelled for this test.' });

    assert.equal(response.status, 200);
    assert.doesNotMatch(response.text, /<h1>Sign in<\/h1>/);
    assert.match(response.text, /Stripe was not connected/);
    assert.match(response.text, /Connection was cancelled for this test/);
  } finally {
    db.close();
    if (heldClient === undefined) delete process.env.STRIPE_CONNECT_CLIENT_ID;
    else process.env.STRIPE_CONNECT_CLIENT_ID = heldClient;
    if (heldSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = heldSecret;
  }
});

test('the Connections UI starts hosted onboarding for the signed-in business', async () => {
  const held = {
    key: process.env.STRIPE_SECRET_KEY,
    enabled: process.env.STRIPE_CONNECT_ENABLED,
    flow: process.env.STRIPE_CONNECT_FLOW,
    openOnboarding: connect.openOnboarding,
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_hosted_route';
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_CONNECT_FLOW = 'hosted';
  const { db } = makeDatabase();
  let received = null;
  try {
    const workspace = seedWorkspace(db, { workspaceName: 'Route Test Goods' });
    connect.openOnboarding = async (passedDb, ctx, membership, options) => {
      received = { passedDb, ctx, membership, options };
      return { url: 'https://connect.stripe.com/setup/s/route-test' };
    };
    const app = createApp({ db, env: 'test', sessionSecret: 'stripe-hosted-route-test' });
    const agent = request.agent(app);
    await signIn(agent, workspace.account.email, workspace.account.password);
    const page = await agent.get('/settings/connections');

    const response = await agent.post('/settings/connections/payments/connect')
      .type('form')
      .send({ _csrf: csrfFrom(page.text) });

    assert.equal(response.status, 303);
    assert.equal(response.headers.location, 'https://connect.stripe.com/setup/s/route-test');
    assert.equal(received.passedDb, db);
    assert.equal(received.ctx.workspaceId, workspace.workspaceId);
    assert.equal(received.membership.role, 'owner');
    assert.equal(received.options.businessName, 'Route Test Goods');
    assert.equal(received.options.email, workspace.account.email);
    assert.match(received.options.returnUrl, /\/settings\/connections\/payments\/return$/);
    assert.match(received.options.refreshUrl, /\/settings\/connections\/payments\/refresh$/);
  } finally {
    connect.openOnboarding = held.openOnboarding;
    db.close();
    for (const [name, value] of [
      ['STRIPE_SECRET_KEY', held.key],
      ['STRIPE_CONNECT_ENABLED', held.enabled],
      ['STRIPE_CONNECT_FLOW', held.flow],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('an unfinished Stripe account does not make the connection popup close as connected', async () => {
  const held = {
    key: process.env.STRIPE_SECRET_KEY,
    enabled: process.env.STRIPE_CONNECT_ENABLED,
    flow: process.env.STRIPE_CONNECT_FLOW,
    refresh: connect.refresh,
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_unfinished_state';
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_CONNECT_FLOW = 'hosted';
  const { db } = makeDatabase();
  try {
    const workspace = seedWorkspace(db, { workspaceName: 'Unfinished Stripe State' });
    const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
    await connect.openOnboarding(db, workspace.ctx, membership, {
      businessName: workspace.account.workspaceName,
      email: workspace.account.email,
      link: false,
      createAccount: async () => ({ id: 'acct_unfinished_state', charges_enabled: false }),
    });
    const app = createApp({ db, env: 'test', sessionSecret: 'stripe-unfinished-state-test' });
    const agent = request.agent(app);
    await signIn(agent, workspace.account.email, workspace.account.password);
    let refreshes = 0;
    connect.refresh = async () => {
      refreshes += 1;
      return connect.describe(db, workspace.workspaceId);
    };

    const response = await agent.get('/settings/connections/payments/state');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { connected: false, chargesEnabled: false });
    assert.equal(refreshes, 1, 'the popup asks Stripe for current readiness rather than cached state');
  } finally {
    connect.refresh = held.refresh;
    db.close();
    for (const [name, value] of [
      ['STRIPE_SECRET_KEY', held.key],
      ['STRIPE_CONNECT_ENABLED', held.enabled],
      ['STRIPE_CONNECT_FLOW', held.flow],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
