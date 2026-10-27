'use strict';
const entitlements=require('./entitlements'),wallet=require('./wallet'),{ValidationError}=require('../domain/errors'),{createHash}=require('node:crypto');
async function policy(db,scope){const sub=await entitlements.subscriptionFor(db,scope.accountId);if(!sub)return {scale:1,budgetMinorPerCredit:null};const row=sub.plan_version_id?(await db.query("SELECT m AS policy FROM commercial_plan_versions v CROSS JOIN LATERAL jsonb_array_elements(v.meters) m WHERE v.id=$1 AND m->>'meter'='ai_work_credits'",[sub.plan_version_id])).rows[0]?.policy:(await db.query("SELECT * FROM commercial_plan_meters WHERE plan_id=$1 AND meter='ai_work_credits'",[sub.plan_id])).rows[0];return {scale:Number(row?.credit_unit_scale||1),budgetMinorPerCredit:row?.provider_budget_minor_per_credit==null?null:Number(row.provider_budget_minor_per_credit)};}
async function units(db,scope,base){return Number(base)*(await policy(db,scope)).scale;}
// One call uses the initial open reservation. Later calls have separate stable
// reservations, preserving every settled receipt and the request's saved terms.
async function ensureFunding(client,scope,key,maximumMinor,callKey){
 await wallet.lock(client,scope,'ai_work_credits');
 const base=(await client.query("SELECT * FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2 AND meter='ai_work_credits' AND idempotency_key=$3 FOR UPDATE",[scope.accountId,scope.workspaceId,key])).rows[0];
 const p=base?.detail?.creditPolicy;if(!p?.budgetMinorPerCredit)return null;
 if(!['RESERVED','COMMITTED'].includes(base.status))throw new ValidationError('This AI request has no funded credit reservation.');
 const previous=(await client.query("SELECT 1 FROM commercial_model_cost_holds WHERE account_id=$1 AND workspace_id=$2 AND detail->>'fundingUsageEventId'=$3 LIMIT 1",[scope.accountId,scope.workspaceId,base.id])).rows.length>0;
 const required=Math.max(Number(p.scale),Math.ceil((Number(maximumMinor)-1e-8)/Number(p.budgetMinorPerCredit)));
 if(base.status==='RESERVED'&&!previous){
  const extra=Math.max(0,required-Number(base.units));if(extra){const state=await entitlements.meterState(client,scope,'ai_work_credits');if(state.remaining!==null&&extra>state.remaining)throw new entitlements.EntitlementError('This request needs more AI credits. Your saved work is preserved; no new model call was made.',{required:extra,remaining:state.remaining});await wallet.allocate(client,{...base,units:extra},state);await client.query('UPDATE commercial_usage_events SET units=units+$2 WHERE id=$1',[base.id,extra]);}
  return {eventId:base.id,fundingKey:key,credits:Number(base.units)+extra};
 }
 if(!callKey)throw new ValidationError('Additional AI work needs its stable provider request reference.');
 const fundingKey=key+':model:'+createHash('sha256').update(callKey).digest('hex');
 const result=await entitlements.reserveUsage(client,scope,{meter:'ai_work_credits',units:required,idempotencyKey:fundingKey,retryReversed:true,detail:{originalFundingKey:key,creditPolicy:p,costBoundedCredits:true}});
 return {eventId:result.event.id,fundingKey,credits:Number(result.event.units)};
}
module.exports={policy,units,ensureFunding};
