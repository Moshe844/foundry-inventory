'use strict';

const { Pool } = require('pg');

function connectionOptions(connectionString, options = {}) {
  if (options.min !== undefined && (!Number.isSafeInteger(options.min) || options.min < 0 || options.min > (options.max || 10))) {
    throw new Error('PostgreSQL minimum connections must fit the configured pool.');
  }
  let address;
  try { address = new URL(connectionString); } catch { throw new Error('Provide a valid PostgreSQL connection URL.'); }
  if (!['postgres:', 'postgresql:'].includes(address.protocol) || !address.hostname || !address.pathname.slice(1)) {
    throw new Error('The PostgreSQL connection URL needs a host and database name.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
  const sslMode = address.searchParams.get('sslmode');
  const privateNetwork = options.privateNetwork === true;
  if (!local && !privateNetwork && ['disable', 'allow', 'prefer', 'no-verify'].includes(sslMode)) {
    throw new Error('Remote PostgreSQL requires certificate-verified TLS.');
  }
  let ssl;
  if ((local || privateNetwork) && (!sslMode || sslMode === 'disable')) ssl = false;
  else if (sslMode === 'require') ssl = { rejectUnauthorized: false };
  else ssl = { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) };
  return { host: address.hostname.replace(/^\[|\]$/g, ''), port: Number(address.port || 5432),
    database: decodeURIComponent(address.pathname.slice(1)), user: decodeURIComponent(address.username),
    password: decodeURIComponent(address.password), max: options.max || 10,
    ...(options.min !== undefined ? {min: options.min} : {}),
    connectionTimeoutMillis: options.connectionTimeoutMillis || 10000,
    idleTimeoutMillis: options.idleTimeoutMillis || 30000,
    application_name: options.applicationName || 'stockchief',
    ssl };
}

function openPostgres(connectionString, options = {}) {
  const resolvedOptions = {
    ...options,
    privateNetwork: options.privateNetwork ?? process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK === 'true',
  };
  const pool = new Pool(connectionOptions(connectionString, resolvedOptions));
  const errors = [];
  pool.on('error', (error) => {
    errors.push({ code: error.code || 'connection_error', at: new Date().toISOString() });
    if (errors.length > 20) errors.shift();
    if (options.onError) options.onError(error);
  });
  const measuredQuery=async(target,statement,values)=>{const start=process.hrtime.bigint();
    try{return await target.query(statement,values);}finally{require('../commercial/resource-metrics').queryFinished(start);}};
  const query = (statement, values = []) => measuredQuery(pool,statement,values);
  async function withSessionLock(key,operation){
    const client=await pool.connect();let locked=false,discard=false;
    try{locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
      if(!locked)return {busy:true};
      return await operation({query:(statement,values=[])=>measuredQuery(client,statement,values),transaction:(fn,settings)=>transaction(fn,settings,client)});
    }finally{try{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch{discard=true;}client.release(discard);}
  }
  async function listen(channel,onNotification){
    if(!/^[a-z][a-z0-9_]{0,62}$/.test(channel)||typeof onNotification!=='function')throw new TypeError('Invalid PostgreSQL notification subscription.');
    const client=await pool.connect();let closed=false;
    const received=message=>{if(!closed&&message.channel===channel)onNotification(message);};
    const failed=error=>{if(closed)return;closed=true;client.off('notification',received);client.release(error);};
    client.on('notification',received);client.on('error',failed);
    try{await client.query(`LISTEN "${channel}"`);}catch(error){failed(error);throw error;}
    return async()=>{if(closed)return;closed=true;client.off('notification',received);client.off('error',failed);
      let discard=false;try{await client.query(`UNLISTEN "${channel}"`);}catch{discard=true;}finally{client.release(discard);}};
  }
  async function transaction(operation, settings = {}, leasedClient = null) {
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
    const statementTimeoutMs = settings.statementTimeoutMs ?? 30000;
    const lockTimeoutMs = settings.lockTimeoutMs ?? 10000;
    for (const timeout of [statementTimeoutMs, lockTimeoutMs]) {
      if (!Number.isSafeInteger(timeout) || timeout < 1) throw new TypeError('PostgreSQL transaction timeouts must be positive integer milliseconds.');
    }
    for (let attempt = 0; ; attempt += 1) {
      const client = leasedClient || await pool.connect();
      let discard = false;
      try {
        // Establish the SAME transaction-local protections in one protocol
        // round trip. These literals are enum/positive-integer validated above;
        // no application SQL or user text is interpolated here. Do not start
        // the operation until PostgreSQL acknowledges every setup statement.
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}${settings.readOnly ? ' READ ONLY' : ''};` +
          ` SET LOCAL statement_timeout = '${statementTimeoutMs}ms';` +
          ` SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
        const result = await operation({ query: (statement, values = []) => measuredQuery(client,statement,values) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        if (!['40001', '40P01'].includes(error.code) || attempt >= retries) throw error;
      } finally {
        if(!leasedClient)client.release(discard);
      }
      const backoff = Math.min(1000, retryBaseDelayMs * (2 ** Math.min(attempt, 6)));
      const jitter = Math.floor(Math.random() * retryBaseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
    }
  }
  return { query, transaction, listen, withSessionLock, close: () => pool.end(), connectionErrors: errors,
    poolMetrics:()=>({max:pool.options.max,total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount}),
    topology: Object.freeze({ engine: 'postgresql', shared: true, multiWriter: true }) };
}

module.exports = { connectionOptions, openPostgres };
