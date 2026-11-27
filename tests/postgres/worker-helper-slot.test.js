'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Models 26 Nov 2026: deleting a 17 GB business ran for 40 minutes in the everyday
// lane, and every business's emails and alerts waited behind it.
test('a long account deletion no longer holds up emails, and a business never runs two jobs of one kind at once',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:require('../../src/imports/postgres-stock-lanes').workerPoolSize({},1)});
 let worker,release=()=>{};
 t.after(async()=>{release();await worker?.stop();await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Helper slots',
  email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
 const workspaceId=owner.workspaceId,jobs=require('../../src/operations/postgres-job-queue'),workers=require('../../src/operations/postgres-worker');
 const status=async id=>(await jobs.get(db,id,null)).status;
 const statusIn=async(id,ws)=>(await jobs.get(db,id,ws)).status;
 const until=async(check,ms=8000)=>{for(const end=Date.now()+ms;Date.now()<end;){if(await check())return true;await pause(25);}return false;};
 const deletions=[],sent=[];
 const scenario=()=>{let open;const held=new Promise(resolve=>{open=resolve;});release=open;
  return {'developer.account-delete':Object.assign(async job=>{deletions.push(job.id);await held;return {deleted:true};},{externalEffect:true}),
   'system.email-send':Object.assign(async job=>{sent.push(job.id);return {sent:true};},{externalEffect:true}),
   'fixture.stock-count':Object.assign(async()=>({counted:true}),{externalEffect:true,workerLane:'bulk'})};};

 await t.test('before: one slot per lane, so the email waits for the deletion',async()=>{
  const deletion=(await jobs.enqueue(db,{workspaceId,kind:'developer.account-delete',idempotencyKey:'before-delete',priority:70})).job;
  worker=workers.start(db,{owner:'before',intervalMs:20,leaseMs:60000,handlers:scenario()});
  assert(await until(async()=>await statusIn(deletion.id,workspaceId)==='RUNNING'));
  const mail=(await jobs.enqueue(db,{workspaceId,kind:'system.email-send',idempotencyKey:'before-mail',priority:12})).job;
  await pause(1500);
  assert.equal(await statusIn(mail.id,workspaceId),'PENDING','the email is stuck behind the deletion');
  release();
  assert(await until(async()=>await statusIn(mail.id,workspaceId)==='COMPLETED'));
  await worker.stop();worker=null;
 });

 await t.test('after: a helper sends the emails while the deletion keeps running',async()=>{
  const first=(await jobs.enqueue(db,{workspaceId,kind:'developer.account-delete',idempotencyKey:'after-delete-1',priority:70})).job;
  worker=workers.start(db,{owner:'after',intervalMs:20,leaseMs:60000,helpers:{slots:1,afterMs:300},handlers:scenario()});
  assert(await until(async()=>await statusIn(first.id,workspaceId)==='RUNNING'));
  const second=(await jobs.enqueue(db,{workspaceId,kind:'developer.account-delete',idempotencyKey:'after-delete-2',priority:70})).job;
  const mail=(await jobs.enqueue(db,{workspaceId,kind:'system.email-send',idempotencyKey:'after-mail',priority:12})).job;
  const platform=(await jobs.enqueue(db,{kind:'system.email-send',idempotencyKey:'after-platform-mail',priority:12})).job;
  assert(await until(async()=>await statusIn(mail.id,workspaceId)==='COMPLETED'&&await status(platform.id)==='COMPLETED'),
   'both emails go out while the deletion is still running');
  assert.equal(await statusIn(first.id,workspaceId),'RUNNING');
  assert.equal(await statusIn(second.id,workspaceId),'PENDING','the same business never runs two deletions side by side');
  const claimedBy=(await db.query(`SELECT detail->>'owner' AS owner FROM stockchief_runtime.job_events WHERE job_id=$1 AND event_type='CLAIMED'`,[mail.id])).rows.map(row=>row.owner);
  assert.deepEqual(claimedBy,['after:default:helper-1'],'the helper slot sent the email');
  release();
  assert(await until(async()=>await statusIn(first.id,workspaceId)==='COMPLETED'&&await statusIn(second.id,workspaceId)==='COMPLETED'));
  const runs=(await db.query(`SELECT id,started_at,completed_at FROM stockchief_runtime.jobs WHERE id=ANY($1) ORDER BY started_at`,[[first.id,second.id]])).rows;
  assert(runs[1].started_at>=runs[0].completed_at,'the second deletion started only after the first finished');
  assert.equal(new Set(deletions).size,3,'each deletion ran once');
  await worker.stop();worker=null;
 });
});
