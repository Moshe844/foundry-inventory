'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
// The move to AWS restores Render's export (a directory-format pg_dump) into a database
// customers are not using yet, then proves the copy equals the source before the switch.
test('a Render-style export restores exactly, runs the app as the website login and never replaces a live database',{timeout:420000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),{openPostgres}=require('../../src/db/postgres'),{Client}=require('pg');
 t.after(()=>cluster.stop());
 const bin=process.env.STOCKCHIEF_POSTGRES_BIN||(process.platform==='win32'?'C:/Program Files/PostgreSQL/17/bin':'');
 const server=new URL(cluster.connectionString),tag=crypto.randomBytes(3).toString('hex');
 const admin=new Client({connectionString:cluster.connectionString});await admin.connect();t.after(()=>admin.end());
 const at=(name,user=decodeURIComponent(server.username),pw=decodeURIComponent(server.password))=>{const u=new URL(cluster.connectionString);u.username=encodeURIComponent(user);u.password=encodeURIComponent(pw);u.pathname='/'+name;return u.href;};

 // "Render": a migrated database with a business, an import, a session and an extension the app does not use.
 const sourceName='render_'+tag;await admin.query(`CREATE DATABASE ${sourceName}`);
 const src=openPostgres(at(sourceName),{max:4});t.after(()=>src.close());
 await require('../../src/db/migrate-postgres').migratePostgres(src);
 await src.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
 const fixture=require('../../scripts/lib/staging-million-fixture'),source=require('../../scripts/lib/staging-million-source'),imports=require('../../src/imports/postgres-service');
 const b=await fixture.provision(src,'restore-'+tag),ctx={workspaceId:b.workspaceId,actorId:b.userId};
 await require('../../src/accounting/postgres-ledger').configure(src,ctx,{currency:'USD',startDate:'2026-01-01'});
 for(const name of source.warehouses)await require('../../src/domain/postgres-location-service').createLocation(src,ctx,{name,kind:'warehouse'});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'restore-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const [kind,count]of [['catalogue',100],['stock150k',100]]){const file=source.write(dir,kind,count,{run:'restore-'+tag,skuCount:100});
  const plan=await imports.analyse(src,ctx,{buffer:fs.readFileSync(file),filename:kind+'.csv',importMode:'add',allowModel:false});await imports.approve(src,ctx,plan.id,plan.integrityHash);await imports.execute(src,ctx,plan.id);}
 await src.query("INSERT INTO stockchief_runtime.sessions(sid,expires_at,data) VALUES('restore-session',$1,'{\"accountId\":\"x\"}')",[Date.now()+3600000]);
 const fingerprint=require('../../src/db/database-fingerprint'),before=await fingerprint.take(src);
 assert(before.totalRows>500);
 const dump=path.join(dir,'export');
 execFileSync(path.join(bin,'pg_dump'+(process.platform==='win32'?'.exe':'')),['-Fd','-f',dump,'-d',at(sourceName)],{stdio:'pipe'});

 // AWS: restore as the owner, grant the website login, fingerprint the copy.
 const login=name=>({username:name,password:crypto.randomBytes(18).toString('base64url')+'%:@/'});
 const env={STOCKCHIEF_RESTORE_MASTER_SECRET:JSON.stringify({username:decodeURIComponent(server.username),password:decodeURIComponent(server.password),host:server.hostname,port:Number(server.port)}),
  STOCKCHIEF_RESTORE_OWNER_SECRET:JSON.stringify(login('owner_'+tag)),STOCKCHIEF_RESTORE_RUNTIME_SECRET:JSON.stringify(login('runtime_'+tag)),
  STOCKCHIEF_RESTORE_DATABASE:'stockchief_'+tag,STOCKCHIEF_RESTORE_SOURCE:dump,STOCKCHIEF_PG_BIN:bin,STOCKCHIEF_RESTORE_WORKDIR:dir};
 const restore=require('../../src/db/aws-restore');
 const done=await restore.restore(env);
 assert.deepEqual(fingerprint.compare(before,done.fingerprint),[],'the copy equals the source, table by table');

 // The website login runs the app on the copy and cannot change structure.
 const runtime=JSON.parse(env.STOCKCHIEF_RESTORE_RUNTIME_SECRET);
 const app=openPostgres(at(env.STOCKCHIEF_RESTORE_DATABASE,runtime.username,runtime.password),{max:2});
 assert.equal((await app.query('SELECT count(*)::int n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,100);
 const store=new(require('../../src/web/postgres-session-store').PostgresSessionStore)(app);await store.ready;
 assert.equal((await new Promise((r,j)=>store.get('restore-session',(e,v)=>e?j(e):r(v)))).accountId,'x','sessions carry over, so nobody is signed out');
 await assert.rejects(app.query('CREATE TABLE structure_change(x int)'),/permission denied/);
 await assert.rejects(app.query('SELECT * FROM stockchief_restore.marker'),/permission denied/);

 // Safety: never over an unswitched copy without the explicit flag, never over a live one.
 await assert.rejects(restore.restore(env),/already here/);
 await store.close();await app.close();
 await restore.restore({...env,STOCKCHIEF_RESTORE_REPLACE:'replace-unswitched-copy'});
 await restore.markLive(env);
 await assert.rejects(restore.restore({...env,STOCKCHIEF_RESTORE_REPLACE:'replace-unswitched-copy'}),/live/);
 await admin.query(`CREATE DATABASE other_${tag}`);const other=openPostgres(at('other_'+tag),{max:1});
 try{await other.query('CREATE TABLE someone_elses(x int)');}finally{await other.close();}
 await assert.rejects(restore.restore({...env,STOCKCHIEF_RESTORE_DATABASE:'other_'+tag}),/did not create/);
});
