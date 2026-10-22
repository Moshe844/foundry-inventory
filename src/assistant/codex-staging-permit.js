'use strict';
// Host capabilities, never serializable and never issued by a browser/tool.
const permits=new WeakMap();
const denied=require('../../scripts/environment-agent-demo/admission-error');
async function issue({database,ctx,goalId,budget,image}){
 await require('./postgres-codex-pilot').access(database,ctx,{enabled:true});
 const goal=await require('./postgres-goal-store').get(database,ctx,goalId);
 const state=await budget.status();
 if(goal?.checkpoint.runtime!=='codex-staging'||goal.status!=='RUNNING')throw denied('native_admission_goal_state');
 if(!state.approval||state.stopped||state.expires<=Date.now())throw denied('native_admission_allowance');
 if(state.unresolved)throw denied('native_admission_unsettled_usage');
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw denied('native_admission_image');
 const permit=Object.freeze({});permits.set(permit,{budget,task:goalId,image,goalId,workspaceId:ctx.workspaceId,actorId:ctx.actorId,
  sourceHash:await require('../../scripts/environment-agent-demo/source-hash-worker').sourceHash()});return permit;
}
function has(permit){return Boolean(permit&&permits.has(permit));}
function assertBinding(permit,{budget,task,image}={}){
 const p=permits.get(permit);
 if(!p||p.budget!==budget||task&&p.task!==task||image&&p.image!==image||!require('./postgres-codex-pilot').configured({workspaceId:p.workspaceId}))
  throw denied('native_admission_binding');
 return p;
}
function assert(permit,options={}){
 const p=assertBinding(permit,options);
 if(p.sourceHash!==require('../../scripts/environment-agent-demo/certification').sourceHash())throw denied('source_integrity_changed');
 return p; // Full fresh integrity check before EVERY paid HTTP request.
}
async function assertFresh(permit,options={}){
 const p=assertBinding(permit,options);
 const hash=await require('../../scripts/environment-agent-demo/source-hash-worker').sourceHash();
 if(p.sourceHash!==hash)throw denied('source_integrity_changed');
 return assertBinding(permit,options);
}
function bind(permit,identity){const p=permits.get(permit);assertBinding(permit,{budget:p?.budget});
 if(identity.candidate!=='codex'||identity.goalId!==p.goalId||identity.workspaceId!==p.workspaceId||identity.actorId!==p.actorId)throw Error('CODEX_SESSION_AUTHORITY_BINDING_MISMATCH');}
module.exports={issue,has,assert,assertFresh,assertBinding,bind};
