'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { openDatabase } = require('../../src/db');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

const WORKER = path.join(__dirname, '..', 'helpers', 'sales-allocation-worker.js');
test.after(cleanupAll);

function confirmInProcess(databasePath, payload) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [WORKER, databasePath, JSON.stringify(payload)], { timeout: 60000 },
      (error, stdout, stderr) => {
        let result;
        try { result = JSON.parse(stdout); } catch { return reject(new Error(`Bad worker output: ${stdout}\n${stderr}`)); }
        if (result.error) return reject(new Error(`${result.error.message}\n${result.error.stack || ''}`));
        if (error) return reject(new Error(`${error.message}\n${stderr}`));
        return resolve(result);
      });
  });
}

test('two simultaneous sales orders cannot commit the same available units', async () => {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '10.00', currency: 'USD' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 });
  const first = sales.createOrder(db, workspace.ctx, {
    customerName: 'First customer', lines: [{ skuId: item.skuId, quantity: 8 }],
  });
  const second = sales.createOrder(db, workspace.ctx, {
    customerName: 'Second customer', lines: [{ skuId: item.skuId, quantity: 8 }],
  });
  db.close();

  const results = await Promise.all([first, second].map((order) => confirmInProcess(databasePath, {
    workspaceId: workspace.workspaceId, actorId: workspace.ownerId, orderId: order.id,
  })));

  const check = openDatabase(databasePath);
  const committed = sales.availabilityForSku(check, workspace.workspaceId, item.skuId);
  assert.equal(committed.onHand, 10);
  assert.equal(committed.committed, 10, 'the same ten units cannot be promised twice');
  assert.equal(committed.available, 0);
  assert.equal(results.reduce((sum, result) => sum + result.allocated, 0), 10);
  assert.equal(results.reduce((sum, result) => sum + result.backordered, 0), 6);
  check.close();
});
