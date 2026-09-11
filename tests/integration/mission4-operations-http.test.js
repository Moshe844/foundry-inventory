'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp, cleanupAll, seedWorkspace, signIn, csrfFrom, plain } = require('../helpers');
const outbox = require('../../src/operations/outbox');
const email = require('../../src/operations/email');
const monitoring = require('../../src/operations/monitoring');

test.after(() => cleanupAll());

test('readiness is machine-readable and the owner can inspect production operations', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Operations HTTP' });
  const sessionsBefore = store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  const ready = await request(store.app).get('/readyz').set('Accept', 'application/json');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ok, true);
  assert.equal(ready.headers['x-foundry-readiness-age-ms'], '0');
  assert.ok(ready.body.checks.some((row) => row.key === 'durable_jobs'));
  const cached = await request(store.app).get('/readyz').set('Accept', 'application/json');
  assert.ok(Number(cached.headers['x-foundry-readiness-age-ms']) >= 0);
  assert.deepEqual(cached.body, ready.body);
  await request(store.app).get('/healthz').expect(200);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, sessionsBefore,
    'orchestrator probes must not manufacture browser sessions');

  const owner = request.agent(store.app);
  await signIn(owner, workspace.account.email);
  const page = await owner.get('/settings/operations');
  assert.equal(page.status, 200);
  assert.match(plain(page.text), /Production operations/);
  assert.match(plain(page.text), /durable jobs/i);
  assert.match(plain(page.text), /Production gate is blocked/);

  const staff = request.agent(store.app);
  await signIn(staff, workspace.staffEmail);
  assert.equal((await staff.get('/settings/operations')).status, 403);
});

test('password recovery has a complete browser flow and does not reveal unknown accounts', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db, { email: 'recover-browser@example.test' });
  const agent = request.agent(store.app);
  const page = await agent.get('/forgot-password');
  assert.equal(page.status, 200);
  const token = csrfFrom(page.text);
  const unknown = await agent.post('/forgot-password').type('form').send({
    _csrf: token, email: 'not-an-account@example.test',
  });
  assert.equal(unknown.status, 200);
  assert.match(plain(unknown.text), /If an account uses that email/);

  const second = await agent.get('/forgot-password');
  const known = await agent.post('/forgot-password').type('form').send({
    _csrf: csrfFrom(second.text), email: workspace.account.email,
  });
  assert.equal(known.status, 200);
  assert.match(plain(known.text), /If an account uses that email/);
  const message = outbox.get(store.db,
    store.db.prepare("SELECT id FROM runtime_outbox WHERE message_type = 'password_reset'").get().id);
  const clear = email.unseal(message.payload);
  const resetToken = new URL(clear.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
  const reset = await agent.get(`/reset-password?token=${encodeURIComponent(resetToken)}`);
  assert.equal(reset.status, 200);
  const changed = await agent.post('/reset-password').type('form').send({
    _csrf: csrfFrom(reset.text), token: resetToken, password: 'changed-password-123',
  });
  assert.equal(changed.status, 303);
  const login = await agent.get('/login');
  const signedIn = await agent.post('/login').type('form').send({
    _csrf: csrfFrom(login.text), email: workspace.account.email,
    password: 'changed-password-123', next: '/',
  });
  assert.equal(signedIn.status, 302);
});

test('the responder endpoint rejects bad tokens and records an acknowledged injected alert', async () => {
  const previous = process.env.FOUNDRY_ALERT_ACK_TOKEN;
  process.env.FOUNDRY_ALERT_ACK_TOKEN = 'mission4-ack-secret';
  try {
    const store = makeApp();
    const alert = monitoring.raise(store.db, {
      severity: 'WARNING', kind: 'certification.injected', title: 'Injected test', detail: 'Expected.',
    });
    const rejected = await request(store.app).post(`/api/v1/operations/alerts/${alert.id}/ack`)
      .send({ token: 'wrong', responder: 'monitor' });
    assert.equal(rejected.status, 401);
    const accepted = await request(store.app).post(`/api/v1/operations/alerts/${alert.id}/ack`)
      .set('Authorization', 'Bearer mission4-ack-secret').send({ responder: 'monitor@example.test' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'ACKNOWLEDGED');
  } finally {
    if (previous === undefined) delete process.env.FOUNDRY_ALERT_ACK_TOKEN;
    else process.env.FOUNDRY_ALERT_ACK_TOKEN = previous;
  }
});
