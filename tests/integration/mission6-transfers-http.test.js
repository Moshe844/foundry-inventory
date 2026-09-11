'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const inventory = require('../../src/domain/inventory-engine');
const { makeApp, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

test('a one-location inventory gets the exact prerequisite instead of an impossible transfer form', async () => {
  const store = makeApp(); const workspace = seedWorkspace(store.db, { workspaceName: 'One location' });
  makeQuantityItem(store.db, workspace.ctx, { name: 'Trail Shoe' });
  store.db.prepare('UPDATE locations SET is_active = 0 WHERE id = ?').run(workspace.store.id);
  const agent = request.agent(store.app); await signIn(agent, workspace.account.email);

  const page = await agent.get('/transfers/new');
  const text = plain(page.text);
  assert.equal(page.status, 200);
  assert.match(text, /A transfer needs two locations/);
  assert.match(text, /Add another location/);
  assert.doesNotMatch(page.text, /<button[^>]*>Request transfer<\/button>/);
  assert.match(page.text, /href="\/locations\?returnTo=%2Ftransfers%2Fnew"/);
});

test('a business owner can follow the real transfer lifecycle in the browser', async () => {
  const store = makeApp(); const workspace = seedWorkspace(store.db, { workspaceName: 'Transfer browser' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Trail Shoe' });
  inventory.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 8 });
  const agent = request.agent(store.app); await signIn(agent, workspace.account.email);

  const start = await agent.get('/transfers/new');
  assert.equal(start.status, 200);
  assert.match(plain(start.text), /Nothing leaves inventory until dispatch is recorded/);
  const created = await agent.post('/transfers').type('form').send({ _csrf: csrfFrom(start.text),
    fromLocationId: workspace.main.id, toLocationId: workspace.store.id,
    skuId: item.skuId, quantity: 5, expectedArrivalDate: '2026-09-12', reason: 'Cover store demand' });
  assert.equal(created.status, 303);
  assert.match(created.headers.location, /^\/transfers\/tr_/);

  let page = await agent.get(created.headers.location);
  assert.match(plain(page.text), /REQUESTED.*8|REQUESTED/i);
  assert.equal(balance(store.db, item.skuId, workspace.main.id), 8);
  let response = await agent.post(`${created.headers.location}/approve`).type('form').send({ _csrf: csrfFrom(page.text) });
  page = await agent.get(response.headers.location);
  assert.match(plain(page.text), /APPROVED/);
  assert.equal(balance(store.db, item.skuId, workspace.main.id), 8);

  response = await agent.post(`${created.headers.location}/pick-and-dispatch`).type('form').send({
    _csrf: csrfFrom(page.text), idempotencyKey: 'browser-picked-and-dispatched',
  });
  page = await agent.get(response.headers.location);
  assert.match(plain(page.text), /IN TRANSIT/);
  assert.match(plain(page.text), /5 in transit/);
  assert.equal(balance(store.db, item.skuId, workspace.main.id), 3);
  assert.equal(balance(store.db, item.skuId, workspace.store.id), 0);

  const lineId = page.text.match(/name="lineId" value="([^"]+)"/)[1];
  const idempotencyKey = page.text.match(/name="idempotencyKey" value="([^"]+)"/)[1];
  response = await agent.post(`${created.headers.location}/receive`).type('form').send({
    _csrf: csrfFrom(page.text), idempotencyKey, lineId, received: 4, lost: 1, damaged: 0,
  });
  page = await agent.get(response.headers.location);
  assert.match(plain(page.text), /fully settled and received|RECEIVED/i);
  assert.match(plain(page.text), /4 received.*1 lost/i);
  assert.equal(balance(store.db, item.skuId, workspace.store.id), 4);

  const queue = await agent.get('/transfers');
  assert.equal(queue.status, 200);
  assert.match(plain(queue.text), /Main Warehouse.*Downtown Store.*TR-0001.*Complete/i);
});

function balance(db, skuId, locationId) {
  return Number(db.prepare('SELECT on_hand FROM balances WHERE sku_id = ? AND location_id = ?')
    .get(skuId, locationId)?.on_hand || 0);
}
