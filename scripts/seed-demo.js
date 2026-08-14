'use strict';

/** Development helper: fills a database with the demo workspace. */

const config = require('../src/config');
const { openDatabase } = require('../src/db');
const { seedDemoWorkspace, DEMO_ACCOUNT } = require('../fixtures/demo');
const { addOperatingHistory } = require('../fixtures/demo-history');

if (config.env === 'production' && !process.env.FOUNDRY_ALLOW_DEMO_SEED) {
  console.error('Refusing to seed demo data into a production database.');
  console.error('Set FOUNDRY_ALLOW_DEMO_SEED=1 if you really mean it.');
  process.exit(1);
}

config.ensureDataDir();
const db = openDatabase(config.databasePath);

const existing = db.prepare('SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE').get(DEMO_ACCOUNT.email);
if (existing) {
  console.log(`Demo workspace already present (${DEMO_ACCOUNT.email}). Nothing to do.`);
  process.exit(0);
}

const result = seedDemoWorkspace(db);
// Two months of trading, so the operator has something real to reason about.
const run = addOperatingHistory(db, result);
db.close();

console.log('Seeded the demo workspace.');
console.log(`  Database : ${config.databasePath}`);
console.log(`  Sign in  : ${result.account.email} / ${result.account.password}`);
console.log('  Archetypes: quantity, variants, serialized, lots, and variants+lots.');
console.log(`  Attention : ${run.opened} items detected from the movement history.`);
