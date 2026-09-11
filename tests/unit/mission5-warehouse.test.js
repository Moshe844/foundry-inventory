'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../src/db');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const locations = require('../../src/domain/location-service');
const warehouse = require('../../src/warehouse/service');
const labels = require('../../src/warehouse/labels');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, makeLotItem, makeSerialItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  locations.updateLocation(store.db, workspace.ctx, workspace.main.id, {
    name: workspace.main.name, kind: workspace.main.kind, barcode: 'WH-MAIN', pickSequence: 0,
  });
  const dock = locations.createLocation(store.db, workspace.ctx, {
    name: 'Receiving Dock', kind: 'dock', parentLocationId: workspace.main.id, barcode: 'DOCK-01', pickSequence: 10,
  });
  const aisle = locations.createLocation(store.db, workspace.ctx, {
    name: 'Aisle A', kind: 'aisle', parentLocationId: workspace.main.id, barcode: 'AISLE-A', pickSequence: 20,
  });
  const bin = locations.createLocation(store.db, workspace.ctx, {
    name: 'A-01-01', kind: 'bin', parentLocationId: aisle.id, barcode: 'BIN-A-01-01', pickSequence: 1,
  });
  return { ...store, workspace, dock, aisle, bin };
}

test('existing warehouse inventory migrates without invented bins or stock movement', () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const item = makeQuantityItem(store.db, workspace.ctx);
  engine.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 9 });
  const beforeLocations = store.db.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ?').get(workspace.workspaceId).n;
  const beforeMovements = store.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n;
  store.db.close();

  const reopened = openDatabase(store.databasePath);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ?').get(workspace.workspaceId).n, beforeLocations);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND kind = ?').get(workspace.workspaceId, 'bin').n, 0);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n, beforeMovements);
  assert.equal(repo.getBalance(reopened, workspace.workspaceId, item.skuId, workspace.main.id), 9);
  reopened.close();
});

test('warehouse hierarchy is real, ordered and cannot contain a cycle', () => {
  const { db, workspace, aisle, bin } = setup();
  const tree = locations.listHierarchy(db, workspace.workspaceId);
  const shown = tree.find((row) => row.id === bin.id);
  assert.equal(shown.depth, 2);
  assert.match(shown.display_path, /Main Warehouse \/ Aisle A \/ A-01-01/);
  assert.throws(() => locations.updateLocation(db, workspace.ctx, aisle.id, {
    name: aisle.name, kind: aisle.kind, parentLocationId: bin.id,
  }), /loop/);
});

test('wrong product and location scans are blocked before any stock changes', () => {
  const { db, workspace, dock } = setup();
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Scan Shoe', baseCode: 'SHOE-SCAN' });
  const other = makeQuantityItem(db, workspace.ctx, { name: 'Other Shoe', baseCode: 'OTHER-SCAN' });
  const task = warehouse.createTask(db, workspace.ctx, { taskType: 'RECEIVE', lines: [{
    skuId: item.skuId, toLocationId: dock.id, quantity: 2,
  }] });
  const wrongProduct = warehouse.scanTask(db, workspace.ctx, { taskId: task.id,
    clientScanId: 'scan-wrong-product', locationBarcode: 'DOCK-01', itemBarcode: other.sku.code });
  assert.equal(wrongProduct.accepted, false);
  assert.match(wrongProduct.message, /not on this task/);
  const wrongLocation = warehouse.scanTask(db, workspace.ctx, { taskId: task.id,
    clientScanId: 'scan-wrong-location', locationBarcode: 'WH-MAIN', itemBarcode: item.sku.code });
  assert.equal(wrongLocation.accepted, false);
  assert.match(wrongLocation.message, /belongs at Receiving Dock/);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, dock.id), 0);
});

test('offline replay and duplicate scans cannot post a receipt twice', () => {
  const { db, workspace, dock } = setup();
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Replay Shoe', baseCode: 'REPLAY-SHOE' });
  const task = warehouse.createTask(db, workspace.ctx, { taskType: 'RECEIVE', lines: [{
    skuId: item.skuId, toLocationId: dock.id, quantity: 2,
  }] });
  const input = { taskId: task.id, clientScanId: 'offline-device-17', deviceId: 'phone-1',
    locationBarcode: 'DOCK-01', itemBarcode: item.sku.code, quantity: 1 };
  const first = warehouse.scanTask(db, workspace.ctx, input);
  const replay = warehouse.scanTask(db, workspace.ctx, input);
  assert.equal(first.accepted, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.id, first.id);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, dock.id), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM warehouse_scan_events WHERE task_id = ?').get(task.id).n, 1);
});

test('partial putaway resumes from durable state and every unit moves through the inventory engine', () => {
  const { db, databasePath, workspace, dock, bin } = setup();
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Putaway Shoe', baseCode: 'PUT-SHOE' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: dock.id, quantity: 3 });
  warehouse.createPutawayRule(db, workspace.ctx, { skuId: item.skuId,
    fromLocationId: dock.id, destinationLocationId: bin.id, priority: 1 });
  const task = warehouse.createTask(db, workspace.ctx, { taskType: 'PUTAWAY', lines: [{
    skuId: item.skuId, fromLocationId: dock.id, quantity: 3,
  }] });
  warehouse.scanTask(db, workspace.ctx, { taskId: task.id, clientScanId: 'put-1',
    locationBarcode: 'DOCK-01', itemBarcode: item.sku.code, quantity: 1 });
  assert.equal(warehouse.getTask(db, workspace.workspaceId, task.id).lines[0].processed_quantity, 1);
  db.close();

  const reopened = openDatabase(databasePath);
  const resumed = warehouse.getTask(reopened, workspace.workspaceId, task.id);
  assert.equal(resumed.status, 'IN_PROGRESS');
  warehouse.scanTask(reopened, workspace.ctx, { taskId: task.id, clientScanId: 'put-2',
    locationBarcode: 'DOCK-01', itemBarcode: item.sku.code, quantity: 2 });
  assert.equal(warehouse.getTask(reopened, workspace.workspaceId, task.id).status, 'COMPLETED');
  assert.equal(repo.getBalance(reopened, workspace.workspaceId, item.skuId, dock.id), 0);
  assert.equal(repo.getBalance(reopened, workspace.workspaceId, item.skuId, bin.id), 3);
  const legs = reopened.prepare(`SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?
    AND operation = 'transfer' AND reference = ?`).get(workspace.workspaceId, `Warehouse task ${task.task_number}`).n;
  assert.equal(legs, 4);
  reopened.close();
});

test('lot and serial scans validate exact identity', () => {
  const { db, workspace, dock, bin } = setup();
  const lotItem = makeLotItem(db, workspace.ctx, { name: 'Lot Shoe', baseCode: 'LOT-SHOE' });
  engine.receive(db, workspace.ctx, { skuId: lotItem.skuId, locationId: dock.id, quantity: 2, lotCode: 'LOT-RED' });
  const lot = db.prepare('SELECT * FROM lots WHERE workspace_id = ? AND sku_id = ?').get(workspace.workspaceId, lotItem.skuId);
  const lotTask = warehouse.createTask(db, workspace.ctx, { taskType: 'TRANSFER', lines: [{
    skuId: lotItem.skuId, fromLocationId: dock.id, toLocationId: bin.id, lotId: lot.id, quantity: 1,
  }] });
  const badLot = warehouse.scanTask(db, workspace.ctx, { taskId: lotTask.id, clientScanId: 'lot-bad',
    locationBarcode: 'DOCK-01', itemBarcode: db.prepare('SELECT code FROM skus WHERE id = ?').get(lotItem.skuId).code,
    lotBarcode: 'LOT-BLUE' });
  assert.equal(badLot.accepted, false);
  assert.match(badLot.message, /not known/);

  const serialItem = makeSerialItem(db, workspace.ctx, { name: 'Serial Scanner', baseCode: 'SER-SCAN' });
  engine.receive(db, workspace.ctx, { skuId: serialItem.skuId, locationId: dock.id, serials: ['SERIAL-1'] });
  const serialTask = warehouse.createTask(db, workspace.ctx, { taskType: 'TRANSFER', lines: [{
    skuId: serialItem.skuId, fromLocationId: dock.id, toLocationId: bin.id, quantity: 1,
  }] });
  const wrongSerial = warehouse.scanTask(db, workspace.ctx, { taskId: serialTask.id, clientScanId: 'serial-bad',
    locationBarcode: 'DOCK-01', itemBarcode: db.prepare('SELECT code FROM skus WHERE id = ?').get(serialItem.skuId).code,
    serialBarcode: 'SERIAL-NOT-THERE' });
  assert.equal(wrongSerial.accepted, false);
  assert.match(wrongSerial.message, /not known/);

  const twoAtOnce = warehouse.scanTask(db, workspace.ctx, { taskId: serialTask.id, clientScanId: 'serial-two',
    locationBarcode: 'DOCK-01', itemBarcode: db.prepare('SELECT code FROM skus WHERE id = ?').get(serialItem.skuId).code,
    serialBarcode: 'SERIAL-1', quantity: 2 });
  assert.equal(twoAtOnce.accepted, false);
  assert.match(twoAtOnce.message, /one serial number at a time/);
  assert.equal(repo.getBalance(db, workspace.workspaceId, serialItem.skuId, dock.id), 1);
});

test('barcode aliases and labelled containers retain exact scanned contents', () => {
  const { db, workspace, dock, bin } = setup();
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Alias Shoe', baseCode: 'ALIAS-SHOE' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: dock.id, quantity: 2 });
  warehouse.createAlias(db, workspace.ctx, { barcode: '0123456789012', targetKind: 'sku', targetId: item.skuId });
  assert.equal(warehouse.resolveIdentity(db, workspace.workspaceId, '0123456789012', { kind: 'sku' }).id, item.skuId);
  const tote = warehouse.createContainer(db, workspace.ctx, { code: 'TOTE-RED', kind: 'tote' });
  const task = warehouse.createTask(db, workspace.ctx, { taskType: 'PICK', containerId: tote.id, lines: [{
    skuId: item.skuId, fromLocationId: dock.id, toLocationId: bin.id, quantity: 2,
  }] });
  const scanned = warehouse.scanTask(db, workspace.ctx, { taskId: task.id, clientScanId: 'alias-pick-1',
    locationBarcode: 'DOCK-01', itemBarcode: '0123456789012', quantity: 2 });
  assert.equal(scanned.accepted, true);
  const content = db.prepare('SELECT * FROM warehouse_container_contents WHERE container_id = ?').get(tote.id);
  assert.equal(content.quantity, 2);
  assert.equal(content.sku_id, item.skuId);
  assert.equal(db.prepare('SELECT location_id FROM warehouse_containers WHERE id = ?').get(tote.id).location_id, bin.id);
});

test('a quantity count posts one canonical adjustment and cannot be repeated', () => {
  const { db, workspace, bin } = setup();
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Count Shoe', baseCode: 'COUNT-SHOE' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: bin.id, quantity: 5 });
  const task = warehouse.createTask(db, workspace.ctx, { taskType: 'COUNT', lines: [{
    skuId: item.skuId, fromLocationId: bin.id, quantity: 5,
  }] });
  warehouse.scanTask(db, workspace.ctx, { taskId: task.id, clientScanId: 'count-1',
    locationBarcode: 'BIN-A-01-01', itemBarcode: item.sku.code, quantity: 4 });
  warehouse.finishCount(db, workspace.ctx, task.id);
  warehouse.finishCount(db, workspace.ctx, task.id);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, bin.id), 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adjustments WHERE workspace_id = ? AND sku_id = ?').get(workspace.workspaceId, item.skuId).n, 1);
});

test('an untouched count cannot silently zero stock', () => {
  const { db, workspace, bin } = setup();
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Zero Guard Shoe', baseCode: 'ZERO-GUARD' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: bin.id, quantity: 2 });
  const task = warehouse.createTask(db, workspace.ctx, { taskType: 'COUNT', lines: [{
    skuId: item.skuId, fromLocationId: bin.id, quantity: 2,
  }] });
  assert.throws(() => warehouse.finishCount(db, workspace.ctx, task.id), /Nothing has been counted/);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, bin.id), 2);
  warehouse.finishCount(db, workspace.ctx, task.id, { confirmEmpty: true });
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, bin.id), 0);
});

test('a serial cannot be counted twice under different offline scan ids', () => {
  const { db, workspace, bin } = setup();
  const item = makeSerialItem(db, workspace.ctx, { name: 'Counted Scanner', baseCode: 'SERIAL-COUNT' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: bin.id, serials: ['SC-1', 'SC-2'] });
  const code = db.prepare('SELECT code FROM skus WHERE id = ?').get(item.skuId).code;
  const task = warehouse.createTask(db, workspace.ctx, { taskType: 'COUNT', lines: [{
    skuId: item.skuId, fromLocationId: bin.id, quantity: 2,
  }] });
  const input = { taskId: task.id, locationBarcode: 'BIN-A-01-01', itemBarcode: code, serialBarcode: 'SC-1' };
  assert.equal(warehouse.scanTask(db, workspace.ctx, { ...input, clientScanId: 'serial-count-1' }).accepted, true);
  const repeated = warehouse.scanTask(db, workspace.ctx, { ...input, clientScanId: 'serial-count-2' });
  assert.equal(repeated.accepted, false);
  assert.match(repeated.message, /already counted/);
  assert.throws(() => warehouse.finishCount(db, workspace.ctx, task.id), /identify the missing serials/);
});

test('printable Code 128 labels encode and verify the same scan value', () => {
  const { db, workspace } = setup();
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Label Shoe', baseCode: 'LBL-35-BLK' });
  const label = labels.labelFor(db, workspace.workspaceId, 'sku', item.skuId);
  const svg = labels.code128Svg(label.barcode);
  assert.equal(labels.verifyRoundTrip(label), true);
  assert.match(svg, /data-barcode="LBL-35-BLK"/);
  assert.match(svg, /<rect/);
});
