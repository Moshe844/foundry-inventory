'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, makeSerialItem } = require('../helpers');

const WORKER = path.join(__dirname, '..', 'helpers', 'mutation-worker.js');

test.after(cleanupAll);

function runWorker(databasePath, payload) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [WORKER, databasePath, JSON.stringify(payload)],
      { timeout: 60000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`${err.message}\n${stderr}`));
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(new Error(`Bad worker output: ${stdout}\n${stderr}`));
        }
        if (parsed.unexpected) {
          return reject(new Error(`Worker hit an unexpected error: ${parsed.unexpected.message}`));
        }
        return resolve(parsed);
      }
    );
  });
}

function ledgerTotal(db, workspaceId, skuId, locationId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity_delta), 0) AS total FROM movements
        WHERE workspace_id = ? AND sku_id = ? AND location_id = ?`
    )
    .get(workspaceId, skuId, locationId);
  return row.total;
}

test('concurrent issues from four processes never oversell or corrupt the balance', async (t) => {
  t.diagnostic('4 processes × 60 attempts against 200 units');
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 200 });
  db.close();

  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      runWorker(databasePath, {
        operation: 'issue',
        workspaceId: workspace.workspaceId,
        actorId: workspace.ownerId,
        skuId: item.skuId,
        locationId: workspace.main.id,
        quantity: 1,
        iterations: 60,
      })
    )
  );

  const { openDatabase } = require('../../src/db');
  const check = openDatabase(databasePath);

  const succeeded = results.reduce((sum, r) => sum + r.succeeded, 0);
  const rejected = results.reduce((sum, r) => sum + r.rejected, 0);
  assert.equal(succeeded + rejected, 240, 'every attempt was accounted for');
  assert.ok(succeeded <= 200, `cannot issue more than existed (issued ${succeeded})`);

  const balance = repo.getBalance(check, workspace.workspaceId, item.skuId, workspace.main.id);
  assert.equal(balance, 200 - succeeded, 'the balance is exactly what the ledger says');
  assert.ok(balance >= 0, 'stock never went negative under contention');
  assert.equal(ledgerTotal(check, workspace.workspaceId, item.skuId, workspace.main.id), balance);

  const movements = check
    .prepare("SELECT COUNT(*) AS n FROM movements WHERE operation = 'issue' AND sku_id = ?")
    .get(item.skuId).n;
  assert.equal(movements, succeeded, 'one movement per successful issue, no ghosts');
  assert.equal(engine.verifyIntegrity(check, workspace.workspaceId).ok, true);
  check.close();
});

test('concurrent issues cannot drain past zero', async () => {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 50 });
  db.close();

  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      runWorker(databasePath, {
        operation: 'issue',
        workspaceId: workspace.workspaceId,
        actorId: workspace.ownerId,
        skuId: item.skuId,
        locationId: workspace.main.id,
        quantity: 4,
        iterations: 20,
      })
    )
  );

  const { openDatabase } = require('../../src/db');
  const check = openDatabase(databasePath);
  const succeeded = results.reduce((sum, r) => sum + r.succeeded, 0);
  const balance = repo.getBalance(check, workspace.workspaceId, item.skuId, workspace.main.id);

  assert.equal(balance, 50 - succeeded * 4);
  assert.ok(balance >= 0);
  assert.ok(balance < 4, 'the workers drained what they legitimately could');
  assert.equal(engine.verifyIntegrity(check, workspace.workspaceId).ok, true);
  check.close();
});

test('concurrent transfers conserve the total across locations', async () => {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 300 });
  db.close();

  await Promise.all([
    ...Array.from({ length: 2 }, () =>
      runWorker(databasePath, {
        operation: 'transfer',
        workspaceId: workspace.workspaceId,
        actorId: workspace.ownerId,
        skuId: item.skuId,
        fromLocationId: workspace.main.id,
        toLocationId: workspace.store.id,
        quantity: 3,
        iterations: 40,
      })
    ),
    ...Array.from({ length: 2 }, () =>
      runWorker(databasePath, {
        operation: 'transfer',
        workspaceId: workspace.workspaceId,
        actorId: workspace.ownerId,
        skuId: item.skuId,
        fromLocationId: workspace.store.id,
        toLocationId: workspace.main.id,
        quantity: 2,
        iterations: 40,
      })
    ),
  ]);

  const { openDatabase } = require('../../src/db');
  const check = openDatabase(databasePath);
  const main = repo.getBalance(check, workspace.workspaceId, item.skuId, workspace.main.id);
  const store = repo.getBalance(check, workspace.workspaceId, item.skuId, workspace.store.id);

  assert.equal(main + store, 300, 'transfers under contention neither create nor destroy stock');
  assert.ok(main >= 0 && store >= 0);
  assert.equal(main, ledgerTotal(check, workspace.workspaceId, item.skuId, workspace.main.id));
  assert.equal(store, ledgerTotal(check, workspace.workspaceId, item.skuId, workspace.store.id));

  const orphans = check
    .prepare(
      `SELECT group_id, COUNT(*) AS legs, SUM(quantity_delta) AS net FROM movements
        WHERE operation = 'transfer' GROUP BY group_id HAVING legs <> 2 OR net <> 0`
    )
    .all();
  assert.deepEqual(orphans, [], 'every transfer landed as a complete, balanced pair');
  assert.equal(engine.verifyIntegrity(check, workspace.workspaceId).ok, true);
  check.close();
});

test('concurrent receives all land and add up', async () => {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  db.close();

  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      runWorker(databasePath, {
        operation: 'receive',
        workspaceId: workspace.workspaceId,
        actorId: workspace.ownerId,
        skuId: item.skuId,
        locationId: workspace.main.id,
        quantity: 7,
        iterations: 25,
      })
    )
  );

  const { openDatabase } = require('../../src/db');
  const check = openDatabase(databasePath);
  const succeeded = results.reduce((sum, r) => sum + r.succeeded, 0);
  assert.equal(succeeded, 100, 'no receipt was lost to a write conflict');
  assert.equal(repo.getBalance(check, workspace.workspaceId, item.skuId, workspace.main.id), 700);
  assert.equal(engine.verifyIntegrity(check, workspace.workspaceId).ok, true);
  check.close();
});

test('two processes racing to receive the same serial: exactly one wins', async () => {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeSerialItem(db, workspace.ctx);
  db.close();

  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      runWorker(databasePath, {
        operation: 'receiveSerial',
        workspaceId: workspace.workspaceId,
        actorId: workspace.ownerId,
        skuId: item.skuId,
        locationId: workspace.main.id,
        serial: 'RACE-0001',
        iterations: 1,
      })
    )
  );

  const { openDatabase } = require('../../src/db');
  const check = openDatabase(databasePath);
  const succeeded = results.reduce((sum, r) => sum + r.succeeded, 0);
  assert.equal(succeeded, 1, 'a serial number cannot be received twice, even in a race');
  assert.equal(
    check
      .prepare("SELECT COUNT(*) AS n FROM serial_units WHERE serial = 'RACE-0001' AND status = 'in_stock'")
      .get().n,
    1
  );
  assert.equal(repo.getBalance(check, workspace.workspaceId, item.skuId, workspace.main.id), 1);
  assert.equal(engine.verifyIntegrity(check, workspace.workspaceId).ok, true);
  check.close();
});
