'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || 'onboarding-shopify-client';
process.env.SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || 'onboarding-shopify-secret';
process.env.SQUARE_APPLICATION_ID = process.env.SQUARE_APPLICATION_ID || 'onboarding-square-app';
process.env.SQUARE_APPLICATION_SECRET = process.env.SQUARE_APPLICATION_SECRET || 'onboarding-square-secret';
process.env.CLOVER_CLIENT_ID = process.env.CLOVER_CLIENT_ID || 'onboarding-clover-client';
process.env.CLOVER_CLIENT_SECRET = process.env.CLOVER_CLIENT_SECRET || 'onboarding-clover-secret';
process.env.CLOVER_WEBHOOK_AUTH_CODE = process.env.CLOVER_WEBHOOK_AUTH_CODE || 'onboarding-clover-webhook';

const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

test('new-inventory onboarding exposes real connection choices before sending owners to Settings', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Connected onboarding' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'onboarding-connections' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const start = await agent.get('/onboarding');
  const startText = plain(start.text);
  assert.equal(start.status, 200);
  assert.match(startText, /Add your inventory/);
  for (const source of ['Move from files', 'Connect another system', 'Enter it manually']) {
    assert.match(startText, new RegExp(source));
  }
  assert.match(startText, /CSV, TSV or Excel export with SKU, name and quantity/);
  assert.doesNotMatch(startText, /Use email attachments|Use several sources|Gmail|Microsoft 365/);
  assert.match(startText, /An admin account and API access/);
  assert.match(startText, /Not sure which source fits/);
  assert.match(startText, /Recommend my starting source/);
  for (const provider of ['Shopify', 'Square', 'Clover', 'WooCommerce', 'Custom API']) {
    assert.match(startText, new RegExp(provider));
  }

  const chosen = await agent.post('/onboarding/choose').type('form')
    .send({ _csrf: csrfFrom(start.text), path: 'software' });
  assert.equal(chosen.status, 303);
  assert.equal(chosen.headers.location, '/onboarding/system');

  const system = await agent.get('/onboarding/system');
  const systemText = plain(system.text);
  assert.equal(system.status, 200);
  assert.match(systemText, /Pick the system you use/);
  assert.match(systemText, /Connect Shopify/);
  assert.match(systemText, /Connect Square/);
  assert.match(systemText, /Connect Clover/);
  assert.match(systemText, /Connect WooCommerce/);
  assert.match(systemText, /Create secure API connection/);
  assert.match(systemText, /Use an export instead/);
  assert.doesNotMatch(systemText, /does not connect directly to any inventory system yet/);

  const vague = await agent.post('/onboarding/describe').type('form')
    .send({ _csrf: csrfFrom(start.text), description: 'I sell clothing' });
  assert.equal(vague.status, 200);
  assert.match(plain(vague.text), /That explains the kind of business, but it does not contain the actual product names/);
  assert.match(plain(vague.text), /Choose where StockChief should get those real records/);

  const mixed = await agent.post('/onboarding/describe').type('form')
    .send({
      _csrf: csrfFrom(vague.text),
      description: 'We keep everything in one spreadsheet, but our supplier emails us a stock report every Monday.',
    });
  assert.equal(mixed.status, 200);
  assert.match(plain(mixed.text), /Move from files/);
  assert.match(plain(mixed.text), /start with an exported file/);

  const mailbox = await agent.get('/settings/ingestion');
  assert.equal(mailbox.status, 200);
  assert.match(plain(mailbox.text), /Use files that arrive by email/);
  assert.match(plain(mailbox.text), /StockChief ignores every sender you do not approve/);
  store.db.close();
});
