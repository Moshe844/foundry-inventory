'use strict';
async function state(database,{provider=null}={}){
 const pool=require('../commercial/staging-certification-budget'),fundingId=pool.fundingWorkspaceId();
 if(fundingId){const funding=await pool.status(database,fundingId);if(!funding?.active||funding.remaining<=0||funding.unresolved)return {available:false,message:'AI report building is paused on this staging installation. Use a report template or the manual builder below. No AI credits will be used.'};}
 if(!provider?.complete&&!require('../config').ai.configured)return {available:false,message:'AI report building is unavailable right now. Use a report template or the manual builder below. No AI credits will be used.'};
 return {available:true,message:null};
}
// Job 154: sentences this person can build a report from, on their role and plan.
async function examples(database,ctx,actor){
 const registry=require('./postgres-registry'),entitlements=require('../commercial/entitlements'),datasets=registry.list(actor);
 const needed=[...new Set(datasets.map(entry=>registry.get(entry.key)?.commercialCapability).filter(Boolean))];
 const states=needed.length?await entitlements.capabilityStates(database,await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),needed):new Map();
 const unavailable=datasets.filter(entry=>{const required=registry.get(entry.key)?.commercialCapability;return required&&!states.get(required)?.enabled;}).map(entry=>entry.key);
 return require('./builder-entry').examplesFor(datasets,unavailable);
}
module.exports={state,examples};
