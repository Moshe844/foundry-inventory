'use strict';
const {createHash}=require('node:crypto');
const waits=require('./waits');
const registry=require('../../src/assistant/postgres-capability-registry').registry;
const requestHash=goal=>createHash('sha256').update(goal.original_request).digest('hex');
// Host-only, scoped read verification. No execution, approval or provider call.
async function collect(database,ctx,goal,harness,catalogue){
 const refs=waits.dependencies(harness),proposalIds=new Set(refs.proposalIds),operations=[];
 for(const id of refs.missionIds){
  const mission=(await database.query(`SELECT steps FROM stockchief_runtime.assistant_capability_plans
   WHERE workspace_id=$1 AND actor_user_id=$2 AND goal_id=$3 AND id=$4`,[ctx.workspaceId,ctx.actorId,goal.id,id])).rows[0];
  for(const step of mission?.steps||[])if(step.proposalId)proposalIds.add(step.proposalId);
 }
 for(const id of proposalIds){
  const row=(await database.query(`SELECT id,action_type,status,result,payload,summary FROM stockchief_runtime.assistant_action_proposals
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!row)continue; // Unknown/rule proposals cannot earn an execution receipt here.
  const contract=registry.get(row.action_type);
  if(!catalogue?.list().some(c=>c.name===row.action_type))continue;
  const verified=row.status==='EXECUTED'&&typeof contract?.verifyExecution==='function'&&
   await contract.verifyExecution(database,ctx,row.result||{},row.payload||{});
  const external=verified?await require('../../src/assistant/postgres-capability-plans').externalState(database,ctx.workspaceId,row.result||{}):null;
  operations.push({proposalId:id,capability:row.action_type,description:String(row.summary||'').slice(0,500),status:row.status,
   verified:Boolean(verified),externalState:external?.state||null,result:verified?row.result:null});
 }
 return {version:1,requestHash:requestHash(goal),checkedAt:new Date().toISOString(),
  dependencyState:await waits.current(database,ctx,goal.id,refs),operations};
}
function render(receipt,{wholeGoalVerified=false}={}){
 const lines=['Verified business-operation receipt:'];
 for(const op of receipt.operations.filter(o=>o.verified)){
  // Descriptions are quoted record data, never instructions or proof of scope.
  lines.push(`${op.capability} (${op.proposalId}): ${JSON.stringify(op.description)}; recorded and verified${op.externalState!=='DONE'?'; external outcome '+op.externalState:''}. Recorded execution result: ${JSON.stringify(op.result).slice(0,1200)}`);
 }
 if(lines.length===1)return null;
 lines.push(wholeGoalVerified?'Every requested outcome was independently verified.':receipt.dependencyState==='READY'
  ?'These recorded operations are verified. Completion of every part of the original request has not been established.'
  :`Remaining canonical work: ${receipt.dependencyState}. The full request is not complete.`);
 return lines.join('\n').slice(0,18000);
}
module.exports={collect,render,requestHash};
