'use strict';

/**
 * The Mission 7 scenario, as a workspace you can click through.
 *
 * Kids Tights in two warehouses, with a month of real trading behind it:
 * Brooklyn sells and is down to eight of Black / 5; New Jersey barely moves and
 * is sitting on sixty-one. Every number here arrives through the Mission 1
 * engine as a real movement — there are no written balances.
 *
 * Nothing is automated by the seed. The workspace starts supervised with no
 * policy, so the demo begins where a customer would: Foundry has noticed
 * something and is waiting to be told what it may do about it.
 *
 *   DATABASE_PATH=data/autopilot-demo.db node scripts/seed-autopilot-demo.js
 */

const path = require('path');
const fs = require('fs');

const databasePath = path.resolve(process.env.DATABASE_PATH || 'data/autopilot-demo.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(databasePath + suffix); } catch { /* nothing to remove */ }
}

const { openDatabase } = require('../src/db');
const authService = require('../src/domain/auth-service');
const itemService = require('../src/domain/item-service');
const locationService = require('../src/domain/location-service');
const engine = require('../src/domain/inventory-engine');
const repo = require('../src/domain/repository');
const reevaluate = require('../src/attention/reevaluate');

const DAY = 24 * 60 * 60 * 1000;

const ACCOUNT = {
  workspaceName: 'Little Legs',
  name: 'Marta Okonkwo',
  email: 'marta@littlelegs.test',
  password: 'foundry-demo-1',
};

const db = openDatabase(databasePath);
const { accountId, workspaceId, userId } = authService.registerAccount(db, ACCOUNT);
const ctx = { workspaceId, actorId: userId, accountId };

db.prepare(
  `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
     operational_defaults, inventory_model, updated_at)
   VALUES (?, datetime('now'), 1, ?, ?, ?, datetime('now'))`
).run(
  workspaceId,
  JSON.stringify({ item: 'Style' }),
  JSON.stringify({ adjustmentsRequireReason: true, allowNegativeStock: false, transfersEnabled: true }),
  JSON.stringify({ primaryArchetype: 'quantity', usesVariants: true, serialRules: { enabled: false }, lotRules: { enabled: false } })
);

const brooklyn = locationService.createLocation(db, ctx, { name: 'Brooklyn Warehouse', kind: 'warehouse' });
const jersey = locationService.createLocation(db, ctx, { name: 'New Jersey Warehouse', kind: 'warehouse' });

const created = itemService.createItem(db, ctx, {
  name: 'Kids Tights',
  baseCode: 'KT-100',
  trackingMode: 'quantity',
  hasVariants: true,
  options: [
    { name: 'Colour', values: 'Black, White' },
    { name: 'Size', values: '2, 5, 8' },
  ],
});
const skus = repo.listSkusForItem(db, workspaceId, created.itemId);
const bySize = (label) => skus.find((sku) => sku.variant_label === label);

// Opening stock across the range, then a month of trading.
const opening = [
  ['Black / 2', 40, 30], ['Black / 5', 29, 65], ['Black / 8', 35, 28],
  ['White / 2', 22, 26], ['White / 5', 31, 24], ['White / 8', 18, 20],
];
for (const [label, brooklynQty, jerseyQty] of opening) {
  const sku = bySize(label);
  engine.receive(db, ctx, { skuId: sku.id, locationId: brooklyn.id, quantity: brooklynQty });
  engine.receive(db, ctx, { skuId: sku.id, locationId: jersey.id, quantity: jerseyQty });
}

db.exec('DROP TRIGGER IF EXISTS movements_no_update');
const backdate = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
const sell = (label, locationId, quantity, daysAgo) => {
  const result = engine.issue(db, ctx, { skuId: bySize(label).id, locationId, quantity, reasonCode: 'sold' });
  for (const id of result.movementIds) backdate.run(new Date(Date.now() - daysAgo * DAY).toISOString(), id);
};

// The scenario: Brooklyn sells Black / 5 steadily, New Jersey hardly at all.
for (const [quantity, daysAgo] of [[5, 28], [4, 22], [3, 16], [4, 10], [5, 4]]) {
  sell('Black / 5', brooklyn.id, quantity, daysAgo);
}
sell('Black / 5', jersey.id, 4, 12);

// Ordinary trading on everything else, so the workspace does not look staged.
for (const [label, location, quantity, daysAgo] of [
  ['Black / 2', brooklyn.id, 6, 24], ['Black / 2', brooklyn.id, 5, 9],
  ['Black / 8', jersey.id, 4, 19], ['White / 5', brooklyn.id, 7, 15],
  ['White / 5', jersey.id, 3, 6], ['White / 2', brooklyn.id, 4, 11],
]) {
  sell(label, location, quantity, daysAgo);
}

db.exec(
  `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
   BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
);

reevaluate.refresh(db, workspaceId, 'seed');

const black5 = bySize('Black / 5');
console.log('Seeded the autopilot demo workspace.');
console.log(`  Database : ${databasePath}`);
console.log(`  Sign in  : ${ACCOUNT.email} / ${ACCOUNT.password}`);
console.log(`  Black / 5: Brooklyn ${repo.getBalance(db, workspaceId, black5.id, brooklyn.id)}, ` +
            `New Jersey ${repo.getBalance(db, workspaceId, black5.id, jersey.id)}`);
console.log('  Autopilot: supervised, no policies. Nothing is automated yet.');
db.close();
