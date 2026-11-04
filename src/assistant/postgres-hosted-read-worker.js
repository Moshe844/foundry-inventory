'use strict';
const {randomUUID}=require('node:crypto');
const store=require('./postgres-goal-store');
function handler(options={}){return Object.assign(async(job,database)=>{
 const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
 const goal=await store.get(database,ctx,job.payload.goalId);
 if(goal?.checkpoint.runtime!=='codex-staging'||!(goal.checkpoint.boundedRead===true||goal.checkpoint.boundedProcessing===true&&require('../connections/postgres-source-automation').processing(goal))||goal.checkpoint.harness?.native?.codex)
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
function legacyHandler(businessHandler,options={}){return Object.assign(async(job,database)=>{
 const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
 await require('./postgres-codex-pilot').access(database,ctx,{enabled:true});
 const outcome=await database.transaction(async client=>{
  const goal=(await client.query('SELECT * FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE',[ctx.workspaceId,ctx.actorId,job.payload.goalId])).rows[0];
  if(!goal||goal.status!=='READY')return 'settled';
  if(!goal.checkpoint.harness?.native?.codex&&(goal.checkpoint.boundedRead||require('../connections/postgres-source-automation').processing(goal))){
   if(!goal.checkpoint.boundedRead)await client.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=checkpoint||'{\"boundedProcessing\":true}'::jsonb WHERE id=$1",[goal.id]);
   return 'read';
  }
  const prior=(await client.query(`SELECT EXISTS(SELECT 1 FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1)
   OR EXISTS(SELECT 1 FROM commercial_model_cost_holds WHERE goal_id=$1) AS spent`,[goal.id])).rows[0].spent;
  if(!goal.checkpoint.harness?.native?.codex&&!prior&&Number(goal.turns)===0&&Number(goal.tool_calls)===0){
   await client.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=checkpoint||'{\"runtime\":\"hosted-business\"}'::jsonb WHERE id=$1",[goal.id]);return 'business';
  }
  // Never replay a partly executed SDK mission through another runtime. Its
  // evidence, approvals and canonical effects remain available for review.
  await client.query(`UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',run_token=NULL,lease_until=NULL,
   answer='This saved request used the previous agent. Its recorded work and approvals are preserved. Start a new question to continue with the hosted agent.',
   checkpoint=checkpoint||'{"legacyReviewOnly":true}'::jsonb,updated_at=now() WHERE id=$1`,[goal.id]);return 'review';
 },{isolation:'READ COMMITTED',retrySafe:true});
 if(outcome==='read')return handler(options)(job,database);
 if(outcome==='business')return businessHandler(job,database);
 return {goalId:job.payload.goalId,status:outcome==='review'?'BLOCKED':'SETTLED',legacyReviewOnly:outcome==='review'};
 },{externalEffect:true});}
async function start(database,options={}){
 if(!process.env.OPENAI_API_KEY&&!options.runtime?.apiKey&&!(options.businessHandler&&require('../config').ai.configured))return {disabled:true,stop:async()=>{}};
 const concurrency=options.concurrency??Number(process.env.STOCKCHIEF_ASK_CONCURRENCY||2);
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new TypeError('Hosted Ask concurrency must be between one and four.');
 const identity='hosted-read:'+randomUUID();let stopped=false,pending=Promise.resolve();
 const available=()=>database.query(`INSERT INTO stockchief_runtime.assistant_worker_health(kind,worker_identity,last_seen_at)
  VALUES('database-read',$1,now()) ON CONFLICT(kind) DO UPDATE SET worker_identity=EXCLUDED.worker_identity,last_seen_at=EXCLUDED.last_seen_at`,[identity]);
 await available();
 const runtime=require('../operations/postgres-worker').start(database,{handlers:{'assistant.run-codex-read':handler(options.runtime),...(options.businessHandler?{'assistant.run-goal':options.businessHandler,'assistant.run-codex-goal':legacyHandler(options.businessHandler,options.runtime)}:{})},
  concurrency,intervalMs:options.intervalMs??500,leaseMs:10*60000,onError:options.onError});
 const timer=setInterval(()=>{if(!stopped)pending=pending.then(available).catch(error=>options.onError?.(error));},10000);timer.unref();
 return {owner:identity,wake:()=>runtime.wake(),stop:async()=>{
  if(stopped)return;stopped=true;clearInterval(timer);const draining=runtime.stop();await pending;await draining;
  await database.query("DELETE FROM stockchief_runtime.assistant_worker_health WHERE kind='database-read' AND worker_identity=$1",[identity]);
 }};
}
module.exports={start,handler,legacyHandler};
