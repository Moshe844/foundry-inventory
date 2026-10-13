'use strict';
const models=require('../../scripts/environment-agent-demo/codex-models');
const tiers=Object.freeze(['fast','standard','complex','exceptional']);
const defaults=Object.freeze({fast:'sol-low',standard:'sol-medium',complex:'sol-high',exceptional:'astra-high'});
// Deployment-owned policy, never inferred from phrases, routes or business
// domains. Workspace/plan overrides can restrict tiers without changing tools.
function policy(ctx){
 const config=JSON.parse(process.env.STOCKCHIEF_CODEX_MODEL_POLICY||'{}');
 const selected={...config.default,...config.plans?.[ctx.plan],...config.workspaces?.[ctx.workspaceId]};
 const allowed=selected.allowedTiers||['fast','standard','complex'];
 if(!Array.isArray(allowed)||!allowed.length||allowed.some(t=>!tiers.includes(t)))throw Error('INVALID_MODEL_ROUTING_POLICY');
 const profiles={...defaults,...selected.profiles};
 for(const [tier,id]of Object.entries(profiles)){
  if(!tiers.includes(tier))throw Error('INVALID_MODEL_ROUTING_POLICY');models.getProfile(id);
 }
 const initialTier=selected.initialTier||'fast';if(!allowed.includes(initialTier))throw Error('INVALID_MODEL_ROUTING_POLICY');
 return {profiles,allowed,initialTier};
}
async function context(database,ctx){
 const config=JSON.parse(process.env.STOCKCHIEF_CODEX_MODEL_POLICY||'{}');
 if(!Object.keys(config.plans||{}).length)return ctx;
 const e=require('../commercial/entitlements'),scope=await e.ownerScopeForWorkspace(database,ctx.workspaceId);
 const subscription=await e.subscriptionFor(database,scope.accountId);
 return {...ctx,plan:subscription?.plan_id||null};
}
function nativeProfile(native){
 if(native?.profile){
  const profile=models.getProfile(native.profile);
  return profile.model===native.model&&profile.effort===native.effort?profile.id:null;
 }
 return Object.values(models.profiles).find(p=>p.model===native?.model&&p.effort===native?.effort)?.id||null;
}
function selected(goal,ctx){
 const routing=goal.checkpoint.modelRouting,native=goal.checkpoint.harness?.native?.codex;
 // Legacy High checkpoints stay High, irrespective of a changed default.
 const id=routing?.profile||nativeProfile(native)||policy(ctx).profiles[policy(ctx).initialTier];
 if(native&&!nativeProfile(native))throw Error('UNAPPROVED_NATIVE_MODEL');
 return models.getProfile(id);
}
function initial(ctx){const p=policy(ctx);return {version:1,tier:p.initialTier,profile:p.profiles[p.initialTier],history:[]};}
function promote(goal,ctx,request){
 const p=policy(ctx),current=selected(goal,ctx),tier=request.tier;
 const currentTier=goal.checkpoint.modelRouting?.tier||tiers.find(t=>p.profiles[t]===current.id)||'complex';
 if(!p.allowed.includes(tier)||tiers.indexOf(tier)<=tiers.indexOf(currentTier))throw Error('MODEL_TIER_NOT_AVAILABLE');
 if(typeof request.reason!=='string'||!request.reason.trim()||request.reason.length>1600)throw Error('INVALID_MODEL_TIER_REQUEST');
 const target=models.getProfile(p.profiles[tier]);
 if(target.id===current.id)throw Error('MODEL_TIER_NOT_AVAILABLE');
 const routing=goal.checkpoint.modelRouting||{version:1,tier:currentTier,profile:current.id,history:[]};
 const change={from:current.id,to:target.id,tier,reason:request.reason,at:new Date().toISOString()};
 routing.history=[...routing.history,change];routing.profile=target.id;routing.tier=tier;
 goal.checkpoint.modelRouting=routing;return structuredClone(routing);
}
function acceptsNative(native,profile,routing){
 const previous=nativeProfile(native);if(previous===profile.id)return true;
 const transition=routing?.history?.at(-1);
 return Boolean(previous&&transition?.from===previous&&transition.to===profile.id&&routing.profile===profile.id);
}
function instructions(ctx,profile){const p=policy(ctx);
 return `\nCurrent reasoning profile: ${profile.model}, ${profile.effort}. All profiles have the same complete tools and safety rules. Use this profile directly for work it can resolve. For a more demanding goal, request a stronger tier BEFORE an extended investigation with a final report {version:1,status:"needs_reasoning",tier:"standard"|"complex"|"exceptional",reason:string}. Standard is ordinary business reasoning; complex is ambiguous, substantial multi-step investigation or difficult recovery; exceptional is unusually hard work that genuinely needs a stronger model. Available tiers: ${p.allowed.join(', ')}. Select by reasoning difficulty and evidence, not business domain or canned workflows. This is an internal handoff, never a user clarification, approval or completed result. Do not escalate merely because a tool failed or for missing user choices. Never escalate after a valid proposal is ready or the outcome is already verified. The host may refuse a tier or its next request under the unchanged cost limits. No automatic retry or extra budget is granted.`;
}
module.exports={tiers,policy,context,selected,initial,promote,acceptsNative,instructions};
