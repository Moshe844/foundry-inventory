'use strict';
const plans=require('../../src/assistant/postgres-capability-plans');
const {createHash}=require('node:crypto');
async function authority(database,ctx,harness){
 const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor)throw new Error('SESSION_AUTHORITY_CHANGED');
 const sorted=Object.fromEntries(Object.keys(actor).sort().map(k=>[k,actor[k]]));
 // Use the same recursive canonicalization as the session for JSON permissions.
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const stamp=createHash('sha256').update(JSON.stringify(stable(sorted))).digest('hex');
 if(harness.authorityStamp&&harness.authorityStamp!==stamp)throw new Error('SESSION_AUTHORITY_CHANGED');
 await require('../../src/commercial/enforcement').workspace(database,ctx.workspaceId,'ask.lookup');
}
function dependencies(harness){
 const missions=new Set(),proposals=new Set(),work=new Set();
 for(const call of Object.values(harness.calls||{}))if(call.state==='DONE'){
  if(call.result?.missionId)missions.add(call.result.missionId);
  for(const outcome of call.result?.outcomes||[]){
   if(outcome.result?.proposal?.id)proposals.add(outcome.result.proposal.id);
   if(outcome.result?.workId)work.add(outcome.result.workId);
  }
 }
 return {missionIds:[...missions],proposalIds:[...proposals],workIds:[...work]};
}
async function current(database,ctx,goalId,refs){
 const statuses=[];
 for(const id of refs.missionIds){const row=(await database.query(`SELECT status FROM stockchief_runtime.assistant_capability_plans
  WHERE workspace_id=$1 AND actor_user_id=$2 AND goal_id=$3 AND id=$4`,[ctx.workspaceId,ctx.actorId,goalId,id])).rows[0];
  statuses.push(!row||['BLOCKED','CANCELLED'].includes(row.status)?'BLOCKED':row.status==='DONE'?'READY':
   row.status==='WAITING_EVENT'?'WAITING_EVENT':'WAITING_APPROVAL');}
 for(const id of refs.proposalIds){const row=(await database.query(`SELECT status,result FROM stockchief_runtime.assistant_action_proposals
  WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!row){const rule=(await database.query('SELECT status FROM operating_instruction_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
   statuses.push(rule?.status==='APPROVED'?'READY':rule?.status==='PENDING'?'WAITING_APPROVAL':'BLOCKED');
  }else if(row.status==='PENDING')statuses.push('WAITING_APPROVAL');
  else if(row.status!=='EXECUTED')statuses.push('BLOCKED');
  else{const external=await plans.externalState(database,ctx.workspaceId,row.result||{});statuses.push(external.state==='DONE'?'READY':external.state);}
 }
 for(const id of refs.workIds){const row=await require('../../src/autopilot/postgres-service').getWork(database,ctx.workspaceId,id);
  statuses.push(row.verification_status==='VERIFIED'?'READY':['FAILED','CANCELLED'].includes(row.status)?'BLOCKED':'WAITING_EVENT');}
 return statuses.includes('BLOCKED')?'BLOCKED':statuses.includes('WAITING_APPROVAL')?'WAITING_APPROVAL':
  statuses.includes('WAITING_EVENT')?'WAITING_EVENT':'READY';
}
// Demo-only resumption. It never approves or executes a dependency and never
// marks the goal complete. Finished dependencies wake fresh investigation.
async function refresh(database,ctx,goalId){
 return database.transaction(async client=>{
 const goal=(await client.query(`SELECT * FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,ctx.actorId,goalId])).rows[0];
 if(!goal?.checkpoint.harness||!['WAITING_APPROVAL','WAITING_EVENT'].includes(goal.status))return goal;
 if(new Date(goal.expires_at)<=new Date())return goal;
 await authority(client,ctx,goal.checkpoint.harness);
 const refs=dependencies(goal.checkpoint.harness),status=await current(client,ctx,goalId,refs);
 if(status===goal.status)return goal;
 const checkpoint=structuredClone(goal.checkpoint);
 checkpoint.feedback='Canonical dependency states changed. Inspect current records and verify the full original goal again.';
 return (await client.query(`UPDATE stockchief_runtime.assistant_goals SET status=$4,checkpoint=$5::jsonb,updated_at=now()
  WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND status=$6 AND expires_at>now() RETURNING *`,
  [ctx.workspaceId,ctx.actorId,goalId,status,JSON.stringify(checkpoint),goal.status])).rows[0]||null;
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function recover(database,ctx,goalId){
 return database.transaction(async client=>{
  const goal=(await client.query(`SELECT * FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,ctx.actorId,goalId])).rows[0];
  const h=goal?.checkpoint.harness;
  if(!h||goal.status!=='RUNNING'||new Date(goal.lease_until)>new Date()||new Date(goal.expires_at)<=new Date())return goal;
  await authority(client,ctx,h);
  const uncertain=h.inflight?.consequential;
  const status=uncertain?'BLOCKED':await current(client,ctx,goalId,dependencies(h));
  h.recovery={at:new Date().toISOString(),interruptedTool:h.inflight?.name||null,requiresReconciliation:Boolean(uncertain)};
  if(!uncertain){h.inflight=null;h.native.openaiState=null;}
  // Tool counters, model holds, original request and evidence are unchanged.
  return (await client.query(`UPDATE stockchief_runtime.assistant_goals SET status=$4,checkpoint=$5::jsonb,run_token=NULL,lease_until=NULL,
   answer=$6,updated_at=now() WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 RETURNING *`,
   [ctx.workspaceId,ctx.actorId,goalId,status,JSON.stringify(goal.checkpoint),uncertain?
    'An interrupted business operation requires canonical reconciliation before it can be retried.':goal.answer])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={authority,dependencies,current,refresh,recover};
