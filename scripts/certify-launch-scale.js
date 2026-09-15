'use strict';

/*
 * Production-volume launch gate. This is deliberately separate from the fast
 * regression suite: tiny fixtures prove correctness, not 250k-SKU behaviour.
 *
 * Default: 250,000 SKUs, 12 locations, 1,000,000 immutable movements.
 * Override only for local smoke checks:
 *   node scripts/certify-launch-scale.js --skus 10000 --movements 50000
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { openDatabase } = require('../src/db');
const auth = require('../src/domain/auth-service');
const locationService = require('../src/domain/location-service');
const itemService = require('../src/domain/item-service');
const inventory = require('../src/domain/inventory-engine');
const inventoryQuery = require('../src/domain/inventory-query');
const search = require('../src/domain/search-service');
const signals = require('../src/signals/signal-engine');
const planning = require('../src/forecasting/planning-service');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}
const skuCount = arg('skus', 250000);
const movementCount = arg('movements', 1000000);
const locationCount = arg('locations', 12);
if (!Number.isSafeInteger(skuCount) || skuCount < 1 || !Number.isSafeInteger(movementCount) || movementCount < skuCount) {
  throw new Error('Use whole counts, with at least one movement per SKU.');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-scale-cert-'));
const databasePath = path.join(dir, 'scale.db');
const db = openDatabase(databasePath);
const metrics = {};
const timed = (name, fn) => {
  const started = performance.now();
  const result = fn();
  metrics[name] = Math.round((performance.now() - started) * 10) / 10;
  return result;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  const registered = auth.registerAccount(db, {
    workspaceName: 'Scale certification', name: 'Scale Owner',
    email: `scale-${Date.now()}@example.test`, password: 'production-certification-only',
  });
  const ctx = { workspaceId: registered.workspaceId, actorId: registered.userId, accountId: registered.accountId };
  db.prepare("UPDATE workspaces SET data_mode = 'synthetic' WHERE id = ?").run(ctx.workspaceId);
  const locations = Array.from({ length: locationCount }, (_, index) =>
    locationService.createLocation(db, ctx, { name: `Facility ${String(index + 1).padStart(2, '0')}`, kind: 'warehouse' }));
  const product = itemService.createItemShell(db, ctx, { name: 'High-cardinality configurable product',
    baseCode: 'SCALE', trackingMode: 'quantity' });

  timed('exactCatalogCreateMs', () => {
    for (let offset = 0; offset < skuCount; offset += 5000) {
      const size = Math.min(5000, skuCount - offset);
      itemService.addExactVariants(db, ctx, product.itemId,
        Array.from({ length: size }, (_, index) => {
          const n = offset + index;
          return { sourceKey: `source-sku-${n}`, code: `SCALE-${String(n).padStart(7, '0')}`,
            label: `Configuration ${n}`, options: {
              Family: `F${n % 50}`, Region: `R${n % 8}`, Grade: `G${n % 12}`, Revision: `V${n % 20}`,
            } };
        }));
    }
  });
  process.stdout.write(`catalogue ready: ${skuCount} SKUs in ${metrics.exactCatalogCreateMs}ms\n`);
  const skuRows = db.prepare('SELECT id FROM skus WHERE workspace_id = ? ORDER BY position').all(ctx.workspaceId);
  assert(skuRows.length === skuCount, `Expected ${skuCount} SKUs, found ${skuRows.length}.`);

  timed('millionMovementSeedMs', () => {
    const insertMovement = db.prepare(`INSERT INTO movements
      (id, workspace_id, group_id, operation, item_id, sku_id, location_id,
       quantity_delta, balance_after, notes, reference, actor_user_id, occurred_at)
      VALUES (?, ?, ?, 'receive', ?, ?, ?, 1, ?, 'Scale certification fixture', ?, ?, ?)`);
    const insertBalance = db.prepare(`INSERT INTO balances
      (workspace_id, sku_id, location_id, on_hand, updated_at) VALUES (?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    const base = Math.floor(movementCount / skuCount);
    const extra = movementCount % skuCount;
    const tx = db.transaction((start, end) => {
      for (let n = start; n < end; n += 1) {
        const skuIndex = n % skuCount;
        const pass = Math.floor(n / skuCount) + 1;
        const sku = skuRows[skuIndex];
        const location = locations[skuIndex % locations.length];
        insertMovement.run(`scale-mv-${n}`, ctx.workspaceId, `scale-grp-${n}`,
          product.itemId, sku.id, location.id, pass, `scale:${n}`, ctx.actorId, now);
      }
    });
    for (let start = 0; start < movementCount; start += 25000) tx.immediate(start, Math.min(start + 25000, movementCount));
    const balances = db.transaction(() => {
      skuRows.forEach((sku, index) => insertBalance.run(ctx.workspaceId, sku.id,
        locations[index % locations.length].id, base + (index < extra ? 1 : 0), now));
    });
    balances.immediate();
  });
  process.stdout.write(`ledger ready: ${movementCount} movements in ${metrics.millionMovementSeedMs}ms\n`);

  const exact = timed('exactSearchMs', () => search.search(db, ctx.workspaceId,
    `SCALE-${String(skuCount - 1).padStart(7, '0')}`));
  assert(exact.results[0]?.id === skuRows[skuCount - 1].id, 'Exact search did not resolve the last SKU.');
  process.stdout.write(`exact search: ${metrics.exactSearchMs}ms\n`);

  const fuzzy = timed('indexedDiscoveryMs', () => search.search(db,ctx.workspaceId,
    `configuration ${skuCount - 1}`));
  assert(fuzzy.results[0]?.id === skuRows[skuCount - 1].id,
    'Indexed human-language discovery did not resolve the last SKU.');
  process.stdout.write(`indexed discovery: ${metrics.indexedDiscoveryMs}ms\n`);

  const page1 = timed('catalogPageMs', () => inventoryQuery.listItems(db, ctx.workspaceId, { limit: 50 }));
  assert(page1.items.length === 1, 'The 250k-SKU product was not one catalog product.');
  assert(page1.items[0].sku_count === skuCount, 'Catalog SKU count does not reconcile.');
  process.stdout.write(`catalogue page: ${metrics.catalogPageMs}ms\n`);

  const sampleIds = skuRows.slice(-400).map((row) => row.id);
  const signalRows = timed('signal400Ms', () => signals.skuSignals(db, ctx.workspaceId, { skuIds: sampleIds }));
  assert(signalRows.length === 400, 'Signal engine did not return the complete sample.');
  process.stdout.write(`400 signals: ${metrics.signal400Ms}ms\n`);

  timed('planningSweep400Ms', () => planning.sweep(db, ctx.workspaceId, { scanLimit: 400, limit: 10 }));
  process.stdout.write(`planning batch 1: ${metrics.planningSweep400Ms}ms\n`);
  const cursor1 = db.prepare("SELECT last_key FROM manager_scan_cursors WHERE workspace_id = ? AND scan_name = 'planning'")
    .get(ctx.workspaceId).last_key;
  timed('planningNext400Ms', () => planning.sweep(db, ctx.workspaceId, { scanLimit: 400, limit: 10 }));
  process.stdout.write(`planning batch 2: ${metrics.planningNext400Ms}ms\n`);
  const cursor2 = db.prepare("SELECT last_key FROM manager_scan_cursors WHERE workspace_id = ? AND scan_name = 'planning'")
    .get(ctx.workspaceId).last_key;
  assert(cursor1 !== cursor2, 'Planning cursor did not advance beyond the first 400 SKUs.');

  const finalSku = skuRows[skuCount - 1];
  const finalLocation = locations[(skuCount - 1) % locations.length];
  const before = db.prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
    .get(ctx.workspaceId, finalSku.id, finalLocation.id).on_hand;
  timed('canonicalWriteMs', () => inventory.receive(db, ctx, { skuId: finalSku.id,
    locationId: finalLocation.id, quantity: 1, reference: 'scale-certification-live-write' }));
  const after = db.prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
    .get(ctx.workspaceId, finalSku.id, finalLocation.id).on_hand;
  assert(after === before + 1, 'Canonical inventory write failed at production volume.');

  const counts = {
    skus: db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?').get(ctx.workspaceId).n,
    locations: db.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ?').get(ctx.workspaceId).n,
    movements: db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(ctx.workspaceId).n,
  };
  assert(counts.skus === skuCount && counts.locations === locationCount
    && counts.movements === movementCount + 1, 'Final scale totals do not reconcile.');
  const budgets = { exactSearchMs: 2000, indexedDiscoveryMs:2000, catalogPageMs: 3000, signal400Ms: 10000,
    planningSweep400Ms: 120000, planningNext400Ms: 120000, canonicalWriteMs: 3000 };
  for (const [name, budget] of Object.entries(budgets)) assert(metrics[name] <= budget,
    `${name} took ${metrics[name]}ms; budget is ${budget}ms.`);
  process.stdout.write(`${JSON.stringify({ certified: true, scale: counts, metrics, budgets }, null, 2)}\n`);
} finally {
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
