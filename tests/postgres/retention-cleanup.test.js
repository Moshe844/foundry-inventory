'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// The daily clean-up removes working copies and logs past their window and
// nothing else: finished imports keep their rows, unfinished jobs keep their
// events, and business records are untouched.
test('retention removes stale import copies, old job events and old measurements only',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),locations=require('../../src/domain/postgres-location-service'),imports=require('../../src/imports/postgres-service');
 const made=await auth.createBusiness(db,{name:'Owner',businessName:'Retention',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),ctx={workspaceId:made.workspaceId,actorId:made.userId};
 await locations.createLocation(db,ctx,{name:'Main Warehouse',kind:'warehouse'});
 const csv=n=>['Product name,SKU,Quantity,Unit cost',...Array.from({length:6},(_,i)=>`Kept ${n} ${i},K-${n}-${i},${2+i},1.50`)].join('\n');
 const old=new Date(Date.now()-20*86400000).toISOString();

 const stale=await imports.analyse(db,ctx,{text:csv('a'),allowModel:false});
 const finished=await imports.analyse(db,ctx,{text:csv('b'),allowModel:false});await imports.approve(db,ctx,finished.id,finished.integrityHash);assert((await imports.execute(db,ctx,finished.id)).verified);
 const fresh=await imports.analyse(db,ctx,{text:csv('c'),allowModel:false});
 await db.query('UPDATE import_plans SET created_at=$2 WHERE id=ANY($1::text[])',[[stale.id,finished.id],old]);
 const rows=async id=>(await db.query('SELECT count(*)::int n FROM import_rows WHERE import_id=$1',[id])).rows[0].n;
 assert.equal(await rows(stale.id),6);

 const jobs=require('../../src/operations/postgres-job-queue');
 const done=(await jobs.enqueue(db,{kind:'test.done',idempotencyKey:randomUUID(),workspaceId:ctx.workspaceId})).job,paused=(await jobs.enqueue(db,{kind:'test.paused',idempotencyKey:randomUUID(),workspaceId:ctx.workspaceId})).job;
 await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED' WHERE id=$1",[done.id]);await db.query("UPDATE stockchief_runtime.jobs SET status='PAUSED' WHERE id=$1",[paused.id]);
 // Events cannot be edited; old ones are written as they would have been.
 for(const job of [done,paused])await db.query("INSERT INTO stockchief_runtime.job_events(id,job_id,event_type,detail,created_at) VALUES($1,$2,'STARTED','{}',$3)",[randomUUID(),job.id,new Date(Date.now()-40*86400000).toISOString()]);
 const events=async id=>(await db.query('SELECT count(*)::int n FROM stockchief_runtime.job_events WHERE job_id=$1 AND created_at<$2',[id,new Date(Date.now()-86400000).toISOString()])).rows[0].n;
 assert(await events(done.id)>0&&await events(paused.id)>0);

 const measure=(id,at)=>db.query(`INSERT INTO commercial_resource_measurements(id,account_id,workspace_id,resource_id,runtime_kind,operation,started_at,finished_at,elapsed_microseconds,database_microseconds,database_queries,attribution,outcome)
  VALUES($1,NULL,NULL,'local:web','web','GET /',$2,$2,1,1,1,'SHARED','200')`,[id,at]);
 await measure('measure-old',new Date(Date.now()-120*86400000).toISOString());await measure('measure-new',new Date().toISOString());

 const result=await require('../../src/operations/postgres-retention').run(db);
 assert.equal(result.previewsCancelled,1);assert.equal(result.importRows,6);
 assert.equal((await db.query('SELECT status,approval_status FROM import_plans WHERE id=$1',[stale.id])).rows[0].status,'CANCELLED');
 assert.equal(await rows(stale.id),0,'the stale preview\'s rows are removed');
 assert.equal(await rows(finished.id),6,'a finished import keeps its rows');
 assert.equal(await rows(fresh.id),6,'a recent preview is untouched');
 assert.equal((await db.query('SELECT status FROM import_plans WHERE id=$1',[fresh.id])).rows[0].status,'READY');
 assert.equal(await events(done.id),0,'old events of a finished job are removed');
 assert(await events(paused.id)>0,'a paused job keeps its events');
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE id=ANY($1::text[])",[[done.id,paused.id]])).rows[0].n,2,'jobs themselves stay');
 assert.deepEqual((await db.query("SELECT id FROM commercial_resource_measurements WHERE id LIKE 'measure-%' ORDER BY id")).rows.map(r=>r.id),['measure-new']);
 assert.equal((await db.query('SELECT count(*)::int n FROM skus WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,6,'business records are untouched');

 // Scheduling is once per day.
 const retention=require('../../src/operations/postgres-retention'),now=Date.now();
 assert.equal((await retention.schedule(db,{now})).created,true);assert.equal((await retention.schedule(db,{now:now+60000})).created,false);
});
