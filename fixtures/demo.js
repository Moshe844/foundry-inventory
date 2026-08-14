'use strict';

/**
 * DEVELOPMENT AND TEST FIXTURES ONLY.
 *
 * Nothing in this file is imported by `src/`. It exists to prove that one
 * engine handles four fundamentally different kinds of inventory, and to give
 * a realistic dataset to click around in. Every write below goes through the
 * same public services the UI uses — fixtures get no privileged path into the
 * database, and the engine contains no knowledge of these examples.
 */

const authService = require('../src/domain/auth-service');
const locationService = require('../src/domain/location-service');
const itemService = require('../src/domain/item-service');
const engine = require('../src/domain/inventory-engine');
const repo = require('../src/domain/repository');

const DEMO_ACCOUNT = {
  workspaceName: 'Northwind Supply Co.',
  name: 'Dana Reyes',
  email: 'dana@northwind.test',
  password: 'foundry-demo-1',
};

const DEMO_STAFF = {
  name: 'Sam Okafor',
  email: 'sam@northwind.test',
  password: 'foundry-demo-1',
  role: 'staff',
};

function skuByLabel(db, workspaceId, itemId, label) {
  const skus = repo.listSkusForItem(db, workspaceId, itemId);
  if (!label) return skus[0];
  const found = skus.find((s) => s.variant_label === label);
  if (!found) throw new Error(`Demo fixture: no variant "${label}"`);
  return found;
}

/**
 * Seeds one workspace covering all four archetypes plus a combination
 * (variant + lot). Returns the ids so tests can navigate straight to them.
 */
function seedDemoWorkspace(db, overrides = {}) {
  const account = { ...DEMO_ACCOUNT, ...overrides };
  const { workspaceId, userId } = authService.registerAccount(db, account);
  const ctx = { workspaceId, actorId: userId };

  const staff = authService.createTeamMember(
    db,
    ctx,
    { role: 'owner' },
    DEMO_STAFF
  );

  const warehouse = locationService.createLocation(db, ctx, { name: 'Main Warehouse', kind: 'warehouse' });
  const store = locationService.createLocation(db, ctx, { name: 'Downtown Store', kind: 'store' });
  const van = locationService.createLocation(db, ctx, { name: 'Service Van 3', kind: 'truck' });

  // --- 1. Quantity ---------------------------------------------------------
  const elbow = itemService.createItem(db, ctx, {
    name: 'Copper Elbow 1/2 in.',
    baseCode: 'CE-100',
    description: '90 degree copper elbow, sweat fitting.',
    unitLabel: 'unit',
    trackingMode: 'quantity',
  });
  const elbowSku = skuByLabel(db, workspaceId, elbow.itemId);
  engine.receive(db, ctx, { skuId: elbowSku.id, locationId: warehouse.id, quantity: 150, reference: 'PO-4471' });
  engine.receive(db, ctx, { skuId: elbowSku.id, locationId: store.id, quantity: 60, reference: 'PO-4471' });
  engine.transfer(db, ctx, {
    skuId: elbowSku.id,
    fromLocationId: warehouse.id,
    toLocationId: van.id,
    quantity: 13,
    notes: 'Loaded for the Tuesday route.',
  });
  engine.issue(db, ctx, {
    skuId: elbowSku.id,
    locationId: store.id,
    quantity: 18,
    reasonCode: 'sold',
    reference: 'Counter sale 8823',
  });
  engine.adjust(db, ctx, {
    skuId: elbowSku.id,
    locationId: warehouse.id,
    countedQty: 134,
    reasonCode: 'physical_count',
    notes: 'Quarterly count, bin 14. Three short.',
  });

  // --- 2. Variants ---------------------------------------------------------
  const sweater = itemService.createItem(db, ctx, {
    name: "Children's Sweater",
    baseCode: 'CS-200',
    description: 'Lambswool crew neck.',
    unitLabel: 'unit',
    trackingMode: 'quantity',
    hasVariants: true,
    options: [
      { name: 'Colour', values: 'Navy, Cream' },
      { name: 'Size', values: '4, 5' },
    ],
  });
  const navy4 = skuByLabel(db, workspaceId, sweater.itemId, 'Navy / 4');
  const navy5 = skuByLabel(db, workspaceId, sweater.itemId, 'Navy / 5');
  const cream4 = skuByLabel(db, workspaceId, sweater.itemId, 'Cream / 4');
  engine.receive(db, ctx, { skuId: navy4.id, locationId: store.id, quantity: 13, reference: 'GRN-119' });
  engine.receive(db, ctx, { skuId: navy5.id, locationId: store.id, quantity: 8, reference: 'GRN-119' });
  engine.receive(db, ctx, { skuId: cream4.id, locationId: store.id, quantity: 16, reference: 'GRN-119' });
  engine.adjust(db, ctx, {
    skuId: navy4.id,
    locationId: store.id,
    countedQty: 12,
    reasonCode: 'physical_count',
    notes: 'One found damaged on the shelf.',
  });

  // --- 3. Serialized -------------------------------------------------------
  const laptop = itemService.createItem(db, ctx, {
    name: 'Dell Latitude 5450',
    baseCode: 'DL-5450',
    description: '14 in. business laptop, 16 GB RAM.',
    unitLabel: 'laptop',
    trackingMode: 'serial',
  });
  const laptopSku = skuByLabel(db, workspaceId, laptop.itemId);
  engine.receive(db, ctx, {
    skuId: laptopSku.id,
    locationId: warehouse.id,
    serials: [
      { serial: 'DL-829193' },
      { serial: 'DL-829194' },
      { serial: 'DL-829195' },
      { serial: 'DL-829196', condition: 'damaged' },
    ],
    reference: 'PO-4480',
  });
  const units = db
    .prepare('SELECT id, serial FROM serial_units WHERE workspace_id = ? AND sku_id = ? ORDER BY serial')
    .all(workspaceId, laptopSku.id);
  engine.transfer(db, ctx, {
    skuId: laptopSku.id,
    fromLocationId: warehouse.id,
    toLocationId: store.id,
    serialUnitIds: [units[0].id],
    notes: 'Assigned to the front desk.',
  });

  // --- 4. Lots / batches ---------------------------------------------------
  const rations = itemService.createItem(db, ctx, {
    name: 'Trail Ration Pack',
    baseCode: 'FOOD-200',
    description: 'Sealed 12-pack, ambient storage.',
    unitLabel: 'pack',
    trackingMode: 'lot',
  });
  const rationSku = skuByLabel(db, workspaceId, rations.itemId);
  engine.receive(db, ctx, {
    skuId: rationSku.id,
    locationId: warehouse.id,
    quantity: 84,
    lotCode: 'L240812',
    lotReceivedAt: '2026-08-12',
    expiresAt: '2026-10-30',
    reference: 'PO-4492',
  });
  engine.receive(db, ctx, {
    skuId: rationSku.id,
    locationId: warehouse.id,
    quantity: 120,
    lotCode: 'L240902',
    lotReceivedAt: '2026-09-02',
    expiresAt: '2027-01-15',
    reference: 'PO-4495',
  });
  const rationLots = db
    .prepare('SELECT id, code FROM lots WHERE workspace_id = ? AND sku_id = ? ORDER BY code')
    .all(workspaceId, rationSku.id);
  engine.transfer(db, ctx, {
    skuId: rationSku.id,
    fromLocationId: warehouse.id,
    toLocationId: store.id,
    lotId: rationLots[0].id,
    quantity: 24,
    notes: 'Oldest lot first.',
  });

  // --- 5. A supported combination: variants that are also lot tracked ------
  const jam = itemService.createItem(db, ctx, {
    name: 'Small-Batch Jam',
    baseCode: 'JAM-12',
    description: '12 oz jar. Each batch has its own best-before date.',
    unitLabel: 'jar',
    trackingMode: 'lot',
    hasVariants: true,
    options: [{ name: 'Flavour', values: 'Strawberry, Peach' }],
  });
  const strawberry = skuByLabel(db, workspaceId, jam.itemId, 'Strawberry');
  const peach = skuByLabel(db, workspaceId, jam.itemId, 'Peach');
  engine.receive(db, ctx, {
    skuId: strawberry.id,
    locationId: store.id,
    quantity: 48,
    lotCode: 'B-0417',
    expiresAt: '2027-04-17',
  });
  engine.receive(db, ctx, {
    skuId: peach.id,
    locationId: store.id,
    quantity: 36,
    lotCode: 'B-0422',
    expiresAt: '2026-09-10',
  });

  return {
    workspaceId,
    ownerId: userId,
    staffId: staff.id,
    account,
    locations: { warehouse, store, van },
    items: {
      elbow: { ...elbow, skuId: elbowSku.id },
      sweater: { ...sweater, navy4: navy4.id, navy5: navy5.id, cream4: cream4.id },
      laptop: { ...laptop, skuId: laptopSku.id, units },
      rations: { ...rations, skuId: rationSku.id, lots: rationLots },
      jam: { ...jam, strawberry: strawberry.id, peach: peach.id },
    },
  };
}

module.exports = { seedDemoWorkspace, DEMO_ACCOUNT, DEMO_STAFF };
