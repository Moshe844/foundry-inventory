'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function migratePostgres(database) {
  const directory = path.join(__dirname, 'postgres-migrations');
  const files = fs.readdirSync(directory).filter((name) => /^\d{3}-[a-z-]+\.(?:sql|js)$/.test(name)).sort();
  return database.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(741923609)');
    await client.query(`CREATE TABLE IF NOT EXISTS stockchief_postgres_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = [];
    for (const name of files) {
      const migrationPath = path.join(directory, name);
      const statement = name.endsWith('.js')
        ? require(migrationPath).render()
        : fs.readFileSync(migrationPath, 'utf8');
      const checksum = crypto.createHash('sha256').update(statement).digest('hex');
      const prior = await client.query('SELECT checksum FROM stockchief_postgres_migrations WHERE name = $1', [name]);
      if (prior.rows.length) {
        if (prior.rows[0].checksum !== checksum) throw new Error(`Applied PostgreSQL migration ${name} has changed.`);
        continue;
      }
      await client.query(statement);
      await client.query('INSERT INTO stockchief_postgres_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      applied.push(name);
    }
    return applied;
  }, { isolation: 'READ COMMITTED', statementTimeoutMs: 120000 });
}

module.exports = { migratePostgres };
