'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const eventFeed = require('../../src/connectors/event-feed');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const readiness = require('../../src/manager/readiness');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Live Feed Co' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Filter Cartridge', baseCode: 'FC-100' });
  inventory.receive(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 30, reference: 'opening',
  });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'live-feed-test' });
  return { ...store, workspace, membership, item, app };
}

test('an authenticated sale feed changes inventory once and wakes the manager', async () => {
  const env = setup();
  const connected = eventFeed.enable(env.db, env.workspace.ctx, env.membership);
  const occurredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const response = await request(env.app)
    .post('/api/v1/feed/events')
    .set('Authorization', `Bearer ${connected.token}`)
    .send({
      eventId: 'sale-10482-line-1', type: 'sale', skuCode: 'FC-100',
      locationName: env.workspace.main.name, quantity: 3, occurredAt,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.accepted, 1);
  assert.equal(response.body.rejected, 0);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 27);
  const movement = env.db.prepare("SELECT * FROM movements WHERE reference = 'feed:sale-10482-line-1'").get();
  assert.equal(movement.operation, 'issue');
  assert.equal(movement.quantity_delta, -3);
  assert.equal(movement.occurred_at, occurredAt);
  assert.ok(env.db.prepare("SELECT 1 FROM manager_triggers WHERE workspace_id = ? AND kind = 'connector:issue'")
    .get(env.workspace.workspaceId), 'the unattended event must wake the manager loop');

  const replay = await request(env.app)
    .post('/api/v1/feed/events')
    .set('Authorization', `Bearer ${connected.token}`)
    .send({ eventId: 'sale-10482-line-1', type: 'sale', skuCode: 'FC-100',
      locationName: env.workspace.main.name, quantity: 3, occurredAt });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.accepted, 0);
  assert.equal(replay.body.replayed, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 27,
    'retries never issue the same sale twice');
  env.db.close();
});

test('a first-sync batch establishes real demand history and clears the missing-feed exception', async () => {
  const env = setup();
  assert.equal(readiness.decisions(env.db, env.workspace.workspaceId).length, 1);
  const connected = eventFeed.enable(env.db, env.workspace.ctx, env.membership);
  assert.equal(readiness.decisions(env.db, env.workspace.workspaceId).length, 1,
    'creating a token is not evidence that an external system is actually connected');
  const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const response = await request(env.app)
    .post('/api/v1/feed/events')
    .set('Authorization', `Bearer ${connected.token}`)
    .send({ events: [
      { eventId: 'sale-history-1', type: 'sale', skuCode: 'FC-100', locationName: env.workspace.main.name,
        quantity: 2, occurredAt: daysAgo(10) },
      { eventId: 'sale-history-2', type: 'sale', skuCode: 'FC-100', locationName: env.workspace.main.name,
        quantity: 2, occurredAt: daysAgo(5) },
      { eventId: 'sale-history-3', type: 'sale', skuCode: 'FC-100', locationName: env.workspace.main.name,
        quantity: 2, occurredAt: daysAgo(1) },
    ] });
  assert.equal(response.status, 200);
  assert.equal(response.body.accepted, 3);
  const assessed = readiness.assess(env.db, env.workspace.workspaceId);
  assert.equal(assessed.connectedSources, 1);
  assert.equal(assessed.usageReady, 1);
  assert.deepEqual(readiness.decisions(env.db, env.workspace.workspaceId), []);
  env.db.close();
});

test('feed authentication is bearer-only, workspace-scoped, and rejected events change nothing', async () => {
  const env = setup();
  const connected = eventFeed.enable(env.db, env.workspace.ctx, env.membership);
  const missing = await request(env.app).post('/api/v1/feed/events').send({ eventId: 'x', type: 'sale' });
  assert.equal(missing.status, 401);

  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id);
  const rejected = await request(env.app)
    .post('/api/v1/feed/events')
    .set('Authorization', `Bearer ${connected.token}`)
    .send({ eventId: 'wrong-product', type: 'sale', skuCode: 'NOT-HERE',
      locationName: env.workspace.main.name, quantity: 2 });
  assert.equal(rejected.status, 207);
  assert.equal(rejected.body.rejected, 1);
  assert.match(rejected.body.results[0].error, /did not match a product/);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), before);
  assert.equal(env.db.prepare("SELECT status FROM connector_feed_events WHERE external_event_id = 'wrong-product'").get().status,
    'REJECTED');
  env.db.close();
});

test('an owner connects the feed once and the usable token is shown once', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const settings = await agent.get('/settings');
  const enabled = await agent.post('/settings/event-feed/enable').type('form').send({ _csrf: csrfFrom(settings.text) });
  assert.equal(enabled.status, 303);
  assert.equal(enabled.headers.location, '/settings#live-event-feed');

  const once = await agent.get('/settings');
  assert.match(once.text, /Copy this token now/);
  assert.match(once.text, /fnd_live_[a-f0-9]{12}\.[A-Za-z0-9_-]+/);
  assert.match(once.text, /Waiting for first event/);
  const twice = await agent.get('/settings');
  assert.doesNotMatch(twice.text, /Copy this token now/);
  assert.doesNotMatch(twice.text, /fnd_live_[a-f0-9]{12}\.[A-Za-z0-9_-]+/);
  env.db.close();
});
