'use strict';
const {randomUUID}=require('node:crypto');
const store=require('./postgres-goal-store');
function handler(options={}){return Object.assign(async(job,database)=>{
 const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
 const goal=await store.get(database,ctx,job.payload.goalId);
 if(goal?.checkpoint.runtime!=='codex-staging'||goal.checkpoint.boundedRead!==true||goal.checkpoint.harness?.native?.codex)
  throw Object.assign(Error('DATABASE_READ_GOAL_REQUIRED'),{retryable:false});
 const began=Date.now(),queueWaitMs=Math.max(0,began-Math.max(Number(job.availableAt)||0,new Date(job.createdAt).getTime()));
 console.log(JSON.stringify({kind:'ask_job_started',runtime:'hosted-database-read',goalId:goal.id,queueWaitMs}));
 try{const result=await require('./postgres-codex-pilot').run(database,ctx,goal.id,options);
  return {goalId:result.id,status:result.status};}
 catch(error){
  await database.query(`UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',
   answer='Ask could not start this request. Your question is saved; you can continue it here.',updated_at=now()
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND status='READY'`,[ctx.workspaceId,ctx.actorId,goal.id]);
  throw error;
 }finally{console.log(JSON.stringify({kind:'ask_job_finished',runtime:'hosted-database-read',goalId:goal.id,queueWaitMs,executionMs:Date.now()-began}));}
 },{externalEffect:true});}
async function start(database,options={}){
 if(!process.env.OPENAI_API_KEY&&!options.runtime?.apiKey)return {disabled:true,stop:async()=>{}};
 const concurrency=options.concurrency??Number(process.env.STOCKCHIEF_ASK_CONCURRENCY||2);
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new TypeError('Hosted Ask concurrency must be between one and four.');
 const identity='hosted-read:'+randomUUID();let stopped=false,pending=Promise.resolve();
 const available=()=>database.query(`INSERT INTO stockchief_runtime.assistant_worker_health(kind,worker_identity,last_seen_at)
  VALUES('database-read',$1,now()) ON CONFLICT(kind) DO UPDATE SET worker_identity=EXCLUDED.worker_identity,last_seen_at=EXCLUDED.last_seen_at`,[identity]);
 await available();
 const runtime=require('../operations/postgres-worker').start(database,{handlers:{'assistant.run-codex-read':handler(options.runtime)},
  concurrency,intervalMs:options.intervalMs??500,leaseMs:10*60000,onError:options.onError});
 const timer=setInterval(()=>{if(!stopped)pending=pending.then(available).catch(error=>options.onError?.(error));},10000);timer.unref();
 return {owner:identity,wake:()=>runtime.wake(),stop:async()=>{
  if(stopped)return;stopped=true;clearInterval(timer);const draining=runtime.stop();await pending;await draining;
  await database.query("DELETE FROM stockchief_runtime.assistant_worker_health WHERE kind='database-read' AND worker_identity=$1",[identity]);
 }};
}
module.exports={start,handler};
