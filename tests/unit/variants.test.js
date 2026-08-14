'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../../src/domain/inventory-engine');
const itemService = require('../../src/domain/item-service');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace, makeVariantItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeVariantItem(db, workspace.ctx);
  return { db, workspace, item };
}

test('a variant item creates one tracked SKU per option combination', () => {
  const { db, workspace, item } = setup();
  assert.equal(item.skus.length, 4);
  const labels = item.skus.map((s) => s.variant_label).sort();
  assert.deepEqual(labels, ['Cream / 4', 'Cream / 5', 'Navy / 4', 'Navy / 5']);
  for (const sku of item.skus) {
    assert.ok(sku.code, 'each variant gets its own code');
  }
  const codes = new Set(item.skus.map((s) => s.code));
  assert.equal(codes.size, 4, 'variant codes are unique');

  const options = db
    .prepare('SELECT * FROM item_options WHERE item_id = ? ORDER BY position')
    .all(item.itemId);
  assert.deepEqual(options.map((o) => o.name), ['Colour', 'Size']);
});

test("variant stock belongs to the variant, not the parent item", () => {
  const { db, workspace, item } = setup();
  const navy4 = item.byLabel('Navy / 4');
  const navy5 = item.byLabel('Navy / 5');
  const cream4 = item.byLabel('Cream / 4');

  engine.receive(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.store.id, quantity: 12 });
  engine.receive(db, workspace.ctx, { skuId: navy5.id, locationId: workspace.store.id, quantity: 8 });
  engine.receive(db, workspace.ctx, { skuId: cream4.id, locationId: workspace.store.id, quantity: 16 });

  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, navy4.id), 12);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, navy5.id), 8);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, cream4.id), 16);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, item.byLabel('Cream / 5').id), 0);
  assert.equal(repo.getItemTotal(db, workspace.workspaceId, item.itemId), 36);
});

test('moving one variant does not touch its siblings', () => {
  const { db, workspace, item } = setup();
  const navy4 = item.byLabel('Navy / 4');
  const navy5 = item.byLabel('Navy / 5');
  engine.receive(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.store.id, quantity: 12 });
  engine.receive(db, workspace.ctx, { skuId: navy5.id, locationId: workspace.store.id, quantity: 8 });

  engine.transfer(db, workspace.ctx, {
    skuId: navy4.id,
    fromLocationId: workspace.store.id,
    toLocationId: workspace.main.id,
    quantity: 5,
  });
  engine.issue(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.store.id, quantity: 2 });

  assert.equal(repo.getBalance(db, workspace.workspaceId, navy4.id, workspace.store.id), 5);
  assert.equal(repo.getBalance(db, workspace.workspaceId, navy4.id, workspace.main.id), 5);
  assert.equal(repo.getBalance(db, workspace.workspaceId, navy5.id, workspace.store.id), 8, 'sibling variant unchanged');
  assert.equal(repo.getBalance(db, workspace.workspaceId, navy5.id, workspace.main.id), 0);
});

test('one variant running out does not let another be over-issued', () => {
  const { db, workspace, item } = setup();
  const navy4 = item.byLabel('Navy / 4');
  const cream4 = item.byLabel('Cream / 4');
  engine.receive(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.store.id, quantity: 10 });

  assert.throws(
    () => engine.issue(db, workspace.ctx, { skuId: cream4.id, locationId: workspace.store.id, quantity: 1 }),
    (err) => err.code === 'insufficient_stock'
  );
  assert.equal(repo.getBalance(db, workspace.workspaceId, navy4.id, workspace.store.id), 10);
});

test('adjusting one variant reports that variant only', () => {
  const { db, workspace, item } = setup();
  const navy4 = item.byLabel('Navy / 4');
  const cream4 = item.byLabel('Cream / 4');
  engine.receive(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.store.id, quantity: 13 });
  engine.receive(db, workspace.ctx, { skuId: cream4.id, locationId: workspace.store.id, quantity: 16 });

  const result = engine.adjust(db, workspace.ctx, {
    skuId: navy4.id,
    locationId: workspace.store.id,
    countedQty: 11,
    reasonCode: 'physical_count',
  });

  assert.equal(result.expected, 13);
  assert.equal(result.counted, 11);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, navy4.id), 11);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, cream4.id), 16);
});

test('a variant can be added later and starts empty', () => {
  const { db, workspace, item } = setup();
  const options = db.prepare('SELECT * FROM item_options WHERE item_id = ? ORDER BY position').all(item.itemId);
  const added = itemService.addVariant(db, workspace.ctx, item.itemId, {
    [options[0].id]: 'Forest',
    [options[1].id]: '6',
  });

  assert.equal(added.label, 'Forest / 6');
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, added.skuId), 0);
  assert.equal(repo.listSkusForItem(db, workspace.workspaceId, item.itemId).length, 5);

  assert.throws(
    () =>
      itemService.addVariant(db, workspace.ctx, item.itemId, {
        [options[0].id]: 'Forest',
        [options[1].id]: '6',
      }),
    (err) => err.code === 'duplicate_variant'
  );
});

test('variants combine with lot tracking', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const created = itemService.createItem(db, workspace.ctx, {
    name: 'Small-Batch Jam',
    baseCode: 'JAM-12',
    trackingMode: 'lot',
    hasVariants: true,
    options: [{ name: 'Flavour', values: 'Strawberry, Peach' }],
  });
  const skus = repo.listSkusForItem(db, workspace.workspaceId, created.itemId);
  const strawberry = skus.find((s) => s.variant_label === 'Strawberry');
  const peach = skus.find((s) => s.variant_label === 'Peach');

  engine.receive(db, workspace.ctx, {
    skuId: strawberry.id,
    locationId: workspace.store.id,
    quantity: 48,
    lotCode: 'B-0417',
    expiresAt: '2027-04-17',
  });
  engine.receive(db, workspace.ctx, {
    skuId: peach.id,
    locationId: workspace.store.id,
    quantity: 36,
    lotCode: 'B-0422',
  });

  const strawberryLots = db.prepare('SELECT * FROM lots WHERE sku_id = ?').all(strawberry.id);
  assert.equal(strawberryLots.length, 1);
  assert.equal(strawberryLots[0].code, 'B-0417');
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, strawberry.id), 48);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, peach.id), 36);

  // The same lot code under a different variant is a different lot.
  assert.throws(
    () =>
      engine.issue(db, workspace.ctx, {
        skuId: peach.id,
        locationId: workspace.store.id,
        quantity: 1,
        lotId: strawberryLots[0].id,
      }),
    (err) => err.code === 'validation_error'
  );
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('variants combine with serial tracking', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const created = itemService.createItem(db, workspace.ctx, {
    name: 'Field Tablet',
    baseCode: 'TAB',
    trackingMode: 'serial',
    hasVariants: true,
    options: [{ name: 'Storage', values: '64GB, 128GB' }],
  });
  const skus = repo.listSkusForItem(db, workspace.workspaceId, created.itemId);
  const small = skus.find((s) => s.variant_label === '64GB');
  const large = skus.find((s) => s.variant_label === '128GB');

  engine.receive(db, workspace.ctx, {
    skuId: small.id,
    locationId: workspace.main.id,
    serials: [{ serial: 'T-1' }, { serial: 'T-2' }],
  });
  engine.receive(db, workspace.ctx, { skuId: large.id, locationId: workspace.main.id, serials: [{ serial: 'T-9' }] });

  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, small.id), 2);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, large.id), 1);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});
