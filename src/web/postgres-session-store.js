'use strict';

const session = require('express-session');
const { openPostgres } = require('../db/postgres');

class PostgresSessionStore extends session.Store {
  constructor(database, options = {}) {
    super();
    this.database = database;
    this.options = options;
    this.ready = database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(741923608)');
      await client.query('CREATE SCHEMA IF NOT EXISTS stockchief_runtime');
      await client.query(`CREATE TABLE IF NOT EXISTS stockchief_runtime.sessions (
        sid TEXT PRIMARY KEY, expires_at BIGINT NOT NULL, data JSONB NOT NULL)`);
      await client.query(`CREATE INDEX IF NOT EXISTS sessions_expiry
        ON stockchief_runtime.sessions(expires_at)`);
    }, { isolation: 'READ COMMITTED' });
    this.ready.catch(() => {});
    this.timer = setInterval(() => this.sweep().catch((error) => {
      if (this.listenerCount('error')) this.emit('error', error);
      else console.error(`[stockchief] PostgreSQL session sweep failed: ${error.code || 'database_error'}`);
    }), options.sweepIntervalMs || 3600000);
    this.timer.unref();
  }

  expiryFor(value) {
    const maxAge = value?.cookie?.maxAge || 14 * 86400000;
    return Date.now() + (value?.accountId ? maxAge : Math.min(maxAge, this.options.anonymousMaxAgeMs || 3600000));
  }

  get(sid, callback) {
    this.ready.then(() => this.database.query(`SELECT data FROM stockchief_runtime.sessions
      WHERE sid = $1 AND expires_at > $2`,
      [sid, Date.now()])).then((result) => callback(null, result.rows[0]?.data || null), callback);
  }

  set(sid, value, callback = () => {}) {
    this.ready.then(() => this.database.query(`INSERT INTO stockchief_runtime.sessions(sid, expires_at, data)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data`,
    [sid, this.expiryFor(value), JSON.stringify(value)])).then(() => callback(null), callback);
  }

  touch(sid, value, callback = () => {}) {
    this.ready.then(() => this.database.query(`UPDATE stockchief_runtime.sessions
      SET expires_at = $1 WHERE sid = $2`,
      [this.expiryFor(value), sid])).then(() => callback(null), callback);
  }

  destroy(sid, callback = () => {}) {
    this.ready.then(() => this.database.query('DELETE FROM stockchief_runtime.sessions WHERE sid = $1', [sid]))
      .then(() => callback(null), callback);
  }

  async sweep() {
    await this.ready;
    await this.database.query('DELETE FROM stockchief_runtime.sessions WHERE expires_at <= $1', [Date.now()]);
  }

  async close() {
    clearInterval(this.timer);
    if (this.options.ownsDatabase) await this.database.close();
  }
}

function createPostgresSessionStore(connectionString, options = {}) {
  const database = openPostgres(connectionString, { applicationName: 'stockchief-sessions' });
  return new PostgresSessionStore(database, { ...options, ownsDatabase: true });
}

module.exports = { PostgresSessionStore, createPostgresSessionStore };
