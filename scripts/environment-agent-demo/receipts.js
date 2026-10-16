'use strict';
const {createHash}=require('node:crypto');
const waits=require('./waits');
const registry=require('../../src/assistant/postgres-capability-registry').registry;
const requestHash=goal=>createHash('sha256').update(goal.original_request).digest('hex');
// Host-only, scoped read verification. No execution, approval or provider call.
async function collect(database,ctx,goal,harness,catalogue){
 const refs=waits.dependencies(harness),proposalIds=new Set(refs.proposalIds),operations=[],humanDecisions=[];
 for(const id of refs.missionIds){
  const mission=(await database.query(`SELECT steps FROM stockchief_runtime.assistant_capability_plans
   WHERE workspace_id=$1 AND actor_user_id=$2 AND goal_id=$3 AND id=$4`,[ctx.workspaceId,ctx.actorId,goal.id,id])).rows[0];
  for(const step of mission?.steps||[])if(step.proposalId)proposalIds.add(step.proposalId);
 }
 for(const id of proposalIds){
  const row=(await database.query(`SELECT id,action_type,status,result,payload,summary,source_message,executed_at,idempotency_key FROM stockchief_runtime.assistant_action_proposals
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!row){
   // A rule's human decision is resumption context, not an execution receipt
   // or proof that its trigger ran. Verify the rule/trigger separately.
   const rule=(await database.query(`SELECT id,summary,status,stated_as,resolved_changes,integrity_hash FROM operating_instruction_proposals
    WHERE workspace_id=$1 AND created_by_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
   const decision=rule&&require('./approval-handoff').recordedDecision(harness,rule,'rule');if(decision)humanDecisions.push(decision);
   continue;
  }
  const contract=registry.get(row.action_type);
  if(!catalogue?.list().some(c=>c.name===row.action_type))continue;
  const decision=require('./approval-handoff').recordedDecision(harness,row);
  if(decision)humanDecisions.push(decision);
  // executeProposalCore is the ONLY writer of EXECUTED. It runs the canonical
  // engine and verifyExecution in the SAME serializable transaction before
  // recording result + executed_at. This is durable evidence that the effect
  // committed, not an assertion that its transient postcondition still holds.
  // Replaying that predicate here rejects legitimate later operations (e.g.
  // confirmed -> fulfilled, open invoice -> paid). Current business assertions
  // are checked separately against fresh records by the final-report verifier.
  const verified=row.status==='EXECUTED'&&Boolean(row.idempotency_key)&&
   Number.isFinite(new Date(row.executed_at).getTime())&&row.executed_at!==null&&
   typeof contract?.verifyExecution==='function';
  const external=verified?await require('../../src/assistant/postgres-capability-plans').externalState(database,ctx.workspaceId,row.result||{}):null;
  operations.push({proposalId:id,capability:row.action_type,description:String(row.summary||'').slice(0,500),status:row.status,
   verified:Boolean(verified),verificationScope:'canonical_execution_at_commit',committedAt:row.executed_at||null,
   externalState:external?.state||null,result:verified?row.result:null});
 }
 return {version:1,requestHash:requestHash(goal),checkedAt:new Date().toISOString(),
  dependencyState:await waits.current(database,ctx,goal.id,refs),operations,humanDecisions};
}
function render(receipt,{wholeGoalVerified=false}={}){
 const lines=['These approved changes were executed and verified:'];
 for(const op of receipt.operations.filter(o=>o.verified)){
  // Descriptions are quoted record data, never instructions or proof of scope.
  lines.push(`- ${op.description}${op.externalState!=='DONE'?' External completion is still pending.':''}`);
 }
 if(lines.length===1)return null;
 lines.push(wholeGoalVerified?'Every requested outcome was independently verified.':receipt.dependencyState==='READY'
  ?'These recorded operations are verified. Completion of every part of the original request has not been established.'
  :`Remaining canonical work: ${receipt.dependencyState}. The full request is not complete.`);
 return lines.join('\n').slice(0,18000);
}
module.exports={collect,render,requestHash};
