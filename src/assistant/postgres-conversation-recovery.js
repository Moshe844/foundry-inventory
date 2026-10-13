'use strict';
// Explicit, model-free rollout repair for previously misclassified finals.
// Never called by a read-only browser inspection or used to retry execution.
const conversation=require('./agent-conversation'),waits=require('../../scripts/environment-agent-demo/waits');
function finalReport(h){
 if(h.candidate!=='codex'||h.codexDelivery?.state!=='SETTLED'||h.lastCodexResponse?.terminal!==true||
  h.lastCodexResponse.empty||h.lastCodexResponse.tool||!h.lastCodexResponse.usageSettled)return null;
 let response;const body=h.codexDelivery.packet?.body;
 if(typeof body!=='string')return null;
 try{response=JSON.parse(body);}catch{
  for(const line of body.split(/\r?\n/))if(line.startsWith('data: ')){
   try{const event=JSON.parse(line.slice(6));if(event.type==='response.completed')response=event.response;}catch{}
  }
 }
 if(response?.status!=='completed')return null;
 const message=response.output?.findLast(item=>item.type==='message'&&item.role==='assistant');
 const text=message?.content?.filter(c=>c.type==='output_text').map(c=>c.text).join('');
 const report=conversation.parse(text);return report?.status==='needs_user'?report:null;
}
async function recoverClarification(db,ctx,id){return db.transaction(async client=>{
 const goal=(await client.query(`SELECT * FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
 const h=goal?.checkpoint.harness;
 if(!goal||goal.status!=='BLOCKED'||new Date(goal.expires_at)<=new Date()||h?.failure?.code!=='OUTCOME_UNVERIFIED'||h.inflight||h.admissionBlock)return null;
 await waits.authority(client,ctx,h);
 const report=finalReport(h);if(!report||await waits.current(client,ctx,id,waits.dependencies(h))!=='READY')return null;
 const classified=conversation.classify({report});
 goal.status=classified.status;goal.answer=classified.answer;h.userQuestion=classified.question;h.failure=null;h.pendingReport=null;
 h.conversationRepair={source:'settled_native_final',at:new Date().toISOString()};conversation.sync(goal);
 // Original goal, SDK files, evidence, limits, ledgers and effects are untouched.
 return (await client.query(`UPDATE stockchief_runtime.assistant_goals SET status=$4,answer=$5,checkpoint=$6::jsonb,run_token=NULL,lease_until=NULL,updated_at=now()
  WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 RETURNING *`,[ctx.workspaceId,ctx.actorId,id,goal.status,goal.answer,JSON.stringify(goal.checkpoint)])).rows[0];
},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={finalReport,recoverClarification};
