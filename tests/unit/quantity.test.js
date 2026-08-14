'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  return { db, workspace, item };
}

test('receive puts quantity into a location and writes a movement', () => {
  const { db, workspace, item } = setup();
  const result = engine.receive(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    quantity: 100,
    reference: 'PO-1',
  });

  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 100);
  assert.equal(result.movementIds.length, 1);

  const movement = db.prepare('SELECT * FROM movements WHERE id = ?').get(result.movementIds[0]);
  assert.equal(movement.operation, 'receive');
  assert.equal(movement.quantity_delta, 100);
  assert.equal(movement.balance_after, 100);
  assert.equal(movement.actor_user_id, workspace.ownerId);
  assert.equal(movement.reference, 'PO-1');
  assert.ok(movement.occurred_at);
});

test('issue removes quantity and records the reason', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40 });
  engine.issue(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    quantity: 8,
    reasonCode: 'used',
  });

  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 32);
  const last = db.prepare('SELECT * FROM movements ORDER BY seq DESC LIMIT 1').get();
  assert.equal(last.operation, 'issue');
  assert.equal(last.quantity_delta, -8);
  assert.equal(last.balance_after, 32);
  assert.equal(last.reason_code, 'used');
});

test('stock cannot go negative by default', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 5 });

  assert.throws(
    () => engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 6 }),
    (err) => err.code === 'insufficient_stock'
  );

  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 5);
  const movements = db.prepare('SELECT COUNT(*) AS n FROM movements').get().n;
  assert.equal(movements, 1, 'the failed issue must not leave a movement behind');
});

test('issuing from an empty location is rejected', () => {
  const { db, workspace, item } = setup();
  assert.throws(
    () => engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id, quantity: 1 }),
    (err) => err.code === 'insufficient_stock'
  );
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.store.id), 0);
});

test('negative stock is possible only when the item explicitly allows it', () => {
  const { db, workspace, item } = setup();
  const itemService = require('../../src/domain/item-service');
  itemService.updateItem(db, workspace.ctx, item.itemId, {
    name: 'Copper Elbow',
    allowNegative: true,
  });

  engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 3 });
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), -3);
});

test('transfer moves stock atomically and never changes the total', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 100 });

  const result = engine.transfer(db, workspace.ctx, {
    skuId: item.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    quantity: 25,
  });

  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 75);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.store.id), 25);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 100);

  const legs = db.prepare('SELECT * FROM movements WHERE group_id = ? ORDER BY seq').all(result.groupId);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].leg, 'out');
  assert.equal(legs[0].quantity_delta, -25);
  assert.equal(legs[0].counterparty_location_id, workspace.store.id);
  assert.equal(legs[1].leg, 'in');
  assert.equal(legs[1].quantity_delta, 25);
  assert.equal(legs.reduce((sum, l) => sum + l.quantity_delta, 0), 0, 'a transfer is net zero');
});

test('a transfer that cannot be covered leaves both locations untouched', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 });

  assert.throws(
    () =>
      engine.transfer(db, workspace.ctx, {
        skuId: item.skuId,
        fromLocationId: workspace.main.id,
        toLocationId: workspace.store.id,
        quantity: 11,
      }),
    (err) => err.code === 'insufficient_stock'
  );

  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 10);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.store.id), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements').get().n, 1);
});

test('transfer to the same location is rejected', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 });
  assert.throws(
    () =>
      engine.transfer(db, workspace.ctx, {
        skuId: item.skuId,
        fromLocationId: workspace.main.id,
        toLocationId: workspace.main.id,
        quantity: 1,
      }),
    (err) => err.code === 'validation_error'
  );
});

test('adjustment records expected, counted and reason', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 41 });

  const result = engine.adjust(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    countedQty: 37,
    reasonCode: 'physical_count',
    notes: 'Counted twice.',
  });

  assert.equal(result.expected, 41);
  assert.equal(result.counted, 37);
  assert.equal(result.delta, -4);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 37);

  const adjustment = db.prepare('SELECT * FROM adjustments ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(adjustment.expected_qty, 41);
  assert.equal(adjustment.counted_qty, 37);
  assert.equal(adjustment.reason_code, 'physical_count');
  assert.equal(adjustment.notes, 'Counted twice.');
  assert.equal(adjustment.actor_user_id, workspace.ownerId);

  const movement = db.prepare('SELECT * FROM movements WHERE id = ?').get(adjustment.movement_id);
  assert.equal(movement.operation, 'adjust');
  assert.equal(movement.quantity_delta, -4);
});

test('adjustments require a recognised reason', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 });

  assert.throws(
    () => engine.adjust(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, countedQty: 9 }),
    (err) => err.code === 'validation_error'
  );
  assert.throws(
    () =>
      engine.adjust(db, workspace.ctx, {
        skuId: item.skuId,
        locationId: workspace.main.id,
        countedQty: 9,
        reasonCode: 'because',
      }),
    (err) => err.code === 'validation_error'
  );
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 10);
});

test('an adjustment that changes nothing is refused rather than logged', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 12 });
  assert.throws(
    () =>
      engine.adjust(db, workspace.ctx, {
        skuId: item.skuId,
        locationId: workspace.main.id,
        countedQty: 12,
        reasonCode: 'physical_count',
      }),
    (err) => err.code === 'validation_error'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adjustments').get().n, 0);
});

test('quantities must be positive whole numbers', () => {
  const { db, workspace, item } = setup();
  for (const quantity of [0, -5, 2.5, 'many', null]) {
    assert.throws(
      () => engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity }),
      (err) => err.code === 'validation_error',
      `quantity ${quantity} should be rejected`
    );
  }
});

test('the ledger explains the balance at every location', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 100 });
  engine.transfer(db, workspace.ctx, {
    skuId: item.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    quantity: 25,
  });
  engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id, quantity: 5 });
  engine.adjust(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    countedQty: 72,
    reasonCode: 'physical_count',
  });

  const totals = db
    .prepare(
      `SELECT location_id, SUM(quantity_delta) AS ledger FROM movements
        WHERE workspace_id = ? AND sku_id = ? GROUP BY location_id`
    )
    .all(workspace.workspaceId, item.skuId);
  for (const row of totals) {
    assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, row.location_id), row.ledger);
  }
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 92);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('movement history is immutable', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 });
  assert.throws(() => db.prepare('UPDATE movements SET quantity_delta = 999').run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM movements').run(), /immutable/);
});
