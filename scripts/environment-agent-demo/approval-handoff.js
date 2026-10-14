'use strict';
// Host-only lifecycle. Never a model tool, execution grant or new spending gate.
// PostgreSQL owns the outbox; transport can redeliver one stable card until ack.
const {createHash}=require('node:crypto'),waits=require('./waits');
const TABLE='stockchief_runtime.assistant_goals';
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
class ApprovalHandoff extends Error {constructor(result){super('DURABLE_APPROVAL_READY');this.result=result;}}
async function proposals(client,ctx,goal,h){
 const refs=waits.dependencies(h),ids=new Set(refs.proposalIds);
 for(const missionId of refs.missionIds){const mission=(await client.query(`SELECT steps FROM stockchief_runtime.assistant_capability_plans
  WHERE workspace_id=$1 AND actor_user_id=$2 AND goal_id=$3 AND id=$4`,[ctx.workspaceId,ctx.actorId,goal.id,missionId])).rows[0];
  for(const step of mission?.steps||[])if(step.proposalId)ids.add(step.proposalId);
 }
 const rows=[];
 for(const id of ids){const p=(await client.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
  WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(p){rows.push({kind:'business',proposal:p});continue;}
  const rule=(await client.query('SELECT * FROM operating_instruction_proposals WHERE workspace_id=$1 AND created_by_user_id=$2 AND id=$3',
   [ctx.workspaceId,ctx.actorId,id])).rows[0];if(rule)rows.push({kind:'rule',proposal:rule});
 }
 return rows;
}
function snapshot(kind,p){return {kind,proposalId:p.id,action:p.action_type||'policy.propose',summary:p.summary,
 authorityReference:kind==='business'?{sourceMessage:p.source_message,idempotencyKey:p.idempotency_key}:{statedAs:p.stated_as},
 payload:kind==='business'?p.payload:{resolvedChanges:p.resolved_changes,integrityHash:p.integrity_hash}};}
async function stage(client,ctx,goal,h){
 h.approvalDeliveries||={};const current=await proposals(client,ctx,goal,h),active=[];
 for(const {kind,proposal} of current){
  const frozen=snapshot(kind,proposal),sha256=digest(frozen),id=goal.id+':approval:'+sha256;
  if(proposal.status!=='PENDING'){
   for(const d of Object.values(h.approvalDeliveries))if(d.proposalId===proposal.id)d.canonicalStatus=proposal.status;
   continue;
  }
  // A changed proposal is a new revision, never a silently reused approval.
  if(!h.approvalDeliveries[id]){
   h.approvalDeliveries[id]={id,...frozen,sha256,createdAt:new Date().toISOString(),canonicalStatus:'PENDING'};
   await client.query(`INSERT INTO stockchief_runtime.assistant_goal_events(id,goal_id,sequence,kind,detail)
    SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'approval_ready',$3::jsonb FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$2
    ON CONFLICT(id) DO NOTHING`,['approval_'+digest(id),goal.id,JSON.stringify({id,proposalId:proposal.id,kind,action:frozen.action,summary:frozen.summary,sha256})]);
  }
  active.push({...structuredClone(h.approvalDeliveries[id]),proposal:structuredClone(proposal)});
 }
 return active;
}
async function transaction(database,ctx,goalId,fn,{allowMissing=false,allowCompleted=false}={}){return database.transaction(async client=>{
 const goal=(await client.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,
  [ctx.workspaceId,ctx.actorId,goalId])).rows[0];
 if(!goal||new Date(goal.expires_at)<=new Date()||goal.status==='CANCELLED'||!allowCompleted&&goal.status==='COMPLETED')throw Error('APPROVAL_GOAL_UNAVAILABLE');
 const h=goal.checkpoint.harness;if(!h){if(allowMissing)return null;throw Error('APPROVAL_GOAL_UNAVAILABLE');}
 const before=digest({checkpoint:goal.checkpoint,status:goal.status,answer:goal.answer});
 await waits.authority(client,ctx,h);
 const cards=await stage(client,ctx,goal,h),result=await fn({client,goal,h,cards});
 require('../../src/assistant/agent-conversation').sync(goal);
 if(Buffer.byteLength(JSON.stringify(goal.checkpoint))>8*1024*1024)throw Error('SESSION_SIZE_LIMIT');
 // Polling must not rewrite an unchanged native checkpoint or move its clock.
 // Stable comparison ignores JSONB key ordering and retains every real state
 // change, new card, acknowledgement and canonical approval transition.
 if(before!==digest({checkpoint:goal.checkpoint,status:goal.status,answer:goal.answer}))await client.query(`UPDATE ${TABLE} SET checkpoint=$4::jsonb,status=$5,answer=$6,
  run_token=CASE WHEN $5='RUNNING' THEN run_token ELSE NULL END,
  lease_until=CASE WHEN $5='RUNNING' THEN lease_until ELSE NULL END,updated_at=now()
  WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,goalId,JSON.stringify(goal.checkpoint),goal.status,goal.answer]);
 return result;
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function inbox(database,ctx,goalId,{pause=false,runToken=null}={}){
 // A native read-only investigation cannot have a pending business approval
 // without a durable operation reference, outbox card or unresolved operation.
 // Checking absence releases no business data or authority. Avoid rewriting
 // the whole native checkpoint in a transaction for every such model request.
 const empty=(await database.query(`SELECT status,expires_at,jsonb_build_object(
  'inflight',checkpoint#>'{harness,inflight}','calls',checkpoint#>'{harness,calls}',
  'approvalDeliveries',checkpoint#>'{harness,approvalDeliveries}') AS h
  FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,goalId])).rows[0];
 if(empty&&['READY','RUNNING','WAITING_USER'].includes(empty.status)&&new Date(empty.expires_at)>new Date()&&!empty.h.inflight&&
  !Object.keys(empty.h.approvalDeliveries||{}).length){
  const refs=waits.dependencies(empty.h);
  if(!refs.missionIds.length&&!refs.proposalIds.length&&!refs.workIds.length)return null;
 }
 return transaction(database,ctx,goalId,({goal,h,cards})=>{
  if(!cards.length)return null;
  if(pause){
   if(h.inflight)throw Error('SESSION_OPERATION_UNRESOLVED');
   if(goal.status==='RUNNING'&&goal.run_token!==runToken)throw Error('SESSION_LEASE_LOST');
   goal.status='WAITING_APPROVAL';
   h.dependencies=waits.dependencies(h);h.completionSource='durable_approval_handoff';
  }
  if(goal.status==='WAITING_APPROVAL')goal.answer='Approval required. These changes are prepared, not executed:\n'+cards.map(c=>'- '+c.summary).join('\n');
  return {status:goal.status,answer:goal.answer,completionSource:'durable_approval_handoff',approvals:cards};
 },{allowMissing:true});
}
async function acknowledge(database,ctx,goalId,id,sha256){return transaction(database,ctx,goalId,({h,cards})=>{
 const card=cards.find(c=>c.id===id&&c.sha256===sha256);if(!card)throw Error('APPROVAL_CHANGED');
 h.approvalDeliveries[id].deliveredAt||=new Date().toISOString();return {id,acknowledged:true};
});}
async function decide({database,ctx,goalId,id,sha256,decision,execute}){
 if(decision?.source!=='human_user'||typeof decision.approved!=='boolean'||!decision.responseReference||typeof execute!=='function')
  throw Error('EXPLICIT_HUMAN_APPROVAL_REQUIRED');
 const prepared=await transaction(database,ctx,goalId,({goal,h,cards})=>{
  const stored=h.approvalDeliveries[id],card=cards.find(c=>c.id===id&&c.sha256===sha256);
  if(!stored||stored.sha256!==sha256)throw Error('APPROVAL_CHANGED');
  if(stored.decision&&stored.decision.approved!==decision.approved)throw Error('APPROVAL_DECISION_CONFLICT');
  if(!card&&!['EXECUTED','APPROVED'].includes(stored.canonicalStatus))throw Error('APPROVAL_CHANGED');
  if(h.inflight||card&&goal.status!=='WAITING_APPROVAL')throw Error('APPROVAL_NOT_READY');
  if(!card&&!stored.decision?.approved)throw Error('EXPLICIT_HUMAN_APPROVAL_REQUIRED');
  stored.decision||={...decision,at:new Date().toISOString()};
  return {card:card||structuredClone(stored),approved:stored.decision.approved,alreadyExecuted:!card};
 },{allowCompleted:true});
 if(!prepared.approved||prepared.alreadyExecuted)return prepared;
 // Canonical engine is authoritative and idempotent. Persisted human intent
 // survives a crash before/after execution; no model decides or retries it.
 const executionDatabase={...database,transaction:(operation,settings)=>database.transaction(async client=>{
  const goal=(await client.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,goalId])).rows[0];
  if(!goal||goal.status==='CANCELLED'||new Date(goal.expires_at)<=new Date())throw Error('APPROVAL_GOAL_UNAVAILABLE');
  await waits.authority(client,ctx,goal.checkpoint.harness);
  const p=prepared.card.kind==='business'?(await client.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,ctx.actorId,prepared.card.proposalId])).rows[0]:
   (await client.query('SELECT * FROM operating_instruction_proposals WHERE workspace_id=$1 AND created_by_user_id=$2 AND id=$3 FOR UPDATE',
    [ctx.workspaceId,ctx.actorId,prepared.card.proposalId])).rows[0];
  if(!p||digest(snapshot(prepared.card.kind,p))!==sha256)throw Error('APPROVAL_CHANGED');
  return operation(client);
 },settings)};
 // Validate the approved revision under the canonical engine's own transaction
 // and row lock, closing the decision-to-execution edit/cancellation gap.
 const result=await execute(prepared.card.proposal,executionDatabase);
 await transaction(database,ctx,goalId,({h})=>{
  const d=h.approvalDeliveries[id];if(!['EXECUTED','APPROVED'].includes(d?.canonicalStatus))throw Error('CANONICAL_APPROVAL_UNVERIFIED');
  d.executedAt||=new Date().toISOString();return null;
 });
 return {...prepared,result};
}
async function resumeApproved({database,ctx,goalId,id,execute}){
 const saved=await transaction(database,ctx,goalId,({h})=>{
  const d=h.approvalDeliveries[id];if(!d?.decision?.approved||d.decision.source!=='human_user')throw Error('EXPLICIT_HUMAN_APPROVAL_REQUIRED');
  return structuredClone(d);
 },{allowCompleted:true});
 return decide({database,ctx,goalId,id,sha256:saved.sha256,decision:saved.decision,execute});
}
module.exports={ApprovalHandoff,stage,inbox,acknowledge,decide,resumeApproved};
