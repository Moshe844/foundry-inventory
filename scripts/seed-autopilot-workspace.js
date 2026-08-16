'use strict';

/**
 * Adds a demo inventory with enough trading history for the autopilot to have
 * an opinion, to an account that already exists.
 *
 * The operator layer reasons about stock levels, demand and days of cover. A
 * brand-new inventory has none of those, so it correctly has nothing to say —
 * which makes a fresh workspace the worst possible place to judge it from. This
 * seeds the thing it needs: two locations, one product, and a month of real
 * trading where one location is selling and the other is not.
 *
 * Every number arrives through the Mission 1 engine as a real movement. There
 * are no written balances, and nothing here is automated: the workspace is left
 * supervised with no policy, so the customer still grants authority themselves
 * and sees each gate do its job.
 *
 *   node scripts/seed-autopilot-workspace.js you@example.com
 */

const path = require('path');
const config = require('../src/config');
const { openDatabase } = require('../src/db');
const authService = require('../src/domain/auth-service');
const itemService = require('../src/domain/item-service');
const locationService = require('../src/domain/location-service');
const engine = require('../src/domain/inventory-engine');
const repo = require('../src/domain/repository');
const reevaluate = require('../src/attention/reevaluate');

const DAY = 24 * 60 * 60 * 1000;
const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/seed-autopilot-workspace.js you@example.com');
  process.exit(1);
}

const databasePath = path.resolve(process.env.DATABASE_PATH || config.databasePath);
const db = openDatabase(databasePath);

const account = db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
if (!account) {
  console.error(`No account with that email in ${databasePath}.`);
  process.exit(1);
}

const name = process.env.WORKSPACE_NAME || 'Baby Headbands (demo)';
const existing = db
  .prepare(
    `SELECT w.id FROM workspaces w JOIN users u ON u.workspace_id = w.id
      WHERE u.account_id = ? AND w.name = ?`
  )
  .get(account.id, name);
if (existing) {
  console.error(`"${name}" already exists. Delete it in Foundry first, or set WORKSPACE_NAME.`);
  process.exit(1);
}

const { workspaceId, userId } = authService.createWorkspaceFor(db, account.id, name);
const ctx = { workspaceId, actorId: userId, accountId: account.id };

db.prepare(
  `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
     operational_defaults, inventory_model, updated_at)
   VALUES (?, datetime('now'), 1, ?, ?, ?, datetime('now'))`
).run(
  workspaceId,
  JSON.stringify({ item: null, location: null, serialUnit: null, lot: null, variant: null }),
  JSON.stringify({ adjustmentsRequireReason: true, allowNegativeStock: false, transfersEnabled: true }),
  JSON.stringify({
    primaryArchetype: 'quantity',
    usesVariants: true,
    variantDimensions: [
      { name: 'Size', exampleValues: ['0-6 months', '6-12 months', '12-24 months'] },
      { name: 'Color', exampleValues: ['White', 'Red', 'Blue', 'Purple', 'Green'] },
    ],
    serialRules: { enabled: false },
    lotRules: { enabled: false },
    expirationRules: { enabled: false },
  })
);

const brooklyn = locationService.createLocation(db, ctx, { name: 'Brooklyn Warehouse', kind: 'warehouse' });
const jersey = locationService.createLocation(db, ctx, { name: 'New Jersey Warehouse', kind: 'warehouse' });

const created = itemService.createItem(db, ctx, {
  name: 'Baby headband',
  baseCode: 'BH-100',
  trackingMode: 'quantity',
  hasVariants: true,
  options: [
    { name: 'Size', values: '0-6 months, 6-12 months, 12-24 months' },
    { name: 'Color', values: 'White, Red, Blue, Purple, Green' },
  ],
});
const skus = repo.listSkusForItem(db, workspaceId, created.itemId);
const bySku = (label) => skus.find((sku) => sku.variant_label === label);

// Opening stock across the range. Deliberately uneven: a real wholesaler does
// not hold the same number of every colour.
const opening = [
  ['0-6 months / White', 30, 40], ['0-6 months / Red', 24, 26], ['0-6 months / Blue', 20, 22],
  ['0-6 months / Purple', 16, 18], ['0-6 months / Green', 14, 16],
  ['6-12 months / White', 29, 65], ['6-12 months / Red', 22, 28], ['6-12 months / Blue', 26, 24],
  ['6-12 months / Purple', 18, 20], ['6-12 months / Green', 15, 17],
  ['12-24 months / White', 28, 30], ['12-24 months / Red', 20, 22], ['12-24 months / Blue', 24, 20],
  ['12-24 months / Purple', 17, 19], ['12-24 months / Green', 13, 15],
];
for (const [label, brooklynQty, jerseyQty] of opening) {
  const sku = bySku(label);
  engine.receive(db, ctx, { skuId: sku.id, locationId: brooklyn.id, quantity: brooklynQty });
  engine.receive(db, ctx, { skuId: sku.id, locationId: jersey.id, quantity: jerseyQty });
}

// A month of trading. Backdating is the only reason the trigger comes off, and
// it goes straight back on.
db.exec('DROP TRIGGER IF EXISTS movements_no_update');
const backdate = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
const sell = (label, locationId, quantity, daysAgo) => {
  const result = engine.issue(db, ctx, { skuId: bySku(label).id, locationId, quantity, reasonCode: 'sold' });
  for (const id of result.movementIds) backdate.run(new Date(Date.now() - daysAgo * DAY).toISOString(), id);
};

// The one Foundry should act on: Brooklyn sells White 6-12 steadily and is down
// to eight; New Jersey has sixty-one and has barely moved any.
for (const [quantity, daysAgo] of [[5, 28], [4, 22], [3, 16], [4, 10], [5, 4]]) {
  sell('6-12 months / White', brooklyn.id, quantity, daysAgo);
}
sell('6-12 months / White', jersey.id, 4, 12);

// Ordinary trading elsewhere, so the workspace does not look staged and Foundry
// has plenty of positions it correctly leaves alone.
for (const [label, location, quantity, daysAgo] of [
  ['0-6 months / White', brooklyn.id, 6, 24], ['0-6 months / White', brooklyn.id, 5, 9],
  ['0-6 months / Red', brooklyn.id, 4, 17], ['0-6 months / Blue', jersey.id, 3, 20],
  ['6-12 months / Red', brooklyn.id, 5, 15], ['6-12 months / Red', jersey.id, 3, 6],
  ['12-24 months / White', brooklyn.id, 7, 13], ['12-24 months / Blue', brooklyn.id, 4, 21],
  ['12-24 months / Green', jersey.id, 2, 8],
]) {
  sell(label, location, quantity, daysAgo);
}
db.exec(
  `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
   BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
);

reevaluate.refresh(db, workspaceId, 'seed');

const short = bySku('6-12 months / White');
console.log(`Added "${name}" to ${account.email}.`);
console.log(`  Database   : ${databasePath}`);
console.log(`  Locations  : Brooklyn Warehouse, New Jersey Warehouse`);
console.log(`  Product    : Baby headband, 15 combinations, a month of trading behind them`);
console.log(
  `  The one to watch: 6-12 months / White — Brooklyn ` +
  `${repo.getBalance(db, workspaceId, short.id, brooklyn.id)}, New Jersey ` +
  `${repo.getBalance(db, workspaceId, short.id, jersey.id)}`
);
console.log('  Autopilot  : supervised, no policies. Nothing is automated until you say so.');
db.close();
