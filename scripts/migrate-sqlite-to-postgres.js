'use strict';

const path = require('node:path');
const { openPostgres } = require('../src/db/postgres');
const { migratePostgres } = require('../src/db/migrate-postgres');
const { migrateSqliteToPostgres } = require('../src/db/sqlite-to-postgres');

async function main() {
  const sqlitePath = path.resolve(process.argv[2] || '');
  const connectionString = process.env.FOUNDRY_DATABASE_URL;
  if (!process.argv[2]) throw new Error('Usage: node scripts/migrate-sqlite-to-postgres.js <sqlite-database-path>');
  if (!connectionString) throw new Error('Set FOUNDRY_DATABASE_URL to the empty PostgreSQL cutover database.');
  const postgres = openPostgres(connectionString, { applicationName: 'stockchief-cutover' });
  try {
    const applied = await migratePostgres(postgres);
    const result = await migrateSqliteToPostgres({ sqlitePath, postgres });
    process.stdout.write(`${JSON.stringify({ applied, ...result }, null, 2)}\n`);
  } finally {
    await postgres.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
