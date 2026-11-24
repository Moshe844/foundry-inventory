'use strict';
// The web app must sign people in when it connects as a least-privilege role that may read and
// write tables but cannot create schemas (the AWS runtime and qualification roles).
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
test('sessions work for a role without database CREATE once migrations have run',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),{openPostgres}=require('../../src/db/postgres');
 const owner=openPostgres(cluster.connectionString);let runtime,store;
 t.after(async()=>{await store?.close();await runtime?.close();await owner.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(owner);
 const role='session_runtime_'+crypto.randomBytes(4).toString('hex'),password=crypto.randomBytes(18).toString('hex'),database=new URL(cluster.connectionString).pathname.slice(1);
 await owner.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`);
 await owner.query(`REVOKE CREATE ON DATABASE "${database}" FROM PUBLIC`);
 await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
 await owner.query(`GRANT USAGE ON SCHEMA stockchief_runtime TO ${role}`);
 await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA stockchief_runtime TO ${role}`);
 const address=new URL(cluster.connectionString);address.username=role;address.password=password;
 runtime=openPostgres(address.href);
 assert.equal((await runtime.query(`SELECT has_database_privilege(current_user,current_database(),'CREATE') AS can`)).rows[0].can,false);
 store=new(require('../../src/web/postgres-session-store').PostgresSessionStore)(runtime);await store.ready;
 const set=(id,value)=>new Promise((r,j)=>store.set(id,value,e=>e?j(e):r())),get=id=>new Promise((r,j)=>store.get(id,(e,v)=>e?j(e):r(v)));
 await set('least-privilege',{cookie:{maxAge:600000,originalMaxAge:600000},accountId:'owner',workspaceId:'first'});
 assert.equal((await get('least-privilege')).workspaceId,'first');
});
