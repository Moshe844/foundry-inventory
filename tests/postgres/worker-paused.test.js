'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
// A worker created ahead of the database switch starts paused: it stays running and claims
// no job. The control proves an unpaused worker does pick the same job up.
test('a paused worker stays up and runs no jobs; unpaused it does',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:2});
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const jobs=require('../../src/operations/postgres-job-queue');
 const queued=await jobs.enqueue(db,{kind:'system.reconcile-business',idempotencyKey:'paused-worker-'+Date.now()});
 const id=queued.job?.id||queued.id,state=async()=>(await db.query('SELECT status,attempt_count FROM stockchief_runtime.jobs WHERE id=$1',[id])).rows[0];
 const run=(extra)=>{const child=spawn(process.execPath,[path.join(__dirname,'../../src/postgres-worker-server.js')],{env:{...process.env,FOUNDRY_DATABASE_URL:cluster.connectionString,FOUNDRY_WORKER_INTERVAL_MS:'100',...extra},stdio:['ignore','pipe','pipe']});
  let out='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{out+=d;});return {child,output:()=>out};};
 const waitFor=async(check,ms)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,200));}return false;};

 const paused=run({FOUNDRY_WORKER_PAUSED:'true'});
 try{
  assert(await waitFor(()=>/worker paused/.test(paused.output()),30000),'paused worker reported in: '+paused.output().slice(-400));
  await new Promise(r=>setTimeout(r,3000));
  assert.equal(paused.child.exitCode,null,'the paused worker stays running');
  assert.deepEqual(await state(),{status:'PENDING',attempt_count:0},'no job was claimed');
 }finally{paused.child.kill();}

 const live=run({});
 try{assert(await waitFor(async()=>{const s=await state();return s.status!=='PENDING'||s.attempt_count>0;},30000),'an unpaused worker claims the job: '+live.output().slice(-400));}
 finally{live.child.kill();}
});
