'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const backups = require('../src/operations/backup');
const config = require('../src/config');
const { openDatabase } = require('../src/db');

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/verify-restore.js path-to-backup.sqlite [--production-like --hosting-provider NAME --hosting-evidence TEXT]');
  process.exit(2);
}
function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}
const productionLike = process.argv.includes('--production-like');
const hostingProvider = valueAfter('--hosting-provider');
const hostingEvidence = valueAfter('--hosting-evidence');
const hostingVerified = productionLike && Boolean(hostingProvider && hostingEvidence);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-restore-test-'));
const destination = path.join(directory, 'restored.sqlite');
try {
  const result = backups.restoreTo(source, destination);
  if (productionLike && !result.committed) {
    throw new Error('A production-like restore requires the verified JSON manifest beside the backup.');
  }
  const evidenceDb = openDatabase(config.databasePath);
  try {
    require('../src/operations/checkpoints').record(evidenceDb, 'backup.restore', 'PASS', {
      source: result.source.path,
      workspaces: result.restored.workspaceCount,
      movements: result.restored.movementCount,
      journalEntries: result.restored.journalCount,
      sha256: result.source.sha256,
      committedBackup: result.committed,
      productionLike,
      hostingVerified,
      hostingProvider: hostingProvider || null,
      hostingEvidence: hostingEvidence || null,
    });
  } finally { evidenceDb.close(); }
  console.log('Restore test passed.');
  console.log(`Workspaces ${result.restored.workspaceCount}; movements ${result.restored.movementCount}; accounting entries ${result.restored.journalCount}.`);
  if (!hostingVerified) {
    console.log('Local restore verified; production certification remains blocked until a hosting-platform drill is recorded with provider and evidence.');
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
