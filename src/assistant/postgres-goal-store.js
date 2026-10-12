'use strict';
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const TABLE='stockchief_runtime.assistant_goals';
function enabled(ctx){return process.env.STOCKCHIEF_ADAPTIVE_ASK==='1'&&
 String(process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES||'').split(',').map(x=>x.trim()).includes(ctx.workspaceId);}
async function get(db,ctx,id){return (await db.query(`SELECT * FROM ${TABLE}
 WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0]||null;}
async function create(db,ctx,message,{usageKey=newId('goalrequest'),budgetMinor=75,page=null}={}){
 const clean=String(message||'').trim();
 if(!clean||clean.length>12000)throw new ValidationError('Describe a goal in at most 12,000 characters.');
 if(!Number.isFinite(budgetMinor)||budgetMinor<=0||budgetMinor>100)throw new ValidationError('Invalid goal budget.');
 await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'ask.lookup');
 const result=await db.query(`INSERT INTO ${TABLE}(id,workspace_id,actor_user_id,request_key,original_request,budget_minor,checkpoint)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(workspace_id,actor_user_id,request_key)
 DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`,
 [newId('goal'),ctx.workspaceId,ctx.actorId,usageKey,clean,budgetMinor,JSON.stringify({page,observations:[],discovered:[],messages:[]})]);
 const goal=result.rows[0];if(goal.original_request!==clean)throw new ValidationError('That request key already belongs to another goal.');
 return goal;
}
async function claim(db,ctx,id){
 const token=newId('goalrun');
 // An abandoned in-flight operation needs reconciliation, not blind replay.
 await db.query(`UPDATE ${TABLE} SET status='BLOCKED',answer='The previous run was interrupted. Review its recorded work before retrying.',
 run_token=NULL,lease_until=NULL,updated_at=now() WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3
 AND status='RUNNING' AND lease_until<now()`,[ctx.workspaceId,ctx.actorId,id]);
 return (await db.query(`UPDATE ${TABLE} SET status='RUNNING',run_token=$4,lease_until=now()+interval '10 minutes',updated_at=now()
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
async function reply(db,ctx,id,message){
 const text=String(message||'').trim();if(!text||text.length>4000)throw new ValidationError('Provide a brief answer to continue.');
 return (await db.query(`UPDATE ${TABLE} SET status='READY',checkpoint=jsonb_set(checkpoint,'{messages}',
 COALESCE(checkpoint->'messages','[]'::jsonb)||$4::jsonb),updated_at=now()
 WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND status='WAITING_USER' AND expires_at>now() RETURNING *`,
 [ctx.workspaceId,ctx.actorId,id,JSON.stringify([text])])).rows[0]||null;
}
async function enqueue(db,goal){return require('../operations/postgres-job-queue').enqueue(db,{workspaceId:goal.workspace_id,
 kind:goal.checkpoint.runtime==='codex-staging'?'assistant.run-codex-goal':'assistant.run-goal',payload:{goalId:goal.id,actorId:goal.actor_user_id},
 idempotencyKey:`goal:${goal.id}:${goal.updated_at.toISOString()}`,maxAttempts:1,priority:20});}
async function latest(db,ctx,startedAt=null){return (await db.query(`SELECT * FROM ${TABLE}
 WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3::timestamptz IS NULL OR created_at>$3)
 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId,startedAt])).rows[0]||null;}
async function recent(db,ctx,startedAt=null){return (await db.query(`SELECT * FROM ${TABLE}
 WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3::timestamptz IS NULL OR created_at>$3)
 ORDER BY created_at DESC,id DESC LIMIT 12`,[ctx.workspaceId,ctx.actorId,startedAt])).rows.reverse();}
module.exports={enabled,get,create,claim,save,cancel,reply,enqueue,latest,recent};
