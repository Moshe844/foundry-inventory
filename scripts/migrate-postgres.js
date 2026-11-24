'use strict';

const { openPostgres } = require('../src/db/postgres');
const { migratePostgres } = require('../src/db/migrate-postgres');

async function main() {
  // A separate owner login runs migrations when the website itself uses a login
  // that cannot change the database's structure (the AWS database).
  const connectionString = process.env.FOUNDRY_DATABASE_MIGRATION_URL || process.env.FOUNDRY_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('FOUNDRY_DATABASE_URL is required.');
  const database = openPostgres(connectionString, {
    applicationName: 'stockchief-postgres-migrations',
    max: 2,
  });
  try {
    const applied = await migratePostgres(database);
    console.log(`[stockchief] PostgreSQL schema ready; ${applied.length} migration(s) applied.`);
    const runtimeRole = process.env.FOUNDRY_DATABASE_RUNTIME_ROLE;
    if (runtimeRole) {
      const granted = await require('../src/db/runtime-grants').grant(database, runtimeRole);
      console.log(`[stockchief] Website login ${granted.role} can read and write ${granted.schemas.length} schema(s).`);
    }
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
