'use strict';
const store=require('./postgres-goal-store');
const plans=require('./postgres-capability-plans');
// Poll canonical status without inference. Only a changed, completed dependency wakes reasoning.
async function refresh(db,ctx,id){
 if(!store.enabled(ctx)&&!require('./postgres-codex-pilot').configured(ctx))return null;
 const goal=await store.get(db,ctx,id);if(!goal||!['WAITING_APPROVAL','WAITING_EVENT'].includes(goal.status))return goal;
 if(goal.checkpoint.runtime==='codex-staging')return require('../../scripts/environment-agent-demo/waits').refresh(db,ctx,id);
 const cp=goal.checkpoint;const waiting=cp.waiting;if(!waiting)return goal;
 let status='READY';const completed=[];const workObservations=[];
 for(const workId of waiting.workIds||[]){
  const work=await require('../autopilot/postgres-service').getWork(db,ctx.workspaceId,workId);
  if(work.verification_status!=='VERIFIED')return goal;
  workObservations.push({capability:'authority.execute_work',result:{status:'ANSWERED',answer:'Standing operation verified.',workId,outcome:work.outcome}});
 }
 if(waiting.missionId){
  const mission=(await db.query(`SELECT status,steps,result FROM stockchief_runtime.assistant_capability_plans
   WHERE id=$1 AND workspace_id=$2 AND actor_user_id=$3 AND goal_id=$4`,
  [waiting.missionId,ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!mission)status='BLOCKED';
  else if(mission.status!=='DONE')status=['BLOCKED','CANCELLED'].includes(mission.status)?'BLOCKED':
   mission.status==='WAITING_EVENT'?'WAITING_EVENT':'WAITING_APPROVAL';
  else {
   for(const step of mission.steps.filter(s=>s.proposalId))completed.push(step.proposalId);
  }
 }else completed.push(...waiting.proposalIds);
 const observations=[...workObservations];
 for(const proposalId of completed){
  const proposal=(await db.query(`SELECT status,result,action_type,summary FROM stockchief_runtime.assistant_action_proposals
   WHERE id=$1 AND workspace_id=$2 AND actor_user_id=$3`,[proposalId,ctx.workspaceId,ctx.actorId])).rows[0];
  if(!proposal){
   const rule=(await db.query(`SELECT status,summary FROM operating_instruction_proposals WHERE id=$1 AND workspace_id=$2`,
    [proposalId,ctx.workspaceId])).rows[0];
   if(rule?.status==='APPROVED')observations.push({capability:'policy.propose',result:{status:'ANSWERED',answer:rule.summary,ruleId:proposalId}});
   else status=rule?.status==='PENDING'?'WAITING_APPROVAL':'BLOCKED';
  }else if(proposal.status==='PENDING')status='WAITING_APPROVAL';
  else if(proposal.status!=='EXECUTED')status='BLOCKED';
  else{
   const external=await plans.externalState(db,ctx.workspaceId,proposal.result);
   if(external.state!=='DONE')status=external.state==='WAITING_EVENT'?'WAITING_EVENT':'BLOCKED';
   observations.push({capability:proposal.action_type,result:{status:'ANSWERED',answer:proposal.summary,
    completed:proposal.result,externalStatus:external.state,proposalId}});
  }
 }
 if(status==='READY'){
  // Prior reads may predate writes; force fresh investigation after approved execution.
  cp.observations=observations.map((o,index)=>({...o,index,observedAt:new Date().toISOString()}));
  cp.waiting=null;cp.feedback='Approved operations have finished. Re-read current business state and verify every part of the original goal.';
 }
 if(status===goal.status)return goal;
 return (await db.query(`UPDATE stockchief_runtime.assistant_goals SET status=$4,checkpoint=$5::jsonb,updated_at=now(),
 answer=CASE WHEN $4='BLOCKED' THEN 'A required operation was cancelled or failed. Review it before continuing.' ELSE answer END
 WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND status=$6 RETURNING *`,
 [ctx.workspaceId,ctx.actorId,id,status,JSON.stringify(cp),goal.status])).rows[0]||null;
}
async function sweep(db){
 // Let the native session recover its durable handoff before a generic lease
 // expiry turns it into a failure. No model runs in this reconciliation step.
 const interrupted=(await db.query(`SELECT id,workspace_id,actor_user_id FROM stockchief_runtime.assistant_goals
  WHERE checkpoint->>'runtime'='codex-staging' AND status='RUNNING' AND lease_until<now() AND expires_at>now() LIMIT 100`)).rows;
 for(const row of interrupted){const ctx={workspaceId:row.workspace_id,actorId:row.actor_user_id};
  if(require('./postgres-codex-pilot').configured(ctx))await require('../../scripts/environment-agent-demo/waits').recover(db,ctx,row.id);
 }
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',run_token=NULL,lease_until=NULL,
 answer='This goal expired or its previous run was interrupted. Review its recorded work.',updated_at=now()
 WHERE status NOT IN ('COMPLETED','CANCELLED','BLOCKED') AND (expires_at<=now() OR (status='RUNNING' AND lease_until<now()))`);
 const goals=(await db.query(`SELECT id,workspace_id,actor_user_id,status FROM stockchief_runtime.assistant_goals
 WHERE status IN ('READY','WAITING_APPROVAL','WAITING_EVENT') ORDER BY updated_at LIMIT 100`)).rows;
 let scheduled=0;
 for(const row of goals){const ctx={workspaceId:row.workspace_id,actorId:row.actor_user_id};if(!store.enabled(ctx)&&!require('./postgres-codex-pilot').configured(ctx))continue;
  const goal=row.status==='READY'?await store.get(db,ctx,row.id):await refresh(db,ctx,row.id);
  if(goal?.status==='READY'){const job=await store.enqueue(db,goal);if(job.created)scheduled++;}}
 return scheduled;
}
// Reconcile canonical facts promptly after settlement. This path neither
// executes a business operation nor invokes a provider/model. The existing
// native worker still owns reasoning, current authority and spending admission.
async function refreshWorkspace(db,workspaceId){
 const rows=(await db.query(`SELECT id,actor_user_id FROM stockchief_runtime.assistant_goals
  WHERE workspace_id=$1 AND checkpoint->>'runtime'='codex-staging'
  AND status IN ('WAITING_APPROVAL','WAITING_EVENT') AND expires_at>now()
  ORDER BY updated_at,id LIMIT 100`,[workspaceId])).rows;
 let scheduled=0;
 for(const row of rows){
  try{
   const goal=await refresh(db,{workspaceId,actorId:row.actor_user_id},row.id);
   if(goal?.status==='READY'&&(await store.enqueue(db,goal)).created)scheduled++;
  }catch(error){console.warn('Agent dependency reconciliation unavailable:',error.code||'DEPENDENCY_CHECK_FAILED');}
 }
 return scheduled;
}
async function watchDependencies(db,workspaceIds,wake=()=>{}){
 const allowed=new Set(workspaceIds),pending=new Set();let queue=Promise.resolve();
 // Multiplex the existing dedicated job listener, rather than holding another
 // PostgreSQL connection out of the unchanged foreground pool.
 const stop=await db.listen('stockchief_codex_jobs',message=>{
  let workspaceId=message.payload,dependency=false;
  try{const event=JSON.parse(message.payload);if(event?.kind!=='dependency_changed'||typeof event.workspaceId!=='string')return;workspaceId=event.workspaceId;dependency=true;}catch{}
  if(!allowed.has(workspaceId))return;
  if(!dependency){wake();return;}
  if(pending.has(workspaceId))return;
  pending.add(workspaceId);
  queue=queue.catch(()=>{}).then(async()=>{
   pending.delete(workspaceId);
   // store.enqueue publishes the usual job hint after its durable write. The
   // ordinary worker poll still recovers a lost notification.
   await refreshWorkspace(db,workspaceId);
  }).catch(error=>console.warn('Agent dependency notification unavailable:',error.code||'DEPENDENCY_CHECK_FAILED'));
 });
 return async()=>{await stop();await queue;};
}
module.exports={refresh,sweep,refreshWorkspace,watchDependencies};
