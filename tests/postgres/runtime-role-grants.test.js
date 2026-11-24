'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
// The AWS database: migrations run as an owner login; the website and worker connect as a
// login that reads and writes records but cannot change structure. Everything the running
// app does must still work, including the statistics refresh after a large import.
test('a website login granted after owner migrations runs the app, refreshes statistics and cannot change structure',{timeout:300000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),{openPostgres}=require('../../src/db/postgres'),{Client}=require('pg');
 t.after(()=>cluster.stop());
 const admin=new Client({connectionString:cluster.connectionString});await admin.connect();t.after(()=>admin.end());
 const tag=crypto.randomBytes(3).toString('hex'),owner='app_owner_'+tag,runtime='app_runtime_'+tag,database='app_'+tag,ownerPw=crypto.randomBytes(18).toString('hex'),runtimePw=crypto.randomBytes(18).toString('hex');
 await admin.query(`CREATE ROLE ${owner} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${ownerPw}'`);
 await admin.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${runtimePw}'`);
 await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
 t.after(()=>admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(()=>{}));
 const at=(user,pw)=>{const u=new URL(cluster.connectionString);u.username=user;u.password=pw;u.pathname='/'+database;return u.href;};

 // Publish: migrations as the owner, then grants for the website login.
 const saved={...process.env};Object.assign(process.env,{FOUNDRY_DATABASE_MIGRATION_URL:at(owner,ownerPw),FOUNDRY_DATABASE_RUNTIME_ROLE:runtime});
 try{await require('../../scripts/migrate-postgres').main();}finally{for(const k of ['FOUNDRY_DATABASE_MIGRATION_URL','FOUNDRY_DATABASE_RUNTIME_ROLE'])if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
 assert.equal(process.exitCode,undefined,'migrations and grants succeed as a non-superuser owner');

 const db=openPostgres(at(runtime,runtimePw),{max:6});t.after(()=>db.close());
 await assert.rejects(db.query('CREATE TABLE structure_change(x int)'),/permission denied/,'the website login cannot change structure');
 const store=new(require('../../src/web/postgres-session-store').PostgresSessionStore)(db);await store.ready;t.after(()=>store.close());
 await new Promise((r,j)=>store.set('grants-session',{cookie:{maxAge:60000,originalMaxAge:60000},accountId:'a'},e=>e?j(e):r()));

 // A business and a 600-row stock import (bulk copy path, then the statistics refresh).
 const fixture=require('../../scripts/lib/staging-million-fixture'),source=require('../../scripts/lib/staging-million-source'),imports=require('../../src/imports/postgres-service');
 const b=await fixture.provision(db,'grants-'+tag),ctx={workspaceId:b.workspaceId,actorId:b.userId};
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{currency:'USD',startDate:'2026-01-01'});
 for(const name of source.warehouses)await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name,kind:'warehouse'});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'grants-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const priorCopy=process.env.STOCKCHIEF_IMPORT_COPY;process.env.STOCKCHIEF_IMPORT_COPY='true';t.after(()=>{if(priorCopy===undefined)delete process.env.STOCKCHIEF_IMPORT_COPY;else process.env.STOCKCHIEF_IMPORT_COPY=priorCopy;});
 // Manual ANALYZE runs only (not autovacuum), read from a fresh session so stats are current.
 const analysed=async table=>{const c=new Client({connectionString:at(owner,ownerPw)});await c.connect();
  try{return Number((await c.query('SELECT analyze_count FROM pg_stat_user_tables WHERE relname=$1',[table])).rows[0].analyze_count);}finally{await c.end();}};
 for(const [kind,count]of [['catalogue',600],['stock150k',600]]){const file=source.write(dir,kind,count,{run:'grants-'+tag,skuCount:600});
  const plan=await imports.analyse(db,ctx,{buffer:fs.readFileSync(file),filename:kind+'.csv',importMode:'add',allowModel:false});
  await imports.approve(db,ctx,plan.id,plan.integrityHash);await imports.execute(db,ctx,plan.id);}
 assert.equal(Number((await db.query('SELECT count(*) n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),600);
 // The website login's own statistics refresh is applied (not silently skipped).
 const before=await analysed('balances');
 const refresh=await require('../../src/imports/postgres-statistics').refreshAfterImport(db,{verified:true,rowsImported:600});
 assert(refresh.refreshed.length>0,JSON.stringify(refresh));
 let after=before;for(let i=0;i<20&&after===before;i++){await new Promise(r=>setTimeout(r,250));after=await analysed('balances');}
 assert(after>before,'ANALYZE by the website login updated the statistics ('+before+' -> '+after+')');

 // A table a later migration adds is usable at once; structure stays the owner's.
 const ownerClient=new Client({connectionString:at(owner,ownerPw)});await ownerClient.connect();
 try{await ownerClient.query('CREATE TABLE later_migration_table(id text PRIMARY KEY)');}finally{await ownerClient.end();}
 await db.query("INSERT INTO later_migration_table VALUES ('works')");
 assert.equal((await db.query('SELECT count(*) n FROM later_migration_table')).rows[0].n,'1');
 await assert.rejects(db.query('DROP TABLE later_migration_table'),/must be owner/);
});
