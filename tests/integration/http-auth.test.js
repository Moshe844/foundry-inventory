'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { makeApp, cleanupAll, seedWorkspace, makeQuantityItem, csrfFrom, signIn, plain } = require('../helpers');

test.after(cleanupAll);

test('protected pages redirect anonymous visitors to sign in', async () => {
  const { app } = makeApp();
  for (const path of ['/', '/inventory', '/inventory/new', '/locations', '/activity', '/settings', '/search']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 302, path);
    assert.ok(res.headers.location.startsWith('/login'), path);
  }
});

test('the search API refuses anonymous callers', async () => {
  const { app } = makeApp();
  const res = await request(app).get('/api/search?q=copper').set('Accept', 'application/json');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

test('sign in fails for a wrong password and succeeds for the right one', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db);
  const agent = request.agent(store.app);

  const page = await agent.get('/login');
  const token = csrfFrom(page.text);

  const bad = await agent
    .post('/login')
    .type('form')
    .send({ _csrf: token, email: workspace.account.email, password: 'wrong-password' });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /do not match an account/);

  const good = await agent
    .post('/login')
    .type('form')
    .send({ _csrf: token, email: workspace.account.email, password: workspace.account.password, next: '/' });
  assert.equal(good.status, 302);
  assert.equal(good.headers.location, '/');

  const home = await agent.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Overview/);
});

test('registration creates an account, then the customer creates an inventory', async () => {
  const store = makeApp();
  const agent = request.agent(store.app);
  const page = await agent.get('/register');
  const token = csrfFrom(page.text);

  const res = await agent.post('/register').type('form').send({
    _csrf: token,
    name: 'Robin Field',
    email: 'robin@fresh.test',
    password: 'password123',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/inventories');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 0);

  const inventories = await agent.get('/inventories');
  assert.match(inventories.text, /New Inventory/);
  const created = await agent.post('/inventories').type('form').send({
    _csrf: csrfFrom(inventories.text),
    name: 'Fresh Co',
  });
  assert.equal(created.status, 303);
  assert.equal(created.headers.location, '/onboarding');

  const chooser = await agent.get('/onboarding');
  assert.equal(chooser.status, 200);
  assert.match(chooser.text, /How are you managing inventory today/);
  assert.match(chooser.text, /Starting fresh/);

  // The Mission 1 console is still there underneath, and still empty.
  const locations = await agent.get('/locations');
  assert.match(locations.text, /No locations yet/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM locations').get().n, 0);

  // A second workspace cannot reuse the email address.
  const other = request.agent(store.app);
  const page2 = await other.get('/register');
  const res2 = await other.post('/register').type('form').send({
    _csrf: csrfFrom(page2.text),
    name: 'Someone',
    email: 'robin@fresh.test',
    password: 'password123',
  });
  assert.equal(res2.status, 400);
  assert.match(res2.text, /already uses that email/);
});

test('state-changing requests without a valid CSRF token are refused', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db);
  const item = makeQuantityItem(store.db, workspace.ctx);
  const agent = request.agent(store.app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const res = await agent
    .post(`/inventory/${item.itemId}/receive`)
    .type('form')
    .send({ skuId: item.skuId, locationId: workspace.main.id, quantity: 10, _csrf: 'not-the-token' })
    .set('Accept', 'application/json');
  assert.equal(res.status, 403);
  assert.equal(repo.getSkuTotal(store.db, workspace.workspaceId, item.skuId), 0);
});

test('signing out ends the session', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db);
  const agent = request.agent(store.app);
  const session = await signIn(agent, workspace.account.email, workspace.account.password);

  const token = await session.token('/');
  const out = await agent.post('/logout').type('form').send({ _csrf: token });
  assert.equal(out.status, 302);

  const after = await agent.get('/');
  assert.equal(after.status, 302);
  assert.ok(after.headers.location.startsWith('/login'));
});

test('staff cannot manage locations, people or the workspace', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db);
  const agent = request.agent(store.app);
  const staffEmail = workspace.staffEmail;
  const session = await signIn(agent, staffEmail, 'password123');
  const token = await session.token('/locations');

  const created = await agent
    .post('/locations')
    .type('form')
    .send({ _csrf: token, name: 'Sneaky Depot', kind: 'warehouse' })
    .set('Accept', 'application/json');
  assert.equal(created.status, 403);

  const renamed = await agent
    .post(`/locations/${workspace.main.id}`)
    .type('form')
    .send({ _csrf: token, name: 'Renamed', kind: 'store' })
    .set('Accept', 'application/json');
  assert.equal(renamed.status, 403);

  const archived = await agent
    .post(`/locations/${workspace.main.id}/archive`)
    .type('form')
    .send({ _csrf: token })
    .set('Accept', 'application/json');
  assert.equal(archived.status, 403);

  const person = await agent
    .post('/settings/people')
    .type('form')
    .send({ _csrf: token, name: 'Ghost', email: 'ghost@example.test', password: 'password123', role: 'owner' })
    .set('Accept', 'application/json');
  assert.equal(person.status, 403);

  const workspaceRename = await agent
    .post('/settings/workspace')
    .type('form')
    .send({ _csrf: token, name: 'Owned' })
    .set('Accept', 'application/json');
  assert.equal(workspaceRename.status, 403);

  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ?').get(workspace.workspaceId).n, 2);
  assert.equal(repo.requireLocation(store.db, workspace.workspaceId, workspace.main.id).name, 'Main Warehouse');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ?').get(workspace.workspaceId).n, 2);
});

test('staff can still do the day-to-day inventory work', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db);
  const item = makeQuantityItem(store.db, workspace.ctx);
  const staffEmail = workspace.staffEmail;
  const agent = request.agent(store.app);
  const session = await signIn(agent, staffEmail, 'password123');
  const token = await session.token(`/inventory/${item.itemId}`);

  const res = await agent
    .post(`/inventory/${item.itemId}/receive`)
    .type('form')
    .send({ _csrf: token, skuId: item.skuId, locationId: workspace.main.id, quantity: 25 });
  assert.equal(res.status, 303);
  assert.equal(repo.getSkuTotal(store.db, workspace.workspaceId, item.skuId), 25);

  const movement = store.db.prepare('SELECT * FROM movements ORDER BY seq DESC LIMIT 1').get();
  assert.equal(movement.actor_user_id, workspace.staffId, 'the ledger records who actually did it');
});

test('one workspace cannot reach another over HTTP', async () => {
  const store = makeApp();
  const a = seedWorkspace(store.db, { workspaceName: 'Acme' });
  const b = seedWorkspace(store.db, { workspaceName: 'Beacon' });
  const item = makeQuantityItem(store.db, a.ctx, { name: 'Acme Widget', baseCode: 'AW-9' });
  engine.receive(store.db, a.ctx, { skuId: item.skuId, locationId: a.main.id, quantity: 40 });

  const agent = request.agent(store.app);
  const session = await signIn(agent, b.account.email, b.account.password);
  const token = await session.token('/');

  const detail = await agent.get(`/inventory/${item.itemId}`);
  assert.equal(detail.status, 404);
  assert.doesNotMatch(detail.text, /Acme Widget/);

  const receive = await agent
    .post(`/inventory/${item.itemId}/receive`)
    .type('form')
    .send({ _csrf: token, skuId: item.skuId, locationId: a.main.id, quantity: 5 })
    .set('Accept', 'application/json');
  assert.equal(receive.status, 404);

  const list = await agent.get('/inventory');
  assert.doesNotMatch(list.text, /Acme Widget/);

  const search = await agent.get('/api/search?q=Acme').set('Accept', 'application/json');
  assert.deepEqual(search.body.results, []);

  const activity = await agent.get('/activity');
  assert.doesNotMatch(activity.text, /Acme Widget/);

  assert.equal(repo.getSkuTotal(store.db, a.workspaceId, item.skuId), 40, 'nothing changed for the other tenant');
});

test('an unknown item id is a plain 404, not a leak', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db);
  const agent = request.agent(store.app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const res = await agent.get('/inventory/item_does_not_exist');
  assert.equal(res.status, 404);
  assert.match(res.text, /could not be found/i);
});

/**
 * Clicking a nav item must land on that nav item.
 *
 * An empty inventory used to be redirected from Overview to Foundry setup,
 * which made the console feel broken: you click Overview, land on Foundry, and
 * the highlighted tab is not the one you pressed. The hand-off to Foundry
 * belongs at the moment an inventory is created, not on every later visit.
 */
test('every main nav destination renders where it says, even when empty', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Brand New' });
  store.db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
  store.db.prepare('DELETE FROM workspace_configuration WHERE workspace_id = ?').run(workspace.workspaceId);

  const agent = request.agent(store.app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  for (const path of ['/', '/attention', '/actions', '/inventory', '/locations', '/activity', '/settings']) {
    const res = await agent.get(path);
    assert.equal(res.status, 200, `${path} should render, not redirect (got ${res.status})`);
  }

  // And Overview says what is actually true about this inventory.
  const overview = plain((await agent.get('/')).text);
  assert.match(overview, /This inventory is empty/);
  assert.match(overview, /Set it up with Foundry/);
  assert.ok(!overview.includes("Today's briefing"), 'no briefing about nothing');
});

test('the entry screens say what Foundry is to somebody who has never seen it', async () => {
  // Both pages spoke only to people already using it — "your inventory, exactly
  // as your team left it" — leaving a stranger no way to tell what kind of
  // product this is before handing over an email address.
  const { app } = makeApp();

  for (const path of ['/login', '/register']) {
    const page = plain((await request(app).get(path)).text);
    assert.match(page, /Foundry runs your inventory/, `${path} says what it does`);
    assert.match(page, /handle the exceptions/, `${path} says what is left to you`);
    assert.match(page, /reorder|receiving|transfers/i, `${path} names real work`);
  }
});
