'use strict';

const { openPostgres } = require('../src/db/postgres');
const { migratePostgres } = require('../src/db/migrate-postgres');

async function main() {
  const connectionString = process.env.FOUNDRY_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('FOUNDRY_DATABASE_URL is required.');
  const database = openPostgres(connectionString, {
    applicationName: 'stockchief-postgres-migrations',
    max: 2,
  });
  try {
    const applied = await migratePostgres(database);
    console.log(`[stockchief] PostgreSQL schema ready; ${applied.length} migration(s) applied.`);
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
