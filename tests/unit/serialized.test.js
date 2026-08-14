'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace, makeSerialItem, unitsFor } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeSerialItem(db, workspace.ctx);
  return { db, workspace, item };
}

test('receiving serial numbers creates one identified unit each', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    serials: [{ serial: 'DL-829193' }, { serial: 'DL-829194', condition: 'damaged' }],
  });

  const units = unitsFor(db, workspace.workspaceId, item.skuId);
  assert.equal(units.length, 2);
  assert.equal(units[0].serial, 'DL-829193');
  assert.equal(units[0].status, 'in_stock');
  assert.equal(units[0].location_id, workspace.main.id);
  assert.equal(units[0].condition, 'good');
  assert.equal(units[1].condition, 'damaged');
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 2);

  const movements = db.prepare('SELECT * FROM movements ORDER BY seq').all();
  assert.equal(movements.length, 2, 'one movement per unit keeps the ledger per-unit auditable');
  assert.ok(movements.every((m) => m.serial_unit_id));
});

test('the same serial cannot be received twice while it is in stock', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, serials: [{ serial: 'DL-1' }] });

  assert.throws(
    () => engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, serials: [{ serial: 'DL-1' }] }),
    (err) => err.code === 'duplicate_serial'
  );
  assert.throws(
    () => engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id, serials: [{ serial: 'DL-1' }] }),
    (err) => err.code === 'duplicate_serial',
    'not even into a different location'
  );

  assert.equal(unitsFor(db, workspace.workspaceId, item.skuId).length, 1);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 1);
});

test('a duplicate inside one receive is caught before anything is written', () => {
  const { db, workspace, item } = setup();
  assert.throws(
    () =>
      engine.receive(db, workspace.ctx, {
        skuId: item.skuId,
        locationId: workspace.main.id,
        serials: [{ serial: 'DL-7' }, { serial: 'dl-7' }],
      }),
    (err) => err.code === 'validation_error'
  );
  assert.equal(unitsFor(db, workspace.workspaceId, item.skuId).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements').get().n, 0);
});

test('a serial number exists in exactly one location at a time', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    serials: [{ serial: 'DL-829193' }, { serial: 'DL-829194' }],
  });
  const units = unitsFor(db, workspace.workspaceId, item.skuId);

  engine.transfer(db, workspace.ctx, {
    skuId: item.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    serialUnitIds: [units[0].id],
  });

  const moved = db.prepare('SELECT * FROM serial_units WHERE id = ?').get(units[0].id);
  assert.equal(moved.location_id, workspace.store.id);

  const rowsForSerial = db
    .prepare("SELECT COUNT(*) AS n FROM serial_units WHERE workspace_id = ? AND serial = ? AND status = 'in_stock'")
    .get(workspace.workspaceId, 'DL-829193').n;
  assert.equal(rowsForSerial, 1, 'one row, one location');

  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 1);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.store.id), 1);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 2, 'moving a unit does not change the total');
});

test('a unit cannot be moved from a location it is not at', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, serials: [{ serial: 'DL-5' }] });
  const [unit] = unitsFor(db, workspace.workspaceId, item.skuId);

  assert.throws(
    () =>
      engine.transfer(db, workspace.ctx, {
        skuId: item.skuId,
        fromLocationId: workspace.store.id,
        toLocationId: workspace.main.id,
        serialUnitIds: [unit.id],
      }),
    (err) => err.code === 'unit_wrong_location'
  );
  assert.equal(db.prepare('SELECT location_id FROM serial_units WHERE id = ?').get(unit.id).location_id, workspace.main.id);
});

test('issuing a unit takes it out of stock and frees the serial number', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, serials: [{ serial: 'DL-3' }] });
  const [unit] = unitsFor(db, workspace.workspaceId, item.skuId);

  engine.issue(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    serialUnitIds: [unit.id],
    reasonCode: 'sold',
  });

  const after = db.prepare('SELECT * FROM serial_units WHERE id = ?').get(unit.id);
  assert.equal(after.status, 'issued');
  assert.equal(after.location_id, null);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 0);

  assert.throws(
    () => engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, serialUnitIds: [unit.id] }),
    (err) => err.code === 'unit_not_in_stock'
  );

  // A returned unit may come back in, and history keeps both rows.
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id, serials: [{ serial: 'DL-3' }] });
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM serial_units WHERE serial = 'DL-3'").get().n,
    2,
    'the issued unit stays in history'
  );
});

test('a unit belonging to another item cannot be moved through this one', () => {
  const { db, workspace, item } = setup();
  const other = makeSerialItem(db, workspace.ctx, { name: 'Other Laptop', baseCode: 'OL-1' });
  engine.receive(db, workspace.ctx, { skuId: other.skuId, locationId: workspace.main.id, serials: [{ serial: 'X-1' }] });
  const [unit] = unitsFor(db, workspace.workspaceId, other.skuId);

  assert.throws(
    () =>
      engine.transfer(db, workspace.ctx, {
        skuId: item.skuId,
        fromLocationId: workspace.main.id,
        toLocationId: workspace.store.id,
        serialUnitIds: [unit.id],
      }),
    (err) => err.code === 'validation_error'
  );
});

test('writing off units records an adjustment with a reason', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    serials: [{ serial: 'DL-A' }, { serial: 'DL-B' }],
  });
  const units = unitsFor(db, workspace.workspaceId, item.skuId);

  engine.adjust(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    serialUnitIds: [units[0].id],
    reasonCode: 'loss',
    notes: 'Not found during the count.',
  });

  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 1);
  const adjustment = db.prepare('SELECT * FROM adjustments ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(adjustment.reason_code, 'loss');
  assert.equal(adjustment.expected_qty, 2);
  assert.equal(adjustment.counted_qty, 1);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('balances always match the number of units in stock', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    serials: [{ serial: 'S1' }, { serial: 'S2' }, { serial: 'S3' }],
  });
  const units = unitsFor(db, workspace.workspaceId, item.skuId);
  engine.transfer(db, workspace.ctx, {
    skuId: item.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    serialUnitIds: [units[0].id, units[1].id],
  });
  engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id, serialUnitIds: [units[0].id] });

  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 1);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.store.id), 1);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});
