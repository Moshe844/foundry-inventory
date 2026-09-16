'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../../src/attention/query-planner');
const queries = require('../../src/attention/query-service');
const engine = require('../../src/domain/inventory-engine');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

test('ordinary wording for products with no stock history routes to never_stocked', async () => {
  for (const question of [
    "How many items don't have any stocks yet?",
    'How many items show none yet?',
    'Which products have never been stocked?',
    'Do any products have no inventory yet?',
  ]) {
    assert.equal((await planner.plan(question)).intent, 'never_stocked', question);
  }
  assert.equal((await planner.plan('Which products are out of stock?')).intent, 'out_of_stock');
});

test('stock status answers use product history and network quantity rather than balance rows', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const neverOne = makeQuantityItem(db, workspace.ctx, { name: 'Ceramic Sleeve', baseCode: 'CER-1' });
  const neverTwo = makeQuantityItem(db, workspace.ctx, { name: 'Graphite Seal', baseCode: 'GRA-1' });
  const soldOut = makeQuantityItem(db, workspace.ctx, { name: 'Brass Collar', baseCode: 'BRA-1' });
  const heldElsewhere = makeQuantityItem(db, workspace.ctx, { name: 'Steel Washer', baseCode: 'STE-1' });

  engine.receive(db, workspace.ctx, { skuId: soldOut.skuId, locationId: workspace.main.id, quantity: 4 });
  engine.issue(db, workspace.ctx, { skuId: soldOut.skuId, locationId: workspace.main.id, quantity: 4 });
  engine.receive(db, workspace.ctx, { skuId: heldElsewhere.skuId, locationId: workspace.main.id, quantity: 3 });
  engine.receive(db, workspace.ctx, { skuId: heldElsewhere.skuId, locationId: workspace.store.id, quantity: 2 });
  engine.issue(db, workspace.ctx, { skuId: heldElsewhere.skuId, locationId: workspace.main.id, quantity: 3 });

  const never = queries.execute(db, workspace.workspaceId, { intent: 'never_stocked' });
  assert.deepEqual(never.rows.map((row) => row.product), ['Ceramic Sleeve', 'Graphite Seal']);
  assert.match(never.answer, /2 products show “None yet”/);
  assert.ok(never.rows.every((row) => row.status.includes('no stock movement')));

  const empty = queries.execute(db, workspace.workspaceId, { intent: 'out_of_stock' });
  assert.deepEqual(empty.rows.map((row) => row.product), ['Brass Collar']);
  assert.match(empty.answer, /1 product is completely out of stock: Brass Collar/);
  assert.doesNotMatch(empty.answer, /Steel Washer/);
  assert.doesNotMatch(empty.answer, /Ceramic Sleeve|Graphite Seal/);

  assert.ok(neverOne.itemId && neverTwo.itemId);
  db.close();
});
