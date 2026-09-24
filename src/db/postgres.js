'use strict';

const { Pool } = require('pg');

function connectionOptions(connectionString, options = {}) {
  let address;
  try { address = new URL(connectionString); } catch { throw new Error('Provide a valid PostgreSQL connection URL.'); }
  if (!['postgres:', 'postgresql:'].includes(address.protocol) || !address.hostname || !address.pathname.slice(1)) {
    throw new Error('The PostgreSQL connection URL needs a host and database name.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
  const sslMode = address.searchParams.get('sslmode');
  if (!local && ['disable', 'allow', 'prefer', 'no-verify'].includes(sslMode)) {
    throw new Error('Remote PostgreSQL requires certificate-verified TLS.');
  }
  return { host: address.hostname.replace(/^\[|\]$/g, ''), port: Number(address.port || 5432),
    database: decodeURIComponent(address.pathname.slice(1)), user: decodeURIComponent(address.username),
    password: decodeURIComponent(address.password), max: options.max || 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis || 10000,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    application_name: options.applicationName || 'stockchief',
    ssl: local && sslMode === 'disable' ? false : { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) } };
}

function openPostgres(connectionString, options = {}) {
  const pool = new Pool(connectionOptions(connectionString, options));
  const errors = [];
  pool.on('error', (error) => {
    errors.push({ code: error.code || 'connection_error', at: new Date().toISOString() });
    if (errors.length > 20) errors.shift();
    if (options.onError) options.onError(error);
  });
  const query = (statement, values = []) => pool.query(statement, values);
  async function transaction(operation, settings = {}) {
    const isolation = settings.isolation || 'SERIALIZABLE';
    if (!['SERIALIZABLE', 'REPEATABLE READ', 'READ COMMITTED'].includes(isolation)) {
      throw new Error('Unsupported PostgreSQL transaction isolation.');
    }
    const retries = settings.retrySafe ? settings.retries ?? 12 : 0;
    if (!Number.isInteger(retries) || retries < 0 || retries > 20) throw new TypeError('PostgreSQL retries must be an integer from zero to twenty.');
    const retryBaseDelayMs = settings.retryBaseDelayMs ?? 15;
    if (!Number.isSafeInteger(retryBaseDelayMs) || retryBaseDelayMs < 1 || retryBaseDelayMs > 1000) {
      throw new TypeError('PostgreSQL retry delay must be a positive integer no greater than one second.');
    }
    for (const timeout of [settings.statementTimeoutMs ?? 30000, settings.lockTimeoutMs ?? 10000]) {
      if (!Number.isSafeInteger(timeout) || timeout < 1) throw new TypeError('PostgreSQL transaction timeouts must be positive integer milliseconds.');
    }
    for (let attempt = 0; ; attempt += 1) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}${settings.readOnly ? ' READ ONLY' : ''}`);
        await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
          [String(settings.statementTimeoutMs ?? 30000), String(settings.lockTimeoutMs ?? 10000)]);
        const result = await operation({ query: (statement, values = []) => client.query(statement, values) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        if (!['40001', '40P01'].includes(error.code) || attempt >= retries) throw error;
      } finally {
        client.release(discard);
      }
      const backoff = Math.min(1000, retryBaseDelayMs * (2 ** Math.min(attempt, 6)));
      const jitter = Math.floor(Math.random() * retryBaseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
  return { query, transaction, close: () => pool.end(), connectionErrors: errors,
    topology: Object.freeze({ engine: 'postgresql', shared: true, multiWriter: true }) };
}

module.exports = { connectionOptions, openPostgres };
