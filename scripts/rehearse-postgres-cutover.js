'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { startCluster } = require('../tests/helpers/postgres-cluster');
const { openPostgres } = require('../src/db/postgres');
const { migratePostgres } = require('../src/db/migrate-postgres');
const { migrateSqliteToPostgres } = require('../src/db/sqlite-to-postgres');

async function main() {
  if (process.env.STOCKCHIEF_REHEARSE_POSTGRES !== '1') {
    throw new Error('Set STOCKCHIEF_REHEARSE_POSTGRES=1 to acknowledge this local, temporary full-data rehearsal.');
  }
  const sourcePath = path.resolve(process.argv[2] || 'data/foundry-inventory.db');
  const cluster = await startCluster();
  const database = openPostgres(cluster.connectionString, {
    applicationName: 'stockchief-full-cutover-rehearsal', max: 4,
  });
  const snapshotPath = path.join(cluster.directory, 'source-snapshot.sqlite');
  const startedAt = Date.now();
  try {
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      let lastReported = -1;
      await source.backup(snapshotPath, { progress({ totalPages, remainingPages }) {
        const percent = Math.floor(((totalPages - remainingPages) / totalPages) * 100);
        if (percent >= lastReported + 10) {
          lastReported = percent;
          process.stderr.write(`[rehearsal] SQLite snapshot ${percent}%\n`);
        }
        return 1000;
      } });
    } finally {
      source.close();
    }
    const applied = await migratePostgres(database);
    let copiedTables = 0;
    const result = await migrateSqliteToPostgres({ sqlitePath: snapshotPath, postgres: database,
      migrationId: 'full-local-rehearsal', onProgress(progress) {
        copiedTables += 1;
        if (copiedTables === 1 || copiedTables % 20 === 0) {
          process.stderr.write(`[rehearsal] copying table ${copiedTables}: ${progress.table}\n`);
        }
      } });
    const size = await database.query(`SELECT pg_database_size(current_database()) AS bytes`);
    const largest = await database.query(`SELECT relname AS name,pg_total_relation_size(relid) AS bytes
      FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15`);
    const mismatchedTables = Object.entries(result.reconciliation.tables)
      .filter((entry) => !entry[1].match).map(([name]) => name);
    process.stdout.write(`${JSON.stringify({
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      migrationsApplied: applied,
      reused: result.reused,
      reconciliationMatches: result.reconciliation.matches,
      balancedJournal: result.reconciliation.balancedJournal,
      tableCount: Object.keys(result.reconciliation.tables).length,
      mismatchedTables,
      business: result.reconciliation.business,
      postgresBytes: Number(size.rows[0].bytes),
      largestTables: largest.rows.map((row) => ({ name: row.name, bytes: Number(row.bytes) })),
    }, null, 2)}\n`);
  } finally {
    await database.close();
    cluster.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
