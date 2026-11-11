'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const verifiedMigrations = new WeakMap();

async function migratePostgres(database, options = {}) {
  const directory = path.join(__dirname, 'postgres-migrations');
  let files = fs.readdirSync(directory).filter((name) => /^\d{3}-[a-z-]+\.(?:sql|js)$/.test(name)).sort();
  if(options?.through){const last=files.indexOf(options.through);if(last<0)throw new Error('Unknown migration cutoff: '+options.through);files=files.slice(0,last+1);}
  const applied = await database.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(741923609)');
    await client.query(`CREATE TABLE IF NOT EXISTS stockchief_postgres_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = [];
    for (const name of files) {
      const migrationPath = path.join(directory, name);
      const statement = name.endsWith('.js')
        ? require(migrationPath).render()
        : fs.readFileSync(migrationPath, 'utf8');
      // Migration identity is independent of repository/Windows line endings.
      // Keep the original statement for execution and the historical checksum
      // untouched. Actual SQL edits still fail the immutable migration check.
      const checksum = crypto.createHash('sha256').update(statement.replace(/\r\n/g,'\n')).digest('hex');
      const originalChecksum = crypto.createHash('sha256').update(statement).digest('hex');
      const prior = await client.query('SELECT checksum FROM stockchief_postgres_migrations WHERE name = $1', [name]);
      if (prior.rows.length) {
        if (![checksum,originalChecksum].includes(prior.rows[0].checksum)) throw new Error(`Applied PostgreSQL migration ${name} has changed.`);
        continue;
      }
      // Converting existing physical-quantity tables can rewrite several GiB.
      // Keep this single, bounded migration allowance out of runtime queries.
      const extendedQuantityMigration=name==='138-measured-stock-quantities.sql';
      if(extendedQuantityMigration)await client.query("SELECT set_config('statement_timeout','600000',true)");
      await client.query(statement);
      if(extendedQuantityMigration)await client.query("SELECT set_config('statement_timeout','120000',true)");
      await client.query('INSERT INTO stockchief_postgres_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      applied.push(name);
    }
    return applied;
  }, { isolation: 'READ COMMITTED', statementTimeoutMs: 120000, lockTimeoutMs:120000 });
  const verified = verifiedMigrations.get(database) || new Set();
  for (const name of files) verified.add(name);
  verifiedMigrations.set(database, verified);
  return applied;
}

function hasVerifiedMigration(database, name) {
  return verifiedMigrations.get(database)?.has(name) === true;
}

module.exports = { migratePostgres, hasVerifiedMigration };
