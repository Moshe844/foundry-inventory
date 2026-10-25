'use strict';

const session = require('express-session');
const { openPostgres } = require('../db/postgres');
const BASE=Symbol('postgres-session-snapshot');

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

  createSession(req,value){
    const snapshot=JSON.parse(JSON.stringify(value));
    const result=super.createSession(req,value);
    Object.defineProperty(req.session,BASE,{value:snapshot,writable:true});
    return result;
  }

  set(sid, value, callback = () => {}) {
    const snapshot=value[BASE],clean=JSON.parse(JSON.stringify(value));
    if(snapshot){
      // Apply this request's field changes atomically. A concurrent GET must
      // not restore an old inventory selection or erase a POST's new flash.
      const patch={},removed=[];
      for(const key of new Set([...Object.keys(snapshot),...Object.keys(clean)])){
        if(!Object.hasOwn(clean,key))removed.push(key);
        else if(JSON.stringify(snapshot[key])!==JSON.stringify(clean[key]))patch[key]=clean[key];
      }
      const flashChanged=Object.hasOwn(patch,'flash')||removed.includes('flash');delete patch.flash;
      const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),before=Array.isArray(snapshot.flash)?snapshot.flash:[],after=Array.isArray(clean.flash)?clean.flash:[];
      const acknowledged=before.filter(entry=>!after.some(next=>same(entry,next))),added=after.filter(entry=>!before.some(prior=>same(entry,prior)));
      const ordinary=`((data - ARRAY(SELECT obsolete.key FROM jsonb_each($3::jsonb) obsolete
        WHERE data->obsolete.key=obsolete.value)) || $4::jsonb)`;
      const expression=flashChanged?`jsonb_set(${ordinary},'{flash}',(
        SELECT COALESCE(jsonb_agg(messages.value ORDER BY messages.position),'[]'::jsonb) FROM (
          SELECT existing.value,existing.ordinality AS position FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(data->'flash')='array' THEN data->'flash' ELSE '[]'::jsonb END)
            WITH ORDINALITY existing(value,ordinality)
          WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements($5::jsonb) ack WHERE ack.value=existing.value)
          UNION ALL
          SELECT incoming.value,1000000+incoming.ordinality FROM jsonb_array_elements($6::jsonb)
            WITH ORDINALITY incoming(value,ordinality)
          WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(data->'flash')='array' THEN data->'flash' ELSE '[]'::jsonb END) present WHERE present.value=incoming.value)
        ) messages),true)`:ordinary;
      const args=[sid,this.expiryFor(value),JSON.stringify(Object.fromEntries(removed.filter(key=>key!=='flash').map(key=>[key,snapshot[key]]))),JSON.stringify(patch)];
      if(flashChanged)args.push(JSON.stringify(acknowledged),JSON.stringify(added));
      args.push(Date.now());
      this.ready.then(()=>this.database.query(`UPDATE stockchief_runtime.sessions SET expires_at=$2,data=${expression}
        WHERE sid=$1 AND expires_at>$${args.length}`,args)).then(()=>{value[BASE]=clean;callback(null);},callback);
      // A destroyed/expired session is intentionally never recreated by a
      // late response carrying an old authenticated snapshot.
      return;
    }
    this.ready.then(() => this.database.query(`INSERT INTO stockchief_runtime.sessions(sid, expires_at, data)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data`,
    [sid, this.expiryFor(value), JSON.stringify(value)])).then(() => callback(null), callback);
  }

  touch(sid, value, callback = () => {}) {
    this.ready.then(() => this.database.query(`UPDATE stockchief_runtime.sessions
      SET expires_at = $1 WHERE sid = $2 AND expires_at > $3`,
      [this.expiryFor(value), sid, Date.now()])).then(() => callback(null), callback);
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
