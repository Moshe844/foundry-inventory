'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('pooled statements stop on the PostgreSQL server, roll back incomplete writes and retain bounded transaction overrides',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),{openPostgres,connectionOptions}=require('../../src/db/postgres');
 assert.equal(connectionOptions(cluster.connectionString).statement_timeout,30000);
 for(const value of [0,-1,Infinity,NaN,'100',2147483648])assert.throws(()=>connectionOptions(cluster.connectionString,{statementTimeoutMs:value}),/statement timeout/);
 const db=openPostgres(cluster.connectionString,{max:2,statementTimeoutMs:100,applicationName:'isolated-server-deadline'});t.after(async()=>{await db.close();await cluster.stop();});
 await db.query('CREATE TABLE deadline_rows(id integer)');
 await assert.rejects(db.query('INSERT INTO deadline_rows SELECT 1 FROM pg_sleep(0.3)'),e=>e.code==='57014');
 assert.equal((await db.query('SELECT count(*)::int n FROM deadline_rows')).rows[0].n,0);
 await db.transaction(async c=>{await c.query('SELECT pg_sleep(0.2)');assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout,'800ms');},{statementTimeoutMs:800});
 const results=await Promise.allSettled([db.query('SELECT pg_sleep(0.3)'),db.query('SELECT pg_sleep(0.3)')]);assert(results.every(r=>r.status==='rejected'&&r.reason.code==='57014'));
 assert.equal((await db.query('SELECT 1 healthy')).rows[0].healthy,1);
 const active=await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='isolated-server-deadline' AND pid<>pg_backend_pid() AND state='active'");assert.equal(active.rows[0].n,0,'A client timeout must not leave its SQL consuming server CPU');
});
