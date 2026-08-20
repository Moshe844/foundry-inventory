'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../src/domain/inventory-engine');
const activityService = require('../../src/domain/activity-service');
const searchService = require('../../src/domain/search-service');
const inventoryQuery = require('../../src/domain/inventory-query');
const {
  makeDatabase,
  cleanupAll,
  seedWorkspace,
  makeQuantityItem,
  makeVariantItem,
  makeSerialItem,
  makeLotItem,
  lotsFor,
  unitsFor,
} = require('../helpers');

test.after(cleanupAll);

function busyWorkspace() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);

  const elbow = makeQuantityItem(db, workspace.ctx, { name: 'Copper Elbow', baseCode: 'CE-100' });
  engine.receive(db, workspace.ctx, { skuId: elbow.skuId, locationId: workspace.main.id, quantity: 50 });
  engine.transfer(db, workspace.ctx, {
    skuId: elbow.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    quantity: 20,
  });

  const sweater = makeVariantItem(db, workspace.ctx);
  const navy4 = sweater.byLabel('Navy / 4');
  engine.receive(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.store.id, quantity: 13 });
  engine.adjust(db, workspace.ctx, {
    skuId: navy4.id,
    locationId: workspace.store.id,
    countedQty: 11,
    reasonCode: 'physical_count',
  });

  const laptop = makeSerialItem(db, workspace.ctx, { name: 'Dell Latitude', baseCode: 'DL-5450' });
  engine.receive(db, workspace.ctx, {
    skuId: laptop.skuId,
    locationId: workspace.main.id,
    serials: [{ serial: 'DL-829193' }],
  });
  const [unit] = unitsFor(db, workspace.workspaceId, laptop.skuId);
  engine.transfer(db, workspace.ctx, {
    skuId: laptop.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    serialUnitIds: [unit.id],
  });

  const rations = makeLotItem(db, workspace.ctx, { name: 'Trail Ration Pack', baseCode: 'FOOD-200' });
  engine.receive(db, workspace.ctx, {
    skuId: rations.skuId,
    locationId: workspace.main.id,
    quantity: 84,
    lotCode: 'L240812',
    expiresAt: '2026-10-30',
  });
  const [lot] = lotsFor(db, workspace.workspaceId, rations.skuId);
  engine.issue(db, workspace.ctx, {
    skuId: rations.skuId,
    locationId: workspace.main.id,
    lotId: lot.id,
    quantity: 4,
    reasonCode: 'damaged',
  });

  return { db, workspace, elbow, sweater, laptop, rations, unit, lot };
}

test('the ledger reads as plain sentences', () => {
  const { db, workspace } = busyWorkspace();
  const { groups } = activityService.listActivity(db, workspace.workspaceId, { limit: 50 });
  const sentences = groups.map((g) => g.sentence);

  assert.ok(sentences.some((s) => s === 'Received 50 × Copper Elbow into Main Warehouse.'), sentences.join('\n'));
  assert.ok(
    sentences.some((s) => s === 'Transferred 20 × Copper Elbow from Main Warehouse to Downtown Store.'),
    sentences.join('\n')
  );
  assert.ok(
    sentences.some((s) => s === "Adjusted Children's Sweater / Navy / 4 at Downtown Store from 13 to 11."),
    sentences.join('\n')
  );
  assert.ok(
    sentences.some((s) => s === 'Transferred 1 × Dell Latitude (DL-829193) from Main Warehouse to Downtown Store.'),
    sentences.join('\n')
  );
  assert.ok(
    sentences.some((s) => s === 'Issued 4 × Trail Ration Pack from lot L240812 from Main Warehouse.'),
    sentences.join('\n')
  );
});

test('a transfer appears once, not as two half movements', () => {
  const { db, workspace, elbow } = busyWorkspace();
  const { groups } = activityService.listActivity(db, workspace.workspaceId, { itemId: elbow.itemId });
  const transfers = groups.filter((g) => g.operation === 'transfer');
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].quantity, 20);
  assert.equal(transfers[0].fromLocation, 'Main Warehouse');
  assert.equal(transfers[0].toLocation, 'Downtown Store');
  assert.equal(transfers[0].legs.length, 2, 'both audit rows are still there underneath');
});

test('every entry carries actor, time, operation and reason', () => {
  const { db, workspace } = busyWorkspace();
  const { groups } = activityService.listActivity(db, workspace.workspaceId, { limit: 50 });
  for (const entry of groups) {
    assert.ok(entry.actorName, 'actor');
    assert.ok(entry.occurredAt, 'timestamp');
    assert.ok(['receive', 'issue', 'transfer', 'adjust'].includes(entry.operation));
    assert.ok(entry.itemId && entry.skuId);
  }
  const adjustment = groups.find((g) => g.operation === 'adjust');
  assert.equal(adjustment.reasonLabel, 'Physical count');
  assert.equal(adjustment.expected, 13);
  assert.equal(adjustment.counted, 11);
});

test('activity can be filtered by item, location, operation, person and date', () => {
  const { db, workspace, elbow } = busyWorkspace();

  assert.equal(activityService.listActivity(db, workspace.workspaceId, { itemId: elbow.itemId }).groups.length, 2);
  assert.equal(activityService.listActivity(db, workspace.workspaceId, { operation: 'adjust' }).groups.length, 1);
  assert.equal(activityService.listActivity(db, workspace.workspaceId, { operation: 'transfer' }).groups.length, 2);
  assert.equal(activityService.listActivity(db, workspace.workspaceId, { actorId: workspace.ownerId }).groups.length, 8);
  assert.equal(activityService.listActivity(db, workspace.workspaceId, { actorId: workspace.staffId }).groups.length, 0);

  const atStore = activityService.listActivity(db, workspace.workspaceId, { locationId: workspace.store.id }).groups;
  assert.ok(atStore.length > 0);
  assert.ok(atStore.every((g) => g.legs.some((l) => l.location_id === workspace.store.id)));

  const today = new Date().toISOString().slice(0, 10);
  assert.ok(activityService.listActivity(db, workspace.workspaceId, { dateFrom: today }).groups.length > 0);
  assert.equal(activityService.listActivity(db, workspace.workspaceId, { dateTo: '2020-01-01' }).groups.length, 0);
});

test('activity pages without losing or repeating entries', () => {
  const { db, workspace } = busyWorkspace();
  const total = activityService.countActivity(db, workspace.workspaceId, {});
  const first = activityService.listActivity(db, workspace.workspaceId, { limit: 3, offset: 0 });
  const second = activityService.listActivity(db, workspace.workspaceId, { limit: 3, offset: 3 });

  assert.equal(first.groups.length, 3);
  assert.equal(first.hasMore, true);
  const ids = new Set([...first.groups, ...second.groups].map((g) => g.groupId));
  assert.equal(ids.size, Math.min(6, total));
});

test('search finds items, variants, serial numbers and lots', () => {
  const { db, workspace, laptop, rations } = busyWorkspace();

  const byName = searchService.search(db, workspace.workspaceId, 'Copper');
  assert.equal(byName.results[0].type, 'item');
  assert.ok(byName.results[0].href.startsWith('/inventory/'));

  const byCode = searchService.search(db, workspace.workspaceId, 'CE-100');
  assert.ok(byCode.results.some((r) => r.title === 'Copper Elbow'));

  const byVariant = searchService.search(db, workspace.workspaceId, 'Navy');
  assert.ok(byVariant.results.some((r) => r.type === 'variant' && r.title.includes('Navy / 4')));

  const bySerial = searchService.search(db, workspace.workspaceId, 'DL-829193');
  const serialHit = bySerial.results.find((r) => r.type === 'serial');
  assert.ok(serialHit);
  assert.equal(serialHit.title, 'DL-829193');
  assert.ok(serialHit.href.includes(laptop.itemId));
  assert.ok(serialHit.meta.includes('Downtown Store'));

  const byLot = searchService.search(db, workspace.workspaceId, 'L240812');
  const lotHit = byLot.results.find((r) => r.type === 'lot');
  assert.ok(lotHit);
  assert.ok(lotHit.href.includes(rations.itemId));
  assert.ok(lotHit.meta.includes('80'));

  assert.equal(searchService.search(db, workspace.workspaceId, 'nothing-like-this').results.length, 0);
  assert.equal(searchService.search(db, workspace.workspaceId, '').results.length, 0);
});

test('search is not confused by SQL wildcards', () => {
  const { db, workspace } = busyWorkspace();
  assert.equal(searchService.search(db, workspace.workspaceId, '%').results.length, 0);
  assert.equal(searchService.search(db, workspace.workspaceId, '_').results.length, 0);
});

test('the inventory list searches across serials and lots too', () => {
  const { db, workspace, laptop, rations } = busyWorkspace();

  const bySerial = inventoryQuery.listItems(db, workspace.workspaceId, { q: 'DL-829193' }).items;
  assert.equal(bySerial.length, 1);
  assert.equal(bySerial[0].id, laptop.itemId);

  const byLot = inventoryQuery.listItems(db, workspace.workspaceId, { q: 'L240812' }).items;
  assert.equal(byLot.length, 1);
  assert.equal(byLot[0].id, rations.itemId);

  const atLocation = inventoryQuery.listItems(db, workspace.workspaceId, { locationId: workspace.store.id }).items;
  assert.ok(atLocation.every((row) => row.on_hand > 0));
  assert.ok(atLocation.some((row) => row.name === 'Copper Elbow'));
});

test('the overview counts what it says it counts', () => {
  const { db, workspace } = busyWorkspace();
  const stats = inventoryQuery.overview(db, workspace.workspaceId);

  assert.equal(stats.itemCount, 4);
  assert.equal(stats.locationCount, 2);
  assert.equal(stats.unitsOnHand, 50 + 11 + 1 + 80);
  assert.equal(stats.trackedUnits, 1);
  assert.equal(stats.movementsToday, activityService.countActivity(db, workspace.workspaceId, {}));
  assert.equal(stats.byLocation.reduce((sum, l) => sum + l.on_hand, 0), stats.unitsOnHand);
  assert.equal(stats.expiringLots.length, 1);
  assert.equal(stats.expiringLots[0].quantity, 80);
});

test('search matches the words people type, not just the exact phrase', () => {
  const { db, workspace } = busyWorkspace();

  // Read off the screen as "Navy / 4" and typed without the slash.
  const twoWords = searchService.search(db, workspace.workspaceId, 'navy 4');
  assert.ok(
    twoWords.results.some((r) => r.title.includes('Navy / 4')),
    'a variant has to be findable by the words it is displayed with'
  );

  // Ordinary English around the name.
  const withArticle = searchService.search(db, workspace.workspaceId, 'the copper elbow');
  assert.ok(
    withArticle.results.some((r) => r.title === 'Copper Elbow'),
    '"the" names nothing and must not stop the search finding anything'
  );

  // A code is still matched as written, and still ranks first.
  const byCode = searchService.search(db, workspace.workspaceId, 'CE-100');
  assert.ok(byCode.results.some((r) => r.title === 'Copper Elbow'));

  // A query of nothing but filler still finds nothing, rather than everything.
  assert.equal(searchService.search(db, workspace.workspaceId, 'the').results.length, 0);
});
