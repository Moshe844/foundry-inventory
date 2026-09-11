'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const locationService = require('../../src/domain/location-service');
const warehouse = require('../../src/warehouse/service');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function fixture() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Scan-first warehouse' });
  locationService.updateLocation(store.db, workspace.ctx, workspace.main.id, {
    name: workspace.main.name, kind: workspace.main.kind, barcode: 'WH-ROOT',
  });
  const dock = locationService.createLocation(store.db, workspace.ctx, {
    name: 'Inbound Dock', kind: 'dock', parentLocationId: workspace.main.id, barcode: 'DOCK-IN',
  });
  const bin = locationService.createLocation(store.db, workspace.ctx, {
    name: 'Shoe Bin 01', kind: 'bin', parentLocationId: workspace.main.id, barcode: 'BIN-SHOE-01',
  });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Warehouse Loafer', baseCode: 'LOAFER-35' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'mission5-http' });
  return { ...store, workspace, dock, bin, item, app };
}

test('the signed-in warehouse queue creates and executes a scan task visibly', async () => {
  const f = fixture();
  const agent = request.agent(f.app);
  await signIn(agent, f.workspace.account.email);

  const home = await agent.get('/warehouse');
  assert.equal(home.status, 200);
  assert.match(plain(home.text), /Work that starts with a scan/);
  assert.match(plain(home.text), /Existing stock remains at its existing location/);

  const created = await agent.post('/warehouse/tasks').type('form').send({
    _csrf: csrfFrom(home.text), taskType: 'RECEIVE', skuId: f.item.skuId,
    toLocationId: f.dock.id, quantity: 2, reference: 'PO-SCAN-1',
  });
  assert.equal(created.status, 303);
  assert.match(created.headers.location, /^\/warehouse\/tasks\/wht_/);

  const taskPage = await agent.get(created.headers.location);
  const taskId = created.headers.location.split('/').at(-1);
  assert.match(plain(taskPage.text), /Location, then product/);
  assert.match(plain(taskPage.text), /Unknown, wrong-location, wrong-lot and wrong-serial scans are rejected/);

  const rejected = await agent.post(`/warehouse/tasks/${taskId}/scans`).type('form').send({
    _csrf: csrfFrom(taskPage.text), clientScanId: 'browser-wrong-1',
    locationBarcode: 'WH-ROOT', itemBarcode: f.item.sku.code, quantity: 1,
  });
  assert.equal(rejected.status, 303);
  const afterReject = await agent.get(rejected.headers.location);
  assert.match(plain(afterReject.text), /belongs at Inbound Dock/);

  const accepted = await agent.post(`/warehouse/tasks/${taskId}/scans`).type('form').send({
    _csrf: csrfFrom(afterReject.text), clientScanId: 'browser-right-1',
    locationBarcode: 'DOCK-IN', itemBarcode: f.item.sku.code, quantity: 2,
  });
  assert.equal(accepted.status, 303);
  const completed = await agent.get(accepted.headers.location);
  assert.match(plain(completed.text), /COMPLETED/);
  assert.match(plain(completed.text), /Received 2 into Inbound Dock/);
  assert.equal(f.db.prepare('SELECT on_hand FROM balances WHERE sku_id = ? AND location_id = ?').get(f.item.skuId, f.dock.id).on_hand, 2);
});

test('warehouse pages enforce tenant and role permissions', async () => {
  const f = fixture();
  const owner = request.agent(f.app);
  await signIn(owner, f.workspace.account.email);
  const task = warehouse.createTask(f.db, f.workspace.ctx, { taskType: 'COUNT', lines: [{
    skuId: f.item.skuId, fromLocationId: f.bin.id, quantity: 1,
  }] });

  const staff = request.agent(f.app);
  await signIn(staff, f.workspace.staffEmail);
  const page = await staff.get(`/warehouse/tasks/${task.id}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(plain(page.text), /Accept scan/i,
    'a staff member without count-adjust authority must not be offered count scans');
  const deniedScan = await staff.post(`/warehouse/tasks/${task.id}/scans`).type('form')
    .send({ _csrf: csrfFrom(page.text), clientScanId: 'staff-count-denied',
      locationBarcode: f.bin.barcode, itemBarcode: f.item.code, quantity: 1 });
  assert.equal(deniedScan.status, 303);
  assert.equal(deniedScan.headers.location, '/');
  const deniedScanPage = await staff.get(deniedScan.headers.location);
  assert.match(plain(deniedScanPage.text), /do not have permission to scan and post warehouse counts/i);
  const finish = await staff.post(`/warehouse/tasks/${task.id}/count-finish`).type('form')
    .send({ _csrf: csrfFrom(page.text) });
  assert.equal(finish.status, 303);
  assert.equal(finish.headers.location, '/');
  const denied = await staff.get(finish.headers.location);
  assert.match(plain(denied.text), /do not have permission to post a warehouse count/i);

  const other = seedAnotherWorkspace(f.db, f.workspace.accountId, 'Other warehouse');
  const foreign = warehouse.createTask(f.db, other.ctx, { taskType: 'COUNT', lines: [{
    skuId: makeQuantityItem(f.db, other.ctx).skuId, fromLocationId: other.main.id, quantity: 1,
  }] });
  const notFound = await owner.get(`/warehouse/tasks/${foreign.id}`);
  assert.equal(notFound.status, 404);
});

test('location and product labels render a verified printable barcode', async () => {
  const f = fixture();
  const agent = request.agent(f.app);
  await signIn(agent, f.workspace.account.email);
  const locationLabel = await agent.get(`/warehouse/labels/location/${f.bin.id}`);
  assert.equal(locationLabel.status, 200);
  assert.match(locationLabel.text, /data-barcode="BIN-SHOE-01"/);
  assert.match(plain(locationLabel.text), /Encoding verified for scan round-trip/);
  const skuLabel = await agent.get(`/warehouse/labels/sku/${f.item.skuId}`);
  assert.match(skuLabel.text, /data-barcode="LOAFER-35"/);
});
