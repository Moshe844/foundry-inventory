'use strict';

/** The four operations driven the way the browser drives them: real forms. */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const repo = require('../../src/domain/repository');
const engine = require('../../src/domain/inventory-engine');
const { makeApp, cleanupAll, seedWorkspace, csrfFrom, plain, signIn, lotsFor, unitsFor } = require('../helpers');

test.after(cleanupAll);

async function signedInWorkspace() {
  const store = makeApp();
  const workspace = seedWorkspace(store.db);
  const agent = request.agent(store.app);
  const session = await signIn(agent, workspace.account.email, workspace.account.password);
  return { ...store, workspace, agent, session };
}

async function post(agent, path, body, formPath = '/') {
  const page = await agent.get(formPath);
  const token = csrfFrom(page.text);
  return agent.post(path).type('form').send({ _csrf: token, ...body });
}

test('a quantity item can be created and run through every operation', async () => {
  const { db, workspace, agent } = await signedInWorkspace();

  const created = await post(agent, '/inventory', {
    name: 'Copper Elbow',
    baseCode: 'CE-100',
    unitLabel: 'unit',
    trackingMode: 'quantity',
  }, '/inventory/new');
  assert.equal(created.status, 303);
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  assert.equal(sku.code, 'CE-100');

  const itemPage = `/inventory/${itemId}`;

  await post(agent, `${itemPage}/receive`, { skuId: sku.id, locationId: workspace.main.id, quantity: 100 }, itemPage);
  assert.equal(repo.getBalance(db, workspace.workspaceId, sku.id, workspace.main.id), 100);

  await post(agent, `${itemPage}/transfer`, {
    skuId: sku.id,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    quantity: 25,
  }, itemPage);
  assert.equal(repo.getBalance(db, workspace.workspaceId, sku.id, workspace.main.id), 75);
  assert.equal(repo.getBalance(db, workspace.workspaceId, sku.id, workspace.store.id), 25);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, sku.id), 100);

  await post(agent, `${itemPage}/issue`, {
    skuId: sku.id,
    locationId: workspace.store.id,
    quantity: 5,
    reasonCode: 'sold',
  }, itemPage);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, sku.id), 95);

  await post(agent, `${itemPage}/adjust`, {
    skuId: sku.id,
    locationId: workspace.main.id,
    countedQty: 72,
    reasonCode: 'physical_count',
    notes: 'Counted on Friday.',
  }, itemPage);
  assert.equal(repo.getBalance(db, workspace.workspaceId, sku.id, workspace.main.id), 72);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, sku.id), 92);

  const page = plain((await agent.get(itemPage)).text);
  assert.match(page, /Copper Elbow/);
  assert.match(page, /Adjusted Copper Elbow at Main Warehouse from 75 to 72\./);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('a failed operation shows a message and changes nothing', async () => {
  const { db, workspace, agent } = await signedInWorkspace();
  const created = await post(agent, '/inventory', {
    name: 'Short Item',
    trackingMode: 'quantity',
  }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  const itemPage = `/inventory/${itemId}`;

  await post(agent, `${itemPage}/receive`, { skuId: sku.id, locationId: workspace.main.id, quantity: 3 }, itemPage);
  const failed = await post(agent, `${itemPage}/issue`, {
    skuId: sku.id,
    locationId: workspace.main.id,
    quantity: 10,
  }, itemPage);

  assert.equal(failed.status, 303, 'the user is sent back to the page they were on');
  assert.equal(repo.getBalance(db, workspace.workspaceId, sku.id, workspace.main.id), 3);

  const page = await agent.get(itemPage);
  assert.match(page.text, /Not enough stock/);
});

test('a variant item is created with one SKU per combination and tracked apart', async () => {
  const { db, workspace, agent } = await signedInWorkspace();

  const created = await post(agent, '/inventory', {
    name: "Children's Sweater",
    baseCode: 'CS-200',
    trackingMode: 'quantity',
    hasVariants: '1',
    'options[0][name]': 'Colour',
    'options[0][values]': 'Navy, Cream',
    'options[1][name]': 'Size',
    'options[1][values]': '4, 5',
  }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const skus = repo.listSkusForItem(db, workspace.workspaceId, itemId);
  assert.equal(skus.length, 4);

  const navy4 = skus.find((s) => s.variant_label === 'Navy / 4');
  const navy5 = skus.find((s) => s.variant_label === 'Navy / 5');
  const itemPage = `/inventory/${itemId}`;

  await post(agent, `${itemPage}/receive`, { skuId: navy4.id, locationId: workspace.store.id, quantity: 12 }, itemPage);
  await post(agent, `${itemPage}/receive`, { skuId: navy5.id, locationId: workspace.store.id, quantity: 8 }, itemPage);

  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, navy4.id), 12);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, navy5.id), 8);

  const page = await agent.get(itemPage);
  assert.match(page.text, /Navy \/ 4/);
  assert.match(page.text, /Cream \/ 5/);
  assert.match(page.text, /Variants/);
});

test('a serialized item is received, moved and shown by serial number', async () => {
  const { db, workspace, agent } = await signedInWorkspace();

  const created = await post(agent, '/inventory', {
    name: 'Dell Latitude',
    baseCode: 'DL-5450',
    trackingMode: 'serial',
  }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  const itemPage = `/inventory/${itemId}`;

  await post(agent, `${itemPage}/receive`, {
    skuId: sku.id,
    locationId: workspace.main.id,
    serials: 'DL-829193\nDL-829194',
    condition: 'good',
  }, itemPage);

  const units = unitsFor(db, workspace.workspaceId, sku.id);
  assert.equal(units.length, 2);

  await post(agent, `${itemPage}/transfer`, {
    skuId: sku.id,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    serialUnitIds: units[0].id,
  }, itemPage);

  assert.equal(repo.getBalance(db, workspace.workspaceId, sku.id, workspace.main.id), 1);
  assert.equal(repo.getBalance(db, workspace.workspaceId, sku.id, workspace.store.id), 1);

  const page = await agent.get(itemPage);
  assert.match(page.text, /DL-829193/);
  assert.match(page.text, /In stock/);

  // The same serial cannot be received again while it is active.
  const duplicate = await post(agent, `${itemPage}/receive`, {
    skuId: sku.id,
    locationId: workspace.main.id,
    serials: 'DL-829193',
  }, itemPage);
  assert.equal(duplicate.status, 303);
  const after = await agent.get(itemPage);
  assert.match(after.text, /already in stock/);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, sku.id), 2);
});

test('a lot-tracked item exposes its lots and moves stock lot by lot', async () => {
  const { db, workspace, agent } = await signedInWorkspace();

  const created = await post(agent, '/inventory', {
    name: 'Trail Ration Pack',
    baseCode: 'FOOD-200',
    trackingMode: 'lot',
  }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  const itemPage = `/inventory/${itemId}`;

  await post(agent, `${itemPage}/receive`, {
    skuId: sku.id,
    locationId: workspace.main.id,
    quantity: 84,
    lotCode: 'L240812',
    expiresAt: '2026-10-30',
  }, itemPage);
  await post(agent, `${itemPage}/receive`, {
    skuId: sku.id,
    locationId: workspace.main.id,
    quantity: 120,
    lotCode: 'L240902',
  }, itemPage);

  const lots = lotsFor(db, workspace.workspaceId, sku.id);
  assert.equal(lots.length, 2);

  await post(agent, `${itemPage}/transfer`, {
    skuId: sku.id,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    lotId: lots[0].id,
    quantity: 24,
  }, itemPage);

  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[0].id, workspace.store.id), 24);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[1].id, workspace.store.id), 0);

  const page = await agent.get(itemPage);
  assert.match(page.text, /L240812/);
  assert.match(page.text, /L240902/);
  assert.match(page.text, /Oct 30, 2026/);

  const tooMuch = await post(agent, `${itemPage}/issue`, {
    skuId: sku.id,
    locationId: workspace.main.id,
    lotId: lots[0].id,
    quantity: 61,
  }, itemPage);
  assert.equal(tooMuch.status, 303);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[0].id, workspace.main.id), 60);
  const afterPage = await agent.get(itemPage);
  assert.match(afterPage.text, /only has 60/);
});

test('search results lead straight to the right record', async () => {
  const { db, workspace, agent } = await signedInWorkspace();
  const created = await post(agent, '/inventory', { name: 'Dell Latitude', baseCode: 'DL-1', trackingMode: 'serial' }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  await post(agent, `/inventory/${itemId}/receive`, {
    skuId: sku.id,
    locationId: workspace.main.id,
    serials: 'SN-4242',
  }, `/inventory/${itemId}`);

  const api = await agent.get('/api/search?q=SN-4242').set('Accept', 'application/json');
  assert.equal(api.status, 200);
  const hit = api.body.results.find((r) => r.type === 'serial');
  assert.ok(hit);
  assert.ok(hit.href.startsWith(`/inventory/${itemId}`));

  const page = await agent.get('/search?q=SN-4242');
  assert.equal(page.status, 200);
  assert.match(page.text, /SN-4242/);
});

test('the activity page filters by item, operation and location', async () => {
  const { db, workspace, agent } = await signedInWorkspace();
  const created = await post(agent, '/inventory', { name: 'Widget', baseCode: 'W-1', trackingMode: 'quantity' }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  const itemPage = `/inventory/${itemId}`;

  await post(agent, `${itemPage}/receive`, { skuId: sku.id, locationId: workspace.main.id, quantity: 10 }, itemPage);
  await post(agent, `${itemPage}/issue`, { skuId: sku.id, locationId: workspace.main.id, quantity: 2 }, itemPage);

  const all = plain((await agent.get('/activity')).text);
  assert.match(all, /Received 10 × Widget into Main Warehouse\./);
  assert.match(all, /Issued 2 × Widget from Main Warehouse\./);

  const onlyIssues = plain((await agent.get('/activity?operation=issue')).text);
  assert.doesNotMatch(onlyIssues, /Received 10 × Widget/);
  assert.match(onlyIssues, /Issued 2 × Widget/);

  const otherLocation = await agent.get(`/activity?location=${workspace.store.id}`);
  assert.match(otherLocation.text, /No movements match/);
});

test('locations can be added, edited and archived by an owner', async () => {
  const { db, workspace, agent } = await signedInWorkspace();

  await post(agent, '/locations', { name: 'Service Van 3', kind: 'truck', note: 'Tuesday route' }, '/locations');
  const created = db
    .prepare('SELECT * FROM locations WHERE workspace_id = ? AND name = ?')
    .get(workspace.workspaceId, 'Service Van 3');
  assert.ok(created);
  assert.equal(created.kind, 'truck');

  const duplicate = await post(agent, '/locations', { name: 'Service Van 3', kind: 'truck' }, '/locations');
  assert.equal(duplicate.status, 303);
  const page = await agent.get('/locations');
  assert.match(page.text, /already exists/);

  await post(agent, `/locations/${created.id}`, { name: 'Service Van 03', kind: 'truck' }, '/locations');
  assert.equal(repo.requireLocation(db, workspace.workspaceId, created.id).name, 'Service Van 03');

  await post(agent, `/locations/${created.id}/archive`, {}, '/locations');
  assert.equal(repo.requireLocation(db, workspace.workspaceId, created.id).is_active, 0);
});

test('a location holding stock cannot be archived', async () => {
  const { db, workspace, agent } = await signedInWorkspace();
  const created = await post(agent, '/inventory', { name: 'Widget', baseCode: 'W-2', trackingMode: 'quantity' }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  await post(agent, `/inventory/${itemId}/receive`, { skuId: sku.id, locationId: workspace.main.id, quantity: 5 }, `/inventory/${itemId}`);

  await post(agent, `/locations/${workspace.main.id}/archive`, {}, '/locations');
  assert.equal(repo.requireLocation(db, workspace.workspaceId, workspace.main.id).is_active, 1);
  const page = await agent.get('/locations');
  assert.match(page.text, /still holds 5 units/);
});

test('an item holding stock cannot be archived', async () => {
  const { db, workspace, agent } = await signedInWorkspace();
  const created = await post(agent, '/inventory', { name: 'Widget', baseCode: 'W-3', trackingMode: 'quantity' }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  const itemPage = `/inventory/${itemId}`;
  await post(agent, `${itemPage}/receive`, { skuId: sku.id, locationId: workspace.main.id, quantity: 5 }, itemPage);

  await post(agent, `${itemPage}/archive`, {}, itemPage);
  assert.equal(repo.requireItem(db, workspace.workspaceId, itemId).is_active, 1);
  const page = await agent.get(itemPage);
  assert.match(page.text, /still has 5 on hand/);

  await post(agent, `${itemPage}/issue`, { skuId: sku.id, locationId: workspace.main.id, quantity: 5 }, itemPage);
  await post(agent, `${itemPage}/archive`, {}, itemPage);
  assert.equal(repo.requireItem(db, workspace.workspaceId, itemId).is_active, 0);
});

test('the settings page reports inventory integrity', async () => {
  const { db, workspace, agent } = await signedInWorkspace();
  const created = await post(agent, '/inventory', { name: 'Widget', baseCode: 'W-4', trackingMode: 'quantity' }, '/inventory/new');
  const itemId = created.headers.location.replace('/inventory/', '');
  const sku = repo.listSkusForItem(db, workspace.workspaceId, itemId)[0];
  await post(agent, `/inventory/${itemId}/receive`, { skuId: sku.id, locationId: workspace.main.id, quantity: 5 }, `/inventory/${itemId}`);

  const page = await agent.get('/settings');
  assert.equal(page.status, 200);
  assert.match(page.text, /Every balance matches its movement history/);
});
