'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const connect = require('../../src/payments/connect');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

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
