'use strict';

/**
 * Deterministic inventory scenarios for the attention tests.
 *
 * Movements are written through the real Mission 1 engine, then back-dated so a
 * scenario can have months of history without the test waiting for it. Only the
 * `occurred_at` column is rewritten — quantities, balances and the ledger's own
 * arithmetic are untouched, so every scenario is a genuine engine state.
 */

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const itemService = require('../../src/domain/item-service');
const locationService = require('../../src/domain/location-service');
const planApplier = require('../../src/foundry/plan-applier');
const { nowIso } = require('../../src/lib/util');

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

/** Back-dates the movements written by the most recent operation. */
function backdate(db, movementIds, daysAgo) {
  const when = iso(daysAgo);
  // movements are immutable by trigger; scenarios need history, so the trigger
  // is lifted only for this rewrite and restored immediately.
  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const stmt = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  for (const id of movementIds) stmt.run(when, id);
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update
     BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );
}

function backdateAdjustment(db, movementIds, daysAgo) {
  const when = iso(daysAgo);
  const stmt = db.prepare('UPDATE adjustments SET created_at = ? WHERE movement_id = ?');
  for (const id of movementIds) stmt.run(when, id);
}

/** receive/issue/transfer/adjust, recorded as if it happened `daysAgo`. */
function at(db, ctx, daysAgo, operation, input) {
  const result = engine[operation](db, ctx, input);
  backdate(db, result.movementIds, daysAgo);
  if (operation === 'adjust') backdateAdjustment(db, result.movementIds, daysAgo);
  return result;
}

/** Marks the workspace as Foundry-configured, without a model call. */
function configure(db, workspaceId, overrides = {}) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
       operational_defaults, inventory_model, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       inventory_model = excluded.inventory_model,
       terminology = excluded.terminology,
       updated_at = excluded.updated_at`
  ).run(
    workspaceId,
    now,
    JSON.stringify(overrides.terminology || {}),
    JSON.stringify({ adjustmentsRequireReason: true, allowNegativeStock: false, transfersEnabled: true }),
    JSON.stringify({
      primaryArchetype: 'quantity',
      usesVariants: false,
      serialRules: { enabled: false },
      lotRules: { enabled: false },
      expirationRules: { enabled: false },
      ...overrides.inventoryModel,
    }),
    now
  );
}

/**
 * A SKU that has been selling steadily and is now nearly out.
 * 100 received 60 days ago, 90 issued across the period since.
 */
function stockoutScenario(db, workspace) {
  configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Navy Oxford',
    baseCode: 'NO-8',
    trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  at(db, workspace.ctx, 60, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 100 });
  // ~1.5/day over the last 30 days, in six separate movements.
  for (let i = 0; i < 6; i += 1) {
    at(db, workspace.ctx, 28 - i * 5, 'issue', {
      skuId: sku.id,
      locationId: workspace.main.id,
      quantity: 15,
      reasonCode: 'sold',
    });
  }
  return { itemId: item.itemId, skuId: sku.id };
}

/** Stock piled up where it is not needed, short where it is. */
function imbalanceScenario(db, workspace) {
  configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Cream Loafer',
    baseCode: 'CL-9',
    trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  at(db, workspace.ctx, 70, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 40 });
  at(db, workspace.ctx, 70, 'receive', { skuId: sku.id, locationId: workspace.store.id, quantity: 60 });

  // The store sells steadily; the warehouse barely moves.
  for (let i = 0; i < 6; i += 1) {
    at(db, workspace.ctx, 26 - i * 4, 'issue', {
      skuId: sku.id,
      locationId: workspace.store.id,
      quantity: 9,
      reasonCode: 'sold',
    });
  }
  at(db, workspace.ctx, 15, 'issue', { skuId: sku.id, locationId: workspace.main.id, quantity: 2, reasonCode: 'sold' });

  return { itemId: item.itemId, skuId: sku.id };
}

/** Small routine corrections, then one far outside them. */
function adjustmentAnomalyScenario(db, workspace) {
  configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Tan Belt',
    baseCode: 'TB-1',
    trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  at(db, workspace.ctx, 40, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 120 });

  // Routine: -1, +2, -2
  at(db, workspace.ctx, 30, 'adjust', { skuId: sku.id, locationId: workspace.main.id, countedQty: 119, reasonCode: 'physical_count' });
  at(db, workspace.ctx, 22, 'adjust', { skuId: sku.id, locationId: workspace.main.id, countedQty: 121, reasonCode: 'found' });
  at(db, workspace.ctx, 12, 'adjust', { skuId: sku.id, locationId: workspace.main.id, countedQty: 119, reasonCode: 'physical_count' });
  // Then a big one.
  const big = at(db, workspace.ctx, 1, 'adjust', {
    skuId: sku.id,
    locationId: workspace.main.id,
    countedQty: 94,
    reasonCode: 'physical_count',
    notes: 'Counted twice.',
  });

  return { itemId: item.itemId, skuId: sku.id, adjustmentMovementId: big.movementIds[0] };
}

/** A lot with real quantity approaching its expiry date. */
function expirationScenario(db, workspace) {
  configure(db, workspace.workspaceId, {
    inventoryModel: {
      primaryArchetype: 'lot',
      lotRules: { enabled: true },
      expirationRules: { enabled: true },
    },
  });
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Chilled Yoghurt',
    baseCode: 'CY-12',
    trackingMode: 'lot',
    unitLabel: 'case',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  at(db, workspace.ctx, 20, 'receive', {
    skuId: sku.id,
    locationId: workspace.main.id,
    quantity: 80,
    lotCode: 'L240812',
    expiresAt: new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10),
  });
  // Some movement, but nowhere near enough to clear 80 in a fortnight.
  at(db, workspace.ctx, 10, 'issue', {
    skuId: sku.id,
    locationId: workspace.main.id,
    lotId: db.prepare('SELECT id FROM lots WHERE sku_id = ?').get(sku.id).id,
    quantity: 4,
    reasonCode: 'sold',
  });

  const lot = db.prepare('SELECT * FROM lots WHERE sku_id = ?').get(sku.id);
  return { itemId: item.itemId, skuId: sku.id, lotId: lot.id, lotCode: lot.code };
}

/** Quantity on hand that has not moved for months. */
function staleScenario(db, workspace) {
  configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Corduroy Cap',
    baseCode: 'CC-1',
    trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  at(db, workspace.ctx, 200, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 60 });
  at(db, workspace.ctx, 160, 'issue', { skuId: sku.id, locationId: workspace.main.id, quantity: 10, reasonCode: 'sold' });
  return { itemId: item.itemId, skuId: sku.id };
}

/** A serialized unit that has sat in one place for a long time. */
function serializedInactivityScenario(db, workspace) {
  configure(db, workspace.workspaceId, {
    inventoryModel: { primaryArchetype: 'serial', serialRules: { enabled: true } },
  });
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Excavator',
    baseCode: 'EX-1',
    trackingMode: 'serial',
    unitLabel: 'machine',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  at(db, workspace.ctx, 200, 'receive', {
    skuId: sku.id,
    locationId: workspace.main.id,
    serials: [{ serial: 'EX-0001' }, { serial: 'EX-0002' }],
  });
  // One machine goes back out recently; the other has not moved at all.
  const units = db.prepare('SELECT * FROM serial_units WHERE sku_id = ? ORDER BY serial').all(sku.id);
  at(db, workspace.ctx, 3, 'transfer', {
    skuId: sku.id,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    serialUnitIds: [units[0].id],
  });

  return { itemId: item.itemId, skuId: sku.id, idleUnitId: units[1].id, idleSerial: units[1].serial };
}

/** Well-stocked, steadily moving, ordinary corrections: nothing to report. */
function healthyScenario(db, workspace) {
  configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Everyday Sock',
    baseCode: 'ES-1',
    trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  at(db, workspace.ctx, 45, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 400 });
  at(db, workspace.ctx, 20, 'receive', { skuId: sku.id, locationId: workspace.store.id, quantity: 300 });
  for (let i = 0; i < 5; i += 1) {
    at(db, workspace.ctx, 24 - i * 5, 'issue', { skuId: sku.id, locationId: workspace.main.id, quantity: 6, reasonCode: 'sold' });
    at(db, workspace.ctx, 22 - i * 5, 'issue', { skuId: sku.id, locationId: workspace.store.id, quantity: 5, reasonCode: 'sold' });
  }
  at(db, workspace.ctx, 8, 'adjust', { skuId: sku.id, locationId: workspace.main.id, countedQty: 369, reasonCode: 'physical_count' });

  return { itemId: item.itemId, skuId: sku.id };
}

module.exports = {
  at,
  backdate,
  configure,
  iso,
  DAY,
  stockoutScenario,
  imbalanceScenario,
  adjustmentAnomalyScenario,
  expirationScenario,
  staleScenario,
  serializedInactivityScenario,
  healthyScenario,
};
