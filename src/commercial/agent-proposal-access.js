'use strict';
const policy=require('./agent-plan');
const tiers=[['starter','Starter'],['growth','Growth'],['pro','Pro'],['enterprise','Custom']];
// This only describes controls. Execution independently checks current authority.
async function review(db,ctx,proposal,{mission=false}={}){
 if(proposal.status!=='PENDING')return null;
 const state=await policy.accountState(db,ctx.workspaceId),tier=policy.actionPlan(state,proposal.action_type);
 if(tier===undefined&&!policy.usesAgentTerms(state))return null;
 const job=policy.actionJob(proposal.action_type,'draft',proposal.payload),individual={blocked:false},whole={blocked:false};
 const minimum=operation=>tiers.find(([plan])=>policy.permits(plan,job,operation,{trained:true,edi:true}))?.[1];
 try{if(job&&tier!==undefined)await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'draft');}
 catch(error){if(error.code!=='entitlement_required')throw error;return {individual:{blocked:true,reason:error.message,upgrade:minimum('draft')},mission:{blocked:true,reason:error.message}};}
 const secondary=proposal.action_type==='warehouse.release_orders'?await policy.stopped(db,ctx.workspaceId,state,'warehouse.wave.create',false,proposal.payload):null;
 const stop=secondary||await policy.stopped(db,ctx.workspaceId,state,proposal.action_type,false,proposal.payload);
 if(stop)return {individual:{blocked:true,reason:stop},mission:{blocked:true,reason:stop}};
 if(!mission)return {individual,mission:whole};
 const automaticJob=policy.actionJob(proposal.action_type,'automatic',proposal.payload),automaticStop=await policy.stopped(db,ctx.workspaceId,state,proposal.action_type,true,proposal.payload)||(proposal.action_type==='warehouse.release_orders'?await policy.stopped(db,ctx.workspaceId,state,'warehouse.wave.create',true,proposal.payload):null);
 const bound=proposal.payload?.training,rule=bound?.key?(await db.query('SELECT maximum_minor FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4',[ctx.workspaceId,proposal.action_type,bound.key,bound.currency])).rows[0]:null;
 if(automaticStop)whole.reason=automaticStop;
 else if(rule&&Number(rule.maximum_minor)<bound.amountMinor)whole.reason='This step exceeds your saved '+require('../domain/currency').format(rule.maximum_minor,bound.currency)+' limit. Approve this change individually.';
 else if(policy.needsPerson(proposal.action_type,proposal.payload,state))whole.reason='This step needs its own approval. Review and approve this change individually.';
 else if(automaticJob&&tier!==undefined&&!policy.permits(tier,automaticJob,'automatic',{trained:true})){
  const label=tiers.find(([plan])=>policy.permits(plan,automaticJob,'automatic',{trained:true,edi:true}))?.[1];
  whole.reason='Automatic handling of this step requires '+(label||'a different plan')+'. You can approve this change individually.';
  whole.upgrade=label;
 }else if(automaticJob&&policy.allowance(tier,automaticJob)==='trained'&&!await require('../autopilot/draft-authority').trained(db,ctx.workspaceId,proposal.action_type,proposal.payload))whole.reason='Approve a matching example and teach its limit before approving this step as part of a whole request.';
 else if(policy.usesAgentTerms(state)&&await policy.customerOrderNeedsPerson(db,ctx.workspaceId,proposal.action_type,proposal.payload,proposal.id,state))whole.reason='Confirm this customer, delivery and taught order scope individually before proceeding.';
 whole.blocked=Boolean(whole.reason);return {individual,mission:whole};
}
module.exports={review};
