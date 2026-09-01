'use strict';

const config = require('../src/config');
const { openDatabase } = require('../src/db');
const backups = require('../src/operations/backup');

async function main() {
  config.ensureDataDir();
  const db = openDatabase(config.databasePath);
  try {
    const result = await backups.create(db, {
      directory: config.backups.directory,
      retentionDays: config.backups.retentionDays,
    });
    console.log(`Verified backup: ${result.path}`);
    console.log(`Workspaces ${result.verification.workspaceCount}; movements ${result.verification.movementCount}; accounting entries ${result.verification.journalCount}.`);
  } finally { db.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
