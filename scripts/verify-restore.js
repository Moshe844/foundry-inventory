'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const backups = require('../src/operations/backup');

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/verify-restore.js path-to-backup.sqlite');
  process.exit(2);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-restore-test-'));
const destination = path.join(directory, 'restored.sqlite');
try {
  const result = backups.restoreTo(source, destination);
  console.log('Restore test passed.');
  console.log(`Workspaces ${result.restored.workspaceCount}; movements ${result.restored.movementCount}; accounting entries ${result.restored.journalCount}.`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
