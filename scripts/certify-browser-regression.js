'use strict';

const { spawnSync } = require('node:child_process');
const config = require('../src/config');
const { openDatabase } = require('../src/db');
const checkpoints = require('../src/operations/checkpoints');

const runs = Math.max(2, Number(process.argv[2] || 2));
const files = [
  'tests/e2e/inventory.e2e.js', 'tests/e2e/foundry.e2e.js',
  'tests/e2e/attention.e2e.js', 'tests/e2e/workspaces.e2e.js',
  'tests/e2e/actions.e2e.js', 'tests/e2e/imports.e2e.js',
  'tests/e2e/purchasing.e2e.js', 'tests/e2e/onboarding.e2e.js',
  'tests/e2e/autopilot.e2e.js', 'tests/e2e/autopilot-authority.e2e.js',
  'tests/e2e/payment-window.e2e.js',
  'tests/e2e/warehouse.e2e.js',
];
let passed = 0;
for (let index = 1; index <= runs; index += 1) {
  console.log(`Full browser regression ${index}/${runs}`);
  const result = spawnSync(process.execPath, ['-r', './tests/helpers/test-models.js', '--test',
    '--test-concurrency=1', ...files], { stdio: 'inherit', cwd: config.rootDir });
  if (result.status !== 0) {
    if (result.error) console.error(result.error);
    console.error(`Browser regression failed on run ${index}. No certification was recorded.`);
    process.exit(result.status || 1);
  }
  passed += 1;
}

const db = openDatabase(config.databasePath);
try {
  checkpoints.record(db, 'browser.regression', 'PASS', {
    fullSuite: true, consecutivePasses: passed, command: 'npm run test:e2e', files,
    releaseRef: config.operations.releaseRef,
  });
} finally { db.close(); }
console.log(`${passed} consecutive full browser runs passed and were recorded.`);
