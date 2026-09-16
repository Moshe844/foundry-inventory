'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const alerts = require('../../src/notifications/email-alerts');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

test('an owner can configure automatic actionable email alerts from Settings', async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.FOUNDRY_FROM_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.FOUNDRY_FROM_EMAIL;
  try {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, {
    workspaceName: 'Alert Settings Co', email: 'owner@alert-settings.example',
  });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'email-alert-settings' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = await agent.get('/settings');
  assert.equal(page.status, 200);
  assert.match(page.text, /Automatic email alerts/);
  assert.match(page.text, /Delivery is not configured on this server yet/);

  const saved = await agent.post('/settings/email-alerts').type('form').send({
    _csrf: csrfFrom(page.text), enabled: '1', minimumSeverity: 'critical',
    recipients: 'inventory@alert-settings.example\nowner@alert-settings.example',
  });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.location, '/settings#email-alerts');

  const setting = alerts.get(store.db, workspace.workspaceId);
  assert.equal(setting.enabled, true);
  assert.equal(setting.minimumSeverity, 'critical');
  assert.deepEqual(setting.recipients, [
    'inventory@alert-settings.example', 'owner@alert-settings.example',
  ]);

  const rendered = await agent.get('/settings');
  assert.match(rendered.text, /waiting for sender/);
  assert.match(rendered.text, /Email alert rules are saved/);
  assert.match(rendered.text, /inventory@alert-settings\.example/);
  } finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.FOUNDRY_FROM_EMAIL;
    else process.env.FOUNDRY_FROM_EMAIL = previousFrom;
  }
});
