'use strict';

const { spawnSync } = require('node:child_process');
const config = require('../src/config');
const { openDatabase } = require('../src/db');
const checkpoints = require('../src/operations/checkpoints');

const files = [
  'tests/unit/tenancy.test.js',
  'tests/integration/http-auth.test.js',
  'tests/unit/mission4-runtime.test.js',
];
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: config.rootDir });
if (result.status !== 0) {
  console.error('Adversarial certification failed. No passing evidence was recorded.');
  process.exit(result.status || 1);
}
const db = openDatabase(config.databasePath);
try {
  checkpoints.record(db, 'adversarial.runtime', 'PASS', {
    tenantIsolation: true, permissions: true, concurrency: true,
    duplicateDelivery: true, crashMidAction: true,
    files, releaseRef: config.operations.releaseRef,
  });
} finally { db.close(); }
console.log('Adversarial runtime evidence recorded.');

