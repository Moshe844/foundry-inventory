'use strict';
const entitlements=require('../../src/commercial/entitlements');
const cost=require('../../src/commercial/model-cost-budget');
const daily=require('../../src/commercial/model-budget');
const operations=require('../../src/commercial/operations');
const control=require('../../src/commercial/control-service');
const {MODELS}=require('./wire-policy');

// This adapter uses the SAME funded credit, per-goal, operation, purchased-pack,
// account-period and daily protections as commercial.complete(). It is a native
// wire transport, so each provider request (including each retry) gets a hold.
function createCommercialAccounting(database){return {
 async goalRemainingMicroUsd({goalId,ctx}){
  const row=(await database.query(`SELECT g.budget_minor-COALESCE((SELECT SUM(CASE
    WHEN h.status IN ('RESERVED','UNKNOWN') THEN h.maximum_minor WHEN h.status='SETTLED' THEN h.actual_minor ELSE 0 END)
    FROM commercial_model_cost_holds h WHERE h.goal_id=g.id),0) AS remaining
    FROM stockchief_runtime.assistant_goals g WHERE g.id=$1 AND g.workspace_id=$2 AND g.actor_user_id=$3`,
   [goalId,ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new Error('GOAL_NOT_FOUND');return Math.max(0,Math.floor(Number(row.remaining)*10000));
 },
 inputAllowance:({provider,outputTokens})=>cost.nativeInputTokenAllowance(database,{name:provider,model:MODELS[provider]},outputTokens),
 async begin(call){
  // This value comes from the relay's fresh host authorization for this exact
  // HTTP boundary, never from the model body or a prior request. Reuse that
  // entitlement snapshot; all dollar reservations still run below.
  const checked=call.admissionAccess?.commercialAccess;
  if(checked&&(checked.scope.workspaceId!==call.ctx.workspaceId||!checked.scope.accountId||
    checked.entitlement?.capability!=='ask.lookup'||checked.entitlement.enabled!==true))throw Error('COMMERCIAL_ADMISSION_SCOPE_MISMATCH');
  const scope=checked?.scope||await entitlements.ownerScopeForWorkspace(database,call.ctx.workspaceId);
  const entitlement=checked?.entitlement||await entitlements.assertCapability(database,scope,'ask.lookup');
  const key=`${scope.workspaceId}:environment:${call.id}`;
  const provider={name:call.provider,model:call.body?.model||MODELS[call.provider],
   ...(call.codexPolicy?.PROFILE.providerVersion?{providerVersion:call.codexPolicy.PROFILE.providerVersion}:{})};
  const providerVersion=call.codexPolicy?.PROFILE.providerVersion||
    (call.provider==='openai'?'responses-2026-10-11':'2023-06-01');
  const held={scope,key,provider,providerVersion};
  if(call.accountingMode==='existing'){
   // Bind one HTTP request to the unchanged controller's ALREADY reserved
   // canonical hold. Do not double-charge its goal/account dollar exposure.
   return database.transaction(async client=>{
    const holds=(await client.query(`SELECT * FROM commercial_model_cost_holds WHERE account_id=$1 AND workspace_id=$2
     AND goal_id=$3 AND provider=$4 AND model=$5 AND status='RESERVED' FOR UPDATE`,
     [scope.accountId,scope.workspaceId,call.goalId,provider.name,provider.model])).rows;
    if(holds.length!==1||holds[0].detail.nativeRelayCallId)throw new Error('A unique unused canonical commercial hold is required.');
    const hold=holds[0];
    if(Number(hold.maximum_minor)*10000<call.upperBoundMicroUsd)throw new Error('Canonical hold does not cover this wire request.');
    await client.query(`UPDATE commercial_model_cost_holds SET detail=detail||$2::jsonb WHERE id=$1`,
     [hold.id,JSON.stringify({nativeRelayCallId:call.id,nativeRelayUpperBoundMicroUsd:call.upperBoundMicroUsd})]);
    return {...held,key:hold.idempotency_key,existing:true,cost:hold};
   },{isolation:'SERIALIZABLE',retrySafe:true});
  }
  held.fundingKey=`${scope.workspaceId}:${call.fundingKey}`;
  try{
   held.cost=await cost.reserveNative(database,scope,provider,call,'ask',key,
    `${scope.workspaceId}:${call.fundingKey}`,{goalId:call.goalId,actorId:call.ctx.actorId,subscription:entitlement.subscription});
   held.day=await daily.begin(database,scope.accountId);return held;
  }catch(error){if(held.cost)await cost.release(database,scope,key);throw error;}
 },
 async complete(held,receipt){
  // The original wrapper settles after receiving this same response. Its full
  // reservation remains held until then, including after interruption.
  if(held.existing)return;
  const openai=held.provider.name==='openai';
  const input=openai?Math.max(0,receipt.inputTokens-receipt.cacheReadTokens-receipt.cacheWrite5mTokens):receipt.raw.input_tokens;
  await operations.modelUsage(database,held.scope,{provider:held.provider.name,model:held.provider.model,
   providerVersion:openai&&['default','standard'].includes(receipt.returnedServiceTier)?'responses-2026-10-11':held.providerVersion,
   inputTokens:input,outputTokens:receipt.outputTokens,
   cacheReadTokens:receipt.cacheReadTokens,cacheWrite5mTokens:receipt.cacheWrite5mTokens,cacheWrite1hTokens:receipt.cacheWrite1hTokens},held.key,{operation:'ask',nativeSdk:true});
  if(receipt.inputTokens===0&&receipt.outputTokens===0)await control.recordCost(database,held.scope,{
   provider:held.provider.name,model:held.provider.model,operation:'zero_token_response',unit:'request',quantity:1,
   idempotencyKey:`${held.key}:zero`,amountMinor:0,costBasis:'PROVIDER_USAGE',costConfidence:'HIGH',costSource:'native API usage receipt'});
  const settled=await cost.settle(database,held.scope,held.key);
  if(!settled.known||settled.actualMinor>settled.maximumMinor)throw new Error('COMMERCIAL_COST_UNVERIFIED');
  await entitlements.commitUsage(database,held.scope,{meter:'ai_work_credits',idempotencyKey:held.fundingKey});
 },
 async unknown(held,reason){
  if(held.existing)return;
  await daily.failed(database,held.scope.accountId,held.day);
  await control.recordCost(database,held.scope,{provider:held.provider.name,model:held.provider.model,
   operation:'unknown_model_outcome',unit:'request',quantity:1,idempotencyKey:`${held.key}:unknown`,detail:{reason,nativeSdk:true}});
  await cost.settle(database,held.scope,held.key,{failed:true});
 },
 async release(held){if(!held.existing)await cost.release(database,held.scope,held.key);}
};}
module.exports={createCommercialAccounting};
