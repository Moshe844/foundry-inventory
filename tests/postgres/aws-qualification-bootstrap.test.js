'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('qualification bootstrap migrates with a non-superuser owner and confines the runtime role to synthetic data',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),{openPostgres}=require('../../src/db/postgres'),admin=openPostgres(cluster.connectionString);
 t.after(async()=>{await admin.close();await cluster.stop();});
 await admin.query("CREATE ROLE sc_database_owner LOGIN CREATEDB CREATEROLE PASSWORD 'local-bootstrap-owner-test-only'");
 await admin.query('CREATE DATABASE stockchief OWNER sc_database_owner');
 const host='qualification.fake123.us-east-2.rds.amazonaws.com',env={STOCKCHIEF_IMPORT_DATABASE_HOST:host,STOCKCHIEF_IMPORT_DATABASE_NAME:'stockchief_qualification',STOCKCHIEF_IMPORT_DATABASE_ROLE:'stockchief_qualification',STOCKCHIEF_IMPORT_DATABASE_SECRET:JSON.stringify({username:'stockchief_qualification',password:'local-qualification-test-only',dbname:'stockchief_qualification'}),STOCKCHIEF_QUALIFICATION_MASTER_SECRET:JSON.stringify({username:'sc_database_owner',password:'local-bootstrap-owner-test-only'}),STOCKCHIEF_QUALIFICATION_OWNER:'stockchief-qualification-active',STOCKCHIEF_QUALIFICATION_COMMIT:'169c58ef8cf9a4693eb16988d2f8d8f39927b59e'};
 // Only the test harness routes the approved RDS-format address to this
 // disposable local cluster. Production hostname/TLS validation stays intact.
 const open=(input,options)=>{const url=new URL(input),local=new URL(cluster.connectionString);url.hostname=local.hostname;url.port=local.port;url.searchParams.set('sslmode','disable');return openPostgres(url.href,options);};
 const {bootstrap}=require('../../src/imports/aws-qualification-bootstrap');
 const first=await bootstrap(env,{open});assert(first.isolationVerified);assert(first.migrationsApplied>500);
 const replay=await bootstrap(env,{open});assert.equal(replay.migrationsApplied,0);assert(replay.isolationVerified);
 // A reset drops only the marked synthetic database, then rebuilds it empty.
 const marked=open('postgresql://sc_database_owner:'+encodeURIComponent('local-bootstrap-owner-test-only')+'@'+host+':5432/stockchief_qualification');
 await marked.query('CREATE TABLE reset_probe(id int)');await marked.close();
 await assert.rejects(bootstrap({...env,STOCKCHIEF_QUALIFICATION_RESET:'drop-synthetic-database',STOCKCHIEF_QUALIFICATION_OWNER:'someone-else'},{open}),/Only the marked synthetic/);
 const reset=await bootstrap({...env,STOCKCHIEF_QUALIFICATION_RESET:'drop-synthetic-database'},{open});assert(reset.isolationVerified);assert(reset.migrationsApplied>500,'A reset rebuilds the synthetic database from scratch.');
 const fresh=open('postgresql://sc_database_owner:'+encodeURIComponent('local-bootstrap-owner-test-only')+'@'+host+':5432/stockchief_qualification');
 assert.equal((await fresh.query("SELECT to_regclass('public.reset_probe') AS probe")).rows[0].probe,null);await fresh.close();
 assert.equal((await admin.query("SELECT count(*)::int n FROM pg_database WHERE datname='stockchief'")).rows[0].n,1,'The customer restore database is never dropped.');
 const scoped=require('../../src/imports/aws-database-connection').connection(env),runtime=open(scoped.connectionString);t.after(()=>runtime.close());
 const flags=(await runtime.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(Object.values(flags),[false,false,false,false,false]);
 await assert.rejects(runtime.query("UPDATE stockchief_aws_qualification_marker SET owner_tag='other'"),error=>error.code==='42501');
 const main=new URL(scoped.connectionString);main.pathname='/stockchief';const forbidden=open(main.href);t.after(()=>forbidden.close());
 await assert.rejects(forbidden.query('SELECT 1'),error=>error.code==='42501');
});
