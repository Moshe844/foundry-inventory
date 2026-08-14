'use strict';

/** Development helper: deletes the database so the next start is clean. */

const fs = require('node:fs');
const config = require('../src/config');

if (config.env === 'production' && !process.env.FOUNDRY_ALLOW_DB_RESET) {
  console.error('Refusing to delete a production database.');
  process.exit(1);
}

let removed = 0;
for (const suffix of ['', '-wal', '-shm']) {
  const file = `${config.databasePath}${suffix}`;
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    removed += 1;
  }
}

console.log(removed ? `Removed ${removed} database ${removed === 1 ? 'file' : 'files'}.` : 'Nothing to remove.');
