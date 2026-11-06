'use strict';

const { Pool } = require('pg');
const resourceMetrics = require('../commercial/resource-metrics');

function connectionOptions(connectionString, options = {}) {
  const statementTimeoutMs=options.statementTimeoutMs??30000;
  if(!Number.isSafeInteger(statementTimeoutMs)||statementTimeoutMs<1||statementTimeoutMs>2147483647){
    throw new TypeError('PostgreSQL statement timeout must be a positive bounded integer.');
  }
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
    statement_timeout: statementTimeoutMs,
    ssl };
}

function openPostgres(connectionString, options = {}) {
  const resolvedOptions = {
    ...options,
    privateNetwork: options.privateNetwork ?? process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK === 'true',
  };
  const pool = new Pool(connectionOptions(connectionString, resolvedOptions));
  const subscriptions=new Set(),committedWrites=new Set();
  let readModelTargets=null;
  const changed=(workspaces,business)=>{for(const callback of committedWrites){try{callback(workspaces?.size?workspaces:null,business);}catch{errors.push({code:'cache_invalidation_failed',at:new Date().toISOString()});if(errors.length>20)errors.shift();}}};
  const workspaceIds=values=>new Set(values.filter(v=>typeof v==='string'&&/^wsp_[a-z0-9]+$/.test(v)));
  const writes=statement=>/\b(?:INSERT\s+INTO|UPDATE\s+[a-z_"\[]|DELETE\s+FROM|TRUNCATE\s)/i.test(statement);
  const affectsBusiness=statement=>!/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:work_items|workspace_autopilot|attention_items)\b/i.test(statement);
  const mutated=(statement,result)=>{
    if(!readModelTargets||!writes(statement)||(['INSERT','UPDATE','DELETE'].includes(result.command)&&result.rowCount===0))return false;
    for(const match of String(statement).matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?/gi))if(readModelTargets.has(match[1].toLowerCase()))return true;
    return false;
  };
  const errors = [];
  pool.on('error', (error) => {
    errors.push({ code: error.code || 'connection_error', at: new Date().toISOString() });
    if (errors.length > 20) errors.shift();
    if (options.onError) options.onError(error);
  });
  const measuredQuery=async(target,statement,values)=>{const start=process.hrtime.bigint();
    try{return await target.query(statement,values);}catch(error){
      if(error.code==='55000'&&String(error.message).startsWith('This inventory is completing its ERP cutover.'))throw new (require('../domain/errors').InvariantError)(error.message,'cutover_in_progress');
      if(error.code==='23514'&&['stock_quantity_precision','stock_unit_definition'].includes(error.constraint))throw new (require('../domain/errors').ValidationError)(error.message);
      if(error.code==='23514'&&['inventory_plan_capacity','commercial_storage_capacity'].includes(error.constraint))
        throw new (require('../commercial/entitlements').EntitlementError)(error.message,{constraint:error.constraint});
      throw error;
    }finally{resourceMetrics.queryFinished(start);}};
  // COMMIT includes deferred foreign-key/constraint checks and WAL flushes.
  // Omitting these round trips attributes database time to application work
  // and hides the cost of rolled-back attempts. Preserve control-query errors.
  const controlQuery=async(client,statement,values)=>{const start=process.hrtime.bigint();
    try{return await client.query(statement,values);}finally{resourceMetrics.queryFinished(start);}};
  const query = async(statement, values = []) => {const result=await measuredQuery(pool,statement,values);if(mutated(statement,result))changed(workspaceIds(values),affectsBusiness(statement));return result;};
  async function withSessionLock(key,operation){
    const client=await pool.connect();let locked=false,discard=false;
    try{locked=(await controlQuery(client,'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
      if(!locked)return {busy:true};
      return await operation({query:async(statement,values=[])=>{const result=await measuredQuery(client,statement,values);if(mutated(statement,result))changed(workspaceIds(values),affectsBusiness(statement));return result;},transaction:(fn,settings)=>transaction(fn,settings,client)});
    }finally{try{if(locked)await controlQuery(client,'SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch{discard=true;}client.release(discard);}
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
    if(settings.jit!==undefined&&typeof settings.jit!=='boolean')throw new TypeError('PostgreSQL JIT must be a boolean transaction setting.');
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
        await controlQuery(client,`BEGIN ISOLATION LEVEL ${isolation}${settings.readOnly ? ' READ ONLY' : ''};` +
          ` SET LOCAL statement_timeout = '${statementTimeoutMs}ms';` +
          ` SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`+
          (settings.jit===undefined?'':`; SET LOCAL jit = '${settings.jit?'on':'off'}'`));
        let wrote=false,business=false;const workspaces=new Set();
        const result = await operation({ query: async(statement, values = []) => {const result=await measuredQuery(client,statement,values);if(mutated(statement,result)){wrote=true;business||=affectsBusiness(statement);for(const id of workspaceIds(values))workspaces.add(id);}return result;} });
        await controlQuery(client,'COMMIT');
        if(wrote)changed(workspaces,business);
        return result;
      } catch (error) {
        try { await controlQuery(client,'ROLLBACK'); } catch { discard = true; }
        if (!['40001', '40P01'].includes(error.code) || attempt >= retries) throw error;
      } finally {
        if(!leasedClient)client.release(discard);
      }
      const backoff = Math.min(1000, retryBaseDelayMs * (2 ** Math.min(attempt, 6)));
      // Spread retries across the growing window. A fixed 15ms jitter keeps
      // contending transactions synchronized once the backoff reaches 1s,
      // so a hot order counter can exhaust every retry despite making progress.
      const delay = Math.ceil(backoff / 2) + Math.floor(Math.random() * Math.ceil(backoff / 2));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { query, transaction, listen, withSessionLock,
    subscribe:(channel,notify,settings={})=>{const subscription=require('./postgres-subscription').subscribe(connectionOptions(connectionString,resolvedOptions),channel,notify,{...settings,onConnect:async client=>{
      // Discover the authoritative trigger targets once at listener startup,
      // not on cached reads. Telemetry/session/commercial writes are excluded.
      if(channel==='stockchief_read_models')readModelTargets=new Set((await client.query("SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname IN('stockchief_changed_read_model','stockchief_changed_workspace_read_model','stockchief_changed_account_business_time')")).rows.map(r=>r.relname));
      await settings.onConnect?.(client);
    }});subscriptions.add(subscription);return subscription;},
    onCommittedWrite:callback=>{committedWrites.add(callback);return()=>committedWrites.delete(callback);},
    close:async()=>{await Promise.all([...subscriptions].map(s=>s.stop()));committedWrites.clear();await pool.end();},connectionErrors: errors,
    poolMetrics:()=>({max:pool.options.max,total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount}),
    topology: Object.freeze({ engine: 'postgresql', shared: true, multiWriter: true }) };
}

module.exports = { connectionOptions, openPostgres };
