'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const itemService = require('../../src/domain/item-service');
const locationService = require('../../src/domain/location-service');
const activityService = require('../../src/domain/activity-service');
const searchService = require('../../src/domain/search-service');
const inventoryQuery = require('../../src/domain/inventory-query');
const authService = require('../../src/domain/auth-service');
const {
  makeDatabase,
  cleanupAll,
  seedWorkspace,
  makeQuantityItem,
  makeSerialItem,
  makeLotItem,
  lotsFor,
  unitsFor,
} = require('../helpers');

test.after(cleanupAll);

/** Two workspaces sharing one database: nothing may cross between them. */
function twoWorkspaces() {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'Acme Plumbing' });
  const b = seedWorkspace(db, { workspaceName: 'Beacon Retail' });

  const aItem = makeQuantityItem(db, a.ctx, { name: 'Acme Widget', baseCode: 'AW-1' });
  engine.receive(db, a.ctx, { skuId: aItem.skuId, locationId: a.main.id, quantity: 100 });

  const aSerial = makeSerialItem(db, a.ctx, { name: 'Acme Laptop', baseCode: 'AL-1' });
  engine.receive(db, a.ctx, {
    skuId: aSerial.skuId,
    locationId: a.main.id,
    serials: [{ serial: 'ACME-0001' }],
  });

  const aLot = makeLotItem(db, a.ctx, { name: 'Acme Ration', baseCode: 'AR-1' });
  engine.receive(db, a.ctx, { skuId: aLot.skuId, locationId: a.main.id, quantity: 50, lotCode: 'ACME-LOT-9' });

  const bItem = makeQuantityItem(db, b.ctx, { name: 'Beacon Widget', baseCode: 'BW-1' });
  engine.receive(db, b.ctx, { skuId: bItem.skuId, locationId: b.main.id, quantity: 7 });

  return { db, a, b, aItem, aSerial, aLot, bItem };
}

test('items, SKUs and locations cannot be read across workspaces', () => {
  const { db, a, b, aItem } = twoWorkspaces();

  assert.equal(repo.getItem(db, b.workspaceId, aItem.itemId), null);
  assert.equal(repo.getSku(db, b.workspaceId, aItem.skuId), null);
  assert.equal(repo.getLocation(db, b.workspaceId, a.main.id), null);
  assert.throws(() => repo.requireItem(db, b.workspaceId, aItem.itemId), (err) => err.code === 'not_found');
  assert.throws(() => itemService.getItemDetail(db, b.workspaceId, aItem.itemId), (err) => err.code === 'not_found');
});

test('another workspace cannot move your stock', () => {
  const { db, a, b, aItem } = twoWorkspaces();

  for (const call of [
    () => engine.receive(db, b.ctx, { skuId: aItem.skuId, locationId: a.main.id, quantity: 1 }),
    () => engine.issue(db, b.ctx, { skuId: aItem.skuId, locationId: a.main.id, quantity: 1 }),
    () =>
      engine.transfer(db, b.ctx, {
        skuId: aItem.skuId,
        fromLocationId: a.main.id,
        toLocationId: a.store.id,
        quantity: 1,
      }),
    () =>
      engine.adjust(db, b.ctx, {
        skuId: aItem.skuId,
        locationId: a.main.id,
        countedQty: 0,
        reasonCode: 'loss',
      }),
  ]) {
    assert.throws(call, (err) => err.code === 'not_found');
  }

  assert.equal(repo.getBalance(db, a.workspaceId, aItem.skuId, a.main.id), 100, 'balance untouched');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(b.workspaceId).n, 1);
});

test('stock cannot be sent into another workspace', () => {
  const { db, a, b, bItem } = twoWorkspaces();
  assert.throws(
    () =>
      engine.transfer(db, b.ctx, {
        skuId: bItem.skuId,
        fromLocationId: b.main.id,
        toLocationId: a.main.id,
        quantity: 1,
      }),
    (err) => err.code === 'not_found'
  );
  assert.equal(repo.getBalance(db, b.workspaceId, bItem.skuId, b.main.id), 7);
});

test('serial numbers and lots are invisible to other workspaces', () => {
  const { db, a, b, aSerial, aLot } = twoWorkspaces();
  const [unit] = unitsFor(db, a.workspaceId, aSerial.skuId);
  const [lot] = lotsFor(db, a.workspaceId, aLot.skuId);

  assert.equal(repo.getSerialUnit(db, b.workspaceId, unit.id), null);
  assert.equal(repo.getLot(db, b.workspaceId, lot.id), null);

  const found = searchService.search(db, b.workspaceId, 'ACME');
  assert.equal(found.results.length, 0);
  const foundLot = searchService.search(db, b.workspaceId, 'ACME-LOT-9');
  assert.equal(foundLot.results.length, 0);

  const own = searchService.search(db, a.workspaceId, 'ACME-0001');
  assert.equal(own.results.length, 1);
  assert.equal(own.results[0].type, 'serial');
});

test('the same serial number may exist in two different workspaces', () => {
  const { db, a, b } = twoWorkspaces();
  const bSerial = makeSerialItem(db, b.ctx, { name: 'Beacon Laptop', baseCode: 'BL-1' });
  engine.receive(db, b.ctx, {
    skuId: bSerial.skuId,
    locationId: b.main.id,
    serials: [{ serial: 'ACME-0001' }],
  });
  assert.equal(repo.getSkuTotal(db, b.workspaceId, bSerial.skuId), 1);
});

test('lists, activity and totals are scoped to one workspace', () => {
  const { db, a, b } = twoWorkspaces();

  const bItems = inventoryQuery.listItems(db, b.workspaceId, {}).items;
  assert.equal(bItems.length, 1);
  assert.equal(bItems[0].name, 'Beacon Widget');

  const bActivity = activityService.listActivity(db, b.workspaceId, {});
  assert.equal(bActivity.groups.length, 1);
  assert.ok(bActivity.groups[0].sentence.includes('Beacon Widget'));

  const bOverview = inventoryQuery.overview(db, b.workspaceId);
  assert.equal(bOverview.unitsOnHand, 7);
  assert.equal(bOverview.itemCount, 1);
  assert.equal(bOverview.locationCount, 2);

  const bLocations = locationService.listLocationsWithStock(db, b.workspaceId);
  assert.equal(bLocations.length, 2);
  assert.equal(bLocations.reduce((sum, l) => sum + l.on_hand, 0), 7);
});

test('users of one workspace are not listed by another', () => {
  const { db, a, b } = twoWorkspaces();
  const aUsers = authService.listUsers(db, a.workspaceId).map((u) => u.email);
  const bUsers = authService.listUsers(db, b.workspaceId).map((u) => u.email);
  assert.equal(aUsers.length, 2);
  assert.equal(bUsers.length, 2);
  assert.equal(aUsers.filter((email) => bUsers.includes(email)).length, 0);
  assert.equal(authService.getUser(db, b.workspaceId, a.ownerId), null);
});

test('a workspace cannot edit or archive another workspace records', () => {
  const { db, a, b, aItem } = twoWorkspaces();
  assert.throws(
    () => itemService.updateItem(db, b.ctx, aItem.itemId, { name: 'Stolen' }),
    (err) => err.code === 'not_found'
  );
  assert.throws(
    () => locationService.updateLocation(db, b.ctx, a.main.id, { name: 'Stolen', kind: 'store' }),
    (err) => err.code === 'not_found'
  );
  assert.throws(
    () => locationService.setLocationActive(db, b.ctx, a.main.id, false),
    (err) => err.code === 'not_found'
  );
  assert.equal(repo.requireItem(db, a.workspaceId, aItem.itemId).name, 'Acme Widget');
});
