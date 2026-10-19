'use strict';
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const TABLE='stockchief_runtime.assistant_goals';
function enabled(ctx){return process.env.STOCKCHIEF_ADAPTIVE_ASK==='1'&&
 String(process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES||'').split(',').map(x=>x.trim()).includes(ctx.workspaceId);}
async function get(db,ctx,id){return (await db.query(`SELECT * FROM ${TABLE}
 WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0]||null;}
async function progress(db,ctx,id){return (await db.query(`SELECT id,status,answer,created_at,updated_at,turns,tool_calls,
 COALESCE((SELECT p.worker_seen_at>now()-interval '30 seconds' FROM stockchief_runtime.codex_pilot_workspace_access p WHERE p.workspace_id=assistant_goals.workspace_id),false) AS worker_available,
 jsonb_build_object('runtime',checkpoint->'runtime','runStartedAt',checkpoint->'runStartedAt',
 'conversationState',checkpoint->'conversationState','delivery',checkpoint->'delivery','prerequisiteHandoffs',checkpoint->'prerequisiteHandoffs','lifecycleStage',checkpoint->'lifecycleStage',
 'harness',jsonb_build_object('userQuestion',checkpoint#>'{harness,userQuestion}','interruption',checkpoint#>'{harness,interruption}',
 'completionSource',checkpoint#>'{harness,completionSource}','admissionBlock',checkpoint#>'{harness,admissionBlock}',
 'modelUsagePending',COALESCE(checkpoint#>>'{harness,codexDelivery,state}'='PENDING',false) OR COALESCE(checkpoint#>>'{harness,helperDelivery,state}'='PENDING',false)),
 'navigation',jsonb_build_object('id',checkpoint#>'{navigation,id}','label',checkpoint#>'{navigation,label}',
 'state',checkpoint#>'{navigation,state}')) AS checkpoint FROM ${TABLE}
 WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0]||null;}
async function create(db,ctx,message,{usageKey=newId('goalrequest'),budgetMinor=75,page=null,continuation=null}={}){
 const clean=String(message||'').trim();
 if(!clean||clean.length>12000)throw new ValidationError('Describe a goal in at most 12,000 characters.');
 if(!Number.isFinite(budgetMinor)||budgetMinor<=0||budgetMinor>100)throw new ValidationError('Invalid goal budget.');
 await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'ask.lookup');
 const result=await db.query(`INSERT INTO ${TABLE}(id,workspace_id,actor_user_id,request_key,original_request,budget_minor,checkpoint)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(workspace_id,actor_user_id,request_key)
 DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`,
 [newId('goal'),ctx.workspaceId,ctx.actorId,usageKey,clean,budgetMinor,JSON.stringify({page,continuation,observations:[],discovered:[],messages:[]})]);
 const goal=result.rows[0];if(goal.original_request!==clean)throw new ValidationError('That request key already belongs to another goal.');
 return goal;
}
async function claim(db,ctx,id){
 const token=newId('goalrun');
 // An abandoned in-flight operation needs reconciliation, not blind replay.
 await db.query(`UPDATE ${TABLE} SET status='BLOCKED',answer='The previous run was interrupted. Review its recorded work before retrying.',
 run_token=NULL,lease_until=NULL,updated_at=now() WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3
 AND status='RUNNING' AND lease_until<now()`,[ctx.workspaceId,ctx.actorId,id]);
 return (await db.query(`UPDATE ${TABLE} SET status='RUNNING',run_token=$4,lease_until=now()+interval '10 minutes',updated_at=now(),
 checkpoint=jsonb_set(checkpoint,'{runStartedAt}',to_jsonb(now()))
 WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND status='READY' AND expires_at>now() RETURNING *`,
 [ctx.workspaceId,ctx.actorId,id,token])).rows[0]||null;
}
async function save(db,ctx,goal,kind,detail={}){return db.transaction(async client=>{
 const row=(await client.query(`UPDATE ${TABLE} SET status=$5,checkpoint=$6::jsonb,answer=$7,turns=$8,tool_calls=$9,
 recoveries=$10,updated_at=now(),run_token=CASE WHEN $5='RUNNING' THEN run_token ELSE NULL END,
 lease_until=CASE WHEN $5='RUNNING' THEN lease_until ELSE NULL END
 WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND run_token=$4 AND status='RUNNING' RETURNING id`,
 [ctx.workspaceId,ctx.actorId,goal.id,goal.run_token,goal.status,JSON.stringify(goal.checkpoint),goal.answer,
 goal.turns,goal.tool_calls,goal.recoveries])).rows[0];
 if(!row)throw new ValidationError('This goal run lost its lease or was cancelled.');
 await client.query(`INSERT INTO stockchief_runtime.assistant_goal_events(id,goal_id,sequence,kind,detail)
 SELECT $1,$2,COALESCE(MAX(sequence),0)+1,$3,$4::jsonb FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$2`,
 [newId('goalevent'),goal.id,kind,JSON.stringify(detail)]);
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function cancel(db,ctx,id){return (await db.query(`UPDATE ${TABLE} SET status='CANCELLED',run_token=NULL,lease_until=NULL,
 answer='Goal stopped. Previously approved or completed business operations retain their own recorded status.',updated_at=now()
 WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND status NOT IN ('COMPLETED','CANCELLED') RETURNING *`,
 [ctx.workspaceId,ctx.actorId,id])).rows[0]||null;}
async function reply(db,ctx,id,message,{questionId=null}={}){
 const text=String(message||'').trim();if(!text||text.length>4000)throw new ValidationError('Provide a brief answer to continue.');
 return db.transaction(async client=>{
  const goal=(await client.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!goal||new Date(goal.expires_at)<=new Date())return null;
  const cp=goal.checkpoint,contract=require('./agent-conversation');
  if(cp.harness)await require('../../scripts/environment-agent-demo/waits').authority(client,ctx,cp.harness);
  const prior=questionId&&(cp.conversationState?.history||[]).find(m=>m.role==='user'&&m.questionId===questionId);
  if(prior)return prior.text===text?{...goal,replyReplayed:true}:null;
  if(goal.status!=='WAITING_USER')return null;
  // Compatibility for old valid questions; it is never inferred from failure text.
  cp.harness?.userQuestion||(cp.harness?cp.harness.userQuestion={question:goal.answer,missingInformation:['Your decision']}:null);
  const current=contract.sync(goal);
  if(questionId&&questionId!==current.input?.id)return null;
  const inputId=current.input?.id||`${id}:legacy:${cp.messages?.length||0}`;
  current.history.push({id:`${id}:reply:${inputId}`,role:'user',text,questionId:inputId,at:new Date().toISOString()});
  cp.messages=[...(cp.messages||[]),text];
  if(cp.harness){cp.harness.userQuestion=null;cp.harness.pendingReport=null;cp.harness.failure=null;}
  cp.lifecycleStage=null;goal.status='READY';goal.answer='';contract.sync(goal);
  const row=(await client.query(`UPDATE ${TABLE} SET status='READY',checkpoint=$4::jsonb,answer='',updated_at=now()
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 RETURNING *`,[ctx.workspaceId,ctx.actorId,id,JSON.stringify(cp)])).rows[0];
  await client.query(`INSERT INTO stockchief_runtime.assistant_goal_events(id,goal_id,sequence,kind,detail)
   SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'user_replied',$3::jsonb FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$2`,
   [newId('goalevent'),id,JSON.stringify({questionId:inputId})]);
  return row;
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function enqueue(db,goal){const queued=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId:goal.workspace_id,
 kind:goal.checkpoint.runtime==='codex-staging'?'assistant.run-codex-goal':'assistant.run-goal',payload:{goalId:goal.id,actorId:goal.actor_user_id},
 idempotencyKey:`goal:${goal.id}:${goal.updated_at.toISOString()}`,maxAttempts:1,priority:20});
 if(queued.job?.status==='DEAD'&&goal.status==='READY'&&goal.checkpoint.runtime==='codex-staging'){
  await db.query(`UPDATE ${TABLE} SET status='BLOCKED',answer='The worker stopped before starting this request. Your goal is saved; you can continue it here.',
   checkpoint=jsonb_set(checkpoint,'{harness}',COALESCE(checkpoint->'harness','{}'::jsonb)||$4::jsonb),updated_at=now()
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND status='READY'`,
   [goal.workspace_id,goal.actor_user_id,goal.id,JSON.stringify({candidate:'codex',failure:{code:'WORKER_JOB_FAILED',requiresUserInput:false}})]);
 }
 // Wake only the isolated native pilot after its durable enqueue committed.
 // Notification loss cannot lose work: the existing poll remains the fallback.
 if(goal.checkpoint.runtime==='codex-staging')await db.query("SELECT pg_notify('stockchief_codex_jobs',$1)",[goal.workspace_id]).catch(()=>{});
 return queued;}
async function latest(db,ctx,startedAt=null){return (await db.query(`SELECT * FROM ${TABLE}
 WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3::timestamptz IS NULL OR created_at>$3)
 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId,startedAt])).rows[0]||null;}
async function recent(db,ctx,startedAt=null,focusedGoalId=null){
 const focus=typeof focusedGoalId==='string'&&focusedGoalId.length<=160?focusedGoalId:null;
 // Keep ordinary history bounded. A direct link can add one owned goal from
 // this conversation, without loading every historical checkpoint.
 return (await db.query(`WITH visible_ids AS (
  (SELECT id FROM ${TABLE}
   WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3::timestamptz IS NULL OR created_at>$3)
   ORDER BY created_at DESC,id DESC LIMIT 12)
  UNION
  SELECT id FROM ${TABLE}
   WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3::timestamptz IS NULL OR created_at>$3) AND id=$4
 ) SELECT goal.* FROM ${TABLE} goal JOIN visible_ids visible ON visible.id=goal.id
 WHERE goal.workspace_id=$1 AND goal.actor_user_id=$2
 ORDER BY goal.created_at,goal.id`,[ctx.workspaceId,ctx.actorId,startedAt,focus])).rows;
}
module.exports={enabled,get,progress,create,claim,save,cancel,reply,enqueue,latest,recent};
