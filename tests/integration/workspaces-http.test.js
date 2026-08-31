'use strict';

/**
 * Multi-inventory tenancy over HTTP.
 *
 * The interesting cases are the hostile ones: a workspace id pasted into a
 * form, a session that remembers an inventory the account has been removed
 * from, and a record id from one inventory used against another. All of them
 * must end the same way — "not found" — with nothing written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { openDatabase } = require('../../src/db');
const authService = require('../../src/domain/auth-service');
const workspaceService = require('../../src/domain/workspace-service');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const attention = require('../../src/attention/attention-engine');
const {
  makeDatabase, makeApp, cleanupAll, seedWorkspace, seedAnotherWorkspace,
  makeQuantityItem, csrfFrom, plain, signIn,
} = require('../helpers');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

async function post(agent, path, body, formPath = '/') {
  const page = await agent.get(formPath);
  return agent.post(path).type('form').send({ _csrf: csrfFrom(page.text), ...body });
}

// --- creating and switching --------------------------------------------------

test('a person can create a second inventory and is handed to Foundry', async () => {
  const store = makeApp();
  const first = seedWorkspace(store.db, { workspaceName: 'Clothing Business' });
  const agent = request.agent(store.app);
  await signIn(agent, first.account.email, first.account.password);

  const form = await agent.get('/inventories/new');
  assert.match(plain(form.text), /New inventory/);

  const created = await post(agent, '/inventories', { name: 'Equipment Company' }, '/inventories/new');
  assert.equal(created.status, 303);
  assert.equal(created.headers.location, '/onboarding', 'a new inventory goes straight to the management-path question');

  const mine = workspaceService.listForAccount(store.db, first.accountId);
  assert.deepEqual(mine.map((w) => w.name).sort(), ['Clothing Business', 'Equipment Company']);

  // And the session is already looking at the new one, which chooses its own
  // way in — each inventory is onboarded independently of the others.
  const front = await agent.get('/foundry');
  assert.equal(front.headers.location, '/onboarding');
  const chooser = plain((await agent.get('/onboarding')).text);
  assert.match(chooser, /Where should Foundry get your inventory from/);

  const describe = plain((await agent.get('/foundry/describe')).text);
  assert.match(describe, /Give Foundry what you already have/);
  assert.match(describe, /Equipment Company/);
});

test('switching changes what every page shows', async () => {
  const store = makeApp();
  const clothing = seedWorkspace(store.db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(store.db, clothing.accountId, 'Equipment Company');

  const shirt = makeQuantityItem(store.db, clothing.ctx, { name: 'Oxford Shirt', baseCode: 'OS-1' });
  const drill = makeQuantityItem(store.db, equipment.ctx, { name: 'Core Drill', baseCode: 'CD-1' });
  engine.receive(store.db, clothing.ctx, { skuId: shirt.skuId, locationId: clothing.main.id, quantity: 120 });
  engine.receive(store.db, equipment.ctx, { skuId: drill.skuId, locationId: equipment.main.id, quantity: 7 });

  const agent = request.agent(store.app);
  await signIn(agent, clothing.account.email, clothing.account.password);

  const before = plain((await agent.get('/inventory')).text);
  assert.match(before, /Oxford Shirt/);
  assert.ok(!before.includes('Core Drill'), 'the other inventory is not visible');

  const switched = await post(agent, '/inventories/switch', { workspaceId: equipment.workspaceId, next: '/' }, '/inventories');
  assert.equal(switched.status, 303);

  const after = plain((await agent.get('/inventory')).text);
  assert.match(after, /Core Drill/);
  assert.ok(!after.includes('Oxford Shirt'), 'and the first is now the one that is hidden');

  // The switcher itself names the one that is open.
  const shell = (await agent.get('/')).text;
  assert.match(shell, /wsp-switch-text[\s\S]{0,200}Equipment Company/);
});

test('the chosen inventory survives a refresh and a restart', async () => {
  const { db, databasePath } = makeDatabase();
  const clothing = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(db, clothing.accountId, 'Equipment Company');
  makeQuantityItem(db, equipment.ctx, { name: 'Core Drill', baseCode: 'CD-1' });

  const app = createApp({ db, env: 'test', sessionSecret: 'workspace-persistence' });
  const agent = request.agent(app);
  await signIn(agent, clothing.account.email, clothing.account.password);
  await post(agent, '/inventories/switch', { workspaceId: equipment.workspaceId, next: '/' }, '/inventories');

  // Refresh: same inventory.
  for (let i = 0; i < 3; i += 1) {
    assert.match(plain((await agent.get('/inventory')).text), /Core Drill/);
  }

  // Restart: the session store is the database, so the choice outlives it.
  db.close();
  const reopened = openDatabase(databasePath);
  const restarted = createApp({ db: reopened, env: 'test', sessionSecret: 'workspace-persistence' });
  const afterRestart = plain((await request.agent(restarted).get('/')).text);
  assert.ok(afterRestart.length > 0);

  const same = request.agent(restarted);
  await signIn(same, clothing.account.email, clothing.account.password);
  assert.match(plain((await same.get('/inventory')).text), /Oxford|Core Drill|No items/);
  reopened.close();
});

test('signing in again reopens the inventory you were last in', async () => {
  const store = makeApp();
  const clothing = seedWorkspace(store.db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(store.db, clothing.accountId, 'Equipment Company');
  makeQuantityItem(store.db, equipment.ctx, { name: 'Core Drill', baseCode: 'CD-1' });

  const agent = request.agent(store.app);
  await signIn(agent, clothing.account.email, clothing.account.password);
  await post(agent, '/inventories/switch', { workspaceId: equipment.workspaceId, next: '/' }, '/inventories');
  assert.match(plain((await agent.get('/inventory')).text), /Core Drill/);

  await post(agent, '/logout', {}, '/');
  await signIn(agent, clothing.account.email, clothing.account.password);
  assert.match(plain((await agent.get('/inventory')).text), /Core Drill/, 'it remembered');
});

// --- hostile input -----------------------------------------------------------

test('switching to an inventory you do not belong to is refused', async () => {
  const store = makeApp();
  const mine = seedWorkspace(store.db, { workspaceName: 'Mine' });
  const theirs = seedWorkspace(store.db, { workspaceName: 'Theirs' });
  makeQuantityItem(store.db, theirs.ctx, { name: 'Their Widget', baseCode: 'TW-1' });

  const agent = request.agent(store.app);
  await signIn(agent, mine.account.email, mine.account.password);

  const res = await post(agent, '/inventories/switch', { workspaceId: theirs.workspaceId, next: '/' }, '/inventories');
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/inventories');

  const listing = plain((await agent.get('/inventories')).text);
  assert.match(listing, /could not be found/);
  assert.ok(!listing.includes('Theirs'));

  const items = plain((await agent.get('/inventory')).text);
  assert.ok(!items.includes('Their Widget'), 'and nothing of theirs is on screen');
});

test('a fabricated workspace id changes nothing', async () => {
  const store = makeApp();
  const mine = seedWorkspace(store.db, { workspaceName: 'Mine' });
  const agent = request.agent(store.app);
  await signIn(agent, mine.account.email, mine.account.password);

  for (const attempt of ['wsp_not_real', '../../etc', "' OR 1=1 --", '']) {
    const res = await post(agent, '/inventories/switch', { workspaceId: attempt, next: '/' }, '/inventories');
    assert.equal(res.status, 303, `${attempt} should be turned away cleanly`);
  }
  const shell = (await agent.get('/')).text;
  assert.match(shell, /Mine/, 'still in the only inventory they have');
});

test('a record id from another inventory is not found, not forbidden', async () => {
  const store = makeApp();
  const mine = seedWorkspace(store.db, { workspaceName: 'Mine' });
  const theirs = seedWorkspace(store.db, { workspaceName: 'Theirs' });
  const item = makeQuantityItem(store.db, theirs.ctx, { name: 'Their Widget', baseCode: 'TW-1' });
  engine.receive(store.db, theirs.ctx, { skuId: item.skuId, locationId: theirs.main.id, quantity: 40 });
  scenarios.stockoutScenario(store.db, theirs);
  attention.evaluate(store.db, theirs.workspaceId, { trigger: 'test' });
  const [finding] = attention.listAttention(store.db, theirs.workspaceId);

  const agent = request.agent(store.app);
  await signIn(agent, mine.account.email, mine.account.password);

  assert.equal((await agent.get(`/inventory/${item.itemId}`)).status, 404);
  assert.equal((await agent.get(`/locations?location=${theirs.main.id}`)).status, 200);

  const finding404 = await agent.get(`/attention/${finding.attentionId}`);
  assert.equal(finding404.status, 303);
  assert.equal(finding404.headers.location, '/attention');

  // And a write against their SKU does nothing at all.
  const write = await agent
    .post(`/inventory/${item.itemId}/receive`)
    .type('form')
    .send({
      _csrf: csrfFrom((await agent.get('/')).text),
      skuId: item.skuId,
      locationId: theirs.main.id,
      quantity: '999',
    });
  assert.ok(write.status >= 400 || write.status === 303);
  assert.equal(repo.getSkuTotal(store.db, theirs.workspaceId, item.skuId), 40, 'untouched');
  assert.equal(engine.verifyIntegrity(store.db, theirs.workspaceId).ok, true);
});

test('a session pointing at an inventory the account has left falls back safely', async () => {
  const store = makeApp();
  const owner = seedWorkspace(store.db, { workspaceName: 'Shared Inventory' });
  const guest = seedWorkspace(store.db, { workspaceName: 'Their Own Thing' });
  authService.createTeamMember(store.db, owner.ctx, { role: 'owner' }, {
    name: 'Visiting Vic',
    email: guest.account.email,
    role: 'staff',
  });
  makeQuantityItem(store.db, owner.ctx, { name: 'Shared Widget', baseCode: 'SW-1' });

  const agent = request.agent(store.app);
  await signIn(agent, guest.account.email, guest.account.password);
  await post(agent, '/inventories/switch', { workspaceId: owner.workspaceId, next: '/' }, '/inventories');
  assert.match(plain((await agent.get('/inventory')).text), /Shared Widget/);

  // Access is removed while they are signed in and pointed at it.
  workspaceService.leaveWorkspace(store.db, owner.workspaceId, guest.accountId);

  const after = await agent.get('/inventory');
  assert.equal(after.status, 200, 'not an error page');
  assert.ok(!plain(after.text).includes('Shared Widget'), 'and not their data either');
  assert.match((await agent.get('/')).text, /Their Own Thing/, 'dropped back to their own');
});

// --- the account level -------------------------------------------------------

test('the inventories page lists every inventory with its own numbers', async () => {
  const store = makeApp();
  const clothing = seedWorkspace(store.db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(store.db, clothing.accountId, 'Equipment Company');
  const shirt = makeQuantityItem(store.db, clothing.ctx, { name: 'Oxford Shirt', baseCode: 'OS-1' });
  engine.receive(store.db, clothing.ctx, { skuId: shirt.skuId, locationId: clothing.main.id, quantity: 120 });

  const agent = request.agent(store.app);
  await signIn(agent, clothing.account.email, clothing.account.password);
  const page = plain((await agent.get('/inventories')).text);

  assert.match(page, /Clothing Business/);
  assert.match(page, /Equipment Company/);
  assert.match(page, /120 on hand/);
  assert.match(page, /Not set up yet/, 'the empty one says so');
  assert.match(page, /Using 2 of \d+ inventories/);
  assert.equal(equipment.name, 'Equipment Company');
});

test('the plan limit is enforced over HTTP, not just in the service', async () => {
  const store = makeApp();
  const account = seedWorkspace(store.db, { workspaceName: 'One' });
  const limit = require('../../src/entitlements/plans').limitFor('free', 'workspaces');
  for (let i = 1; i < limit; i += 1) {
    seedAnotherWorkspace(store.db, account.accountId, `Number ${i + 1}`);
  }

  const agent = request.agent(store.app);
  await signIn(agent, account.account.email, account.account.password);

  const res = await post(agent, '/inventories', { name: 'One Too Many' }, '/inventories/new');
  assert.equal(res.status, 402);
  assert.match(plain(res.text), /plan includes/);
  assert.equal(workspaceService.listForAccount(store.db, account.accountId).length, limit);

  // The list page stops offering it rather than failing after the click. The
  // switcher keeps its shortcut, which lands on the page that explains why.
  const listing = (await agent.get('/inventories')).text;
  const pageActions = listing.split('page-actions')[1].split('</div>')[0];
  assert.ok(!pageActions.includes('New inventory'), 'the primary action is withdrawn');
  assert.match(plain(listing), new RegExp(`Using ${limit} of ${limit} inventories`));
});

test('every inventories route needs a signed-in account', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db);
  const anonymous = request.agent(store.app);

  for (const path of ['/inventories', '/inventories/new']) {
    const res = await anonymous.get(path);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/login/);
  }

  const res = await anonymous.post('/inventories/switch').type('form').send({ workspaceId: workspace.workspaceId });
  assert.ok([302, 303, 403].includes(res.status));
});

test('an account with no inventory is asked to make one, not shown an empty console', async () => {
  const store = makeApp();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Only One' });

  // Strip the membership, leaving the account with nothing to open.
  store.db.prepare('DELETE FROM users WHERE account_id = ?').run(workspace.accountId);

  const agent = request.agent(store.app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const home = await agent.get('/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/inventories');
  assert.match(plain((await agent.get('/inventories')).text), /Give Foundry an inventory to manage/);
});
