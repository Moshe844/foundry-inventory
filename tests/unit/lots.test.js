'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace, makeLotItem, lotsFor } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeLotItem(db, workspace.ctx);
  return { db, workspace, item };
}

test('receiving into a lot records the lot and its expiration', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    quantity: 84,
    lotCode: 'L240812',
    lotReceivedAt: '2026-08-12',
    expiresAt: '2026-10-30',
  });

  const [lot] = lotsFor(db, workspace.workspaceId, item.skuId);
  assert.equal(lot.code, 'L240812');
  assert.equal(lot.expires_at.slice(0, 10), '2026-10-30');
  assert.equal(lot.received_at.slice(0, 10), '2026-08-12');
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lot.id, workspace.main.id), 84);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 84);

  const movement = db.prepare('SELECT * FROM movements ORDER BY seq DESC LIMIT 1').get();
  assert.equal(movement.lot_id, lot.id);
  assert.equal(movement.quantity_delta, 84);
});

test('lot tracking requires a lot number', () => {
  const { db, workspace, item } = setup();
  assert.throws(
    () => engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 }),
    (err) => err.code === 'validation_error'
  );
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 0);
});

test('several lots of the same item are tracked separately', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 84, lotCode: 'L240812' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 120, lotCode: 'L240902' });

  const lots = lotsFor(db, workspace.workspaceId, item.skuId);
  assert.equal(lots.length, 2);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[0].id, workspace.main.id), 84);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[1].id, workspace.main.id), 120);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 204);
});

test('receiving the same lot code again adds to that lot', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10, lotCode: 'L1' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 15, lotCode: 'L1' });

  const lots = lotsFor(db, workspace.workspaceId, item.skuId);
  assert.equal(lots.length, 1);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[0].id, workspace.main.id), 25);
});

test('quantity moves out of the specific lot it was taken from', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 84, lotCode: 'L240812' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 120, lotCode: 'L240902' });
  const [first, second] = lotsFor(db, workspace.workspaceId, item.skuId);

  engine.transfer(db, workspace.ctx, {
    skuId: item.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    lotId: first.id,
    quantity: 24,
  });

  assert.equal(repo.getLotBalance(db, workspace.workspaceId, first.id, workspace.main.id), 60);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, first.id, workspace.store.id), 24);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, second.id, workspace.main.id), 120, 'the other lot is untouched');
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, second.id, workspace.store.id), 0);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 180);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.store.id), 24);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.skuId), 204, 'a transfer never changes the total');
});

test('a lot cannot give up more than it holds at that location', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 30, lotCode: 'L1' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 50, lotCode: 'L2' });
  const [first] = lotsFor(db, workspace.workspaceId, item.skuId);

  assert.throws(
    () =>
      engine.issue(db, workspace.ctx, {
        skuId: item.skuId,
        locationId: workspace.main.id,
        lotId: first.id,
        quantity: 31,
      }),
    (err) => err.code === 'insufficient_stock',
    'the other lot cannot cover it'
  );

  assert.equal(repo.getLotBalance(db, workspace.workspaceId, first.id, workspace.main.id), 30);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 80);
});

test('a lot cannot be drawn from a location where it is not held', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 30, lotCode: 'L1' });
  const [lot] = lotsFor(db, workspace.workspaceId, item.skuId);

  assert.throws(
    () => engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id, lotId: lot.id, quantity: 1 }),
    (err) => err.code === 'insufficient_stock'
  );
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lot.id, workspace.main.id), 30);
});

test('issuing and moving require a lot to be chosen', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 30, lotCode: 'L1' });

  assert.throws(
    () => engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 5 }),
    (err) => err.code === 'validation_error'
  );
  assert.throws(
    () =>
      engine.transfer(db, workspace.ctx, {
        skuId: item.skuId,
        fromLocationId: workspace.main.id,
        toLocationId: workspace.store.id,
        quantity: 5,
      }),
    (err) => err.code === 'validation_error'
  );
});

test('adjusting a lot corrects the lot and the location balance together', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 84, lotCode: 'L1' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 20, lotCode: 'L2' });
  const [first] = lotsFor(db, workspace.workspaceId, item.skuId);

  const result = engine.adjust(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    lotId: first.id,
    countedQty: 80,
    reasonCode: 'damage',
  });

  assert.equal(result.expected, 84);
  assert.equal(result.delta, -4);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, first.id, workspace.main.id), 80);
  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 100);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('lot balances always add up to the location balance', () => {
  const { db, workspace, item } = setup();
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40, lotCode: 'A' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 60, lotCode: 'B' });
  const [a, b] = lotsFor(db, workspace.workspaceId, item.skuId);
  engine.transfer(db, workspace.ctx, {
    skuId: item.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    lotId: a.id,
    quantity: 15,
  });
  engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, lotId: b.id, quantity: 10 });

  for (const location of [workspace.main.id, workspace.store.id]) {
    const lotTotal =
      repo.getLotBalance(db, workspace.workspaceId, a.id, location) + repo.getLotBalance(db, workspace.workspaceId, b.id, location);
    assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, location), lotTotal);
  }
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});
