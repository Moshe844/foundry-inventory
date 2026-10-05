'use strict';
const entitlements=require('../entitlements/postgres-service');
const control=require('./control-service');
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
async function modelUsage(database,scope,usage,key,detail={}){
 const fields=[['model_input',usage.inputTokens],['model_output',usage.outputTokens],['cache_read',usage.cacheReadTokens],
 ['cache_write_5m',usage.cacheWrite5mTokens],['cache_write_1h',usage.cacheWrite1hTokens]];
 if(usage.inputTokens==null||usage.outputTokens==null)await control.recordCost(database,scope,{provider:usage.provider||'unknown',
  model:usage.model||'',operation:'missing_token_usage',unit:'request',quantity:1,idempotencyKey:key,detail});
 for(const [operation,quantity] of fields){if(!quantity)continue;await control.recordCost(database,scope,{provider:usage.provider||'unknown',
  model:usage.model||'',providerVersion:usage.providerVersion||'',operation,unit:'token',quantity:Number(quantity),
  idempotencyKey:`${key}:${operation}`,detail:{...detail,latencyMs:usage.latencyMs}});}
}
async function begin(database,workspaceId,input){const scope=await entitlements.ownerScopeForWorkspace(database,workspaceId);
 if(!input.key||typeof input.key!=='string')throw new ValidationError('An operation needs its stable usage key.');
 input={...input,key:`${workspaceId}:${input.key}`};
 await entitlements.assertCapability(database,scope,input.capability);
 const reservation=await entitlements.reserveUsage(database,scope,{id:newId('usage'),meter:input.category||'connected_operations',
  units:input.units||1,idempotencyKey:input.key,retryReversed:input.retryReversed===true,detail:{operation:input.operation}});
 if(!reservation.created)throw new ValidationError('This operation is already recorded or in progress. Its provider work was not repeated.');
 return {scope,input};}
async function complete(database,held,detail={}){return entitlements.commitUsage(database,held.scope,
 {meter:held.input.category||'connected_operations',idempotencyKey:held.input.key,detail});}
async function reverse(database,held,error){return entitlements.reverseUsage(database,held.scope,
 {meter:held.input.category||'connected_operations',idempotencyKey:held.input.key,reason:error?.message});}
async function run(database,workspaceId,input,operation){const held=await begin(database,workspaceId,input);let attempted=false;
 try{attempted=true;const result=await require('./context').run({...require('./context').current(),database,scope:held.scope,funded:true,requestId:input.key},operation);
 await complete(database,held);return result;}
 catch(error){const writes=new Set(['customer_create','invoice_create','refund_create','mail_send','outbound_send','outbound_email','reply_email','label_purchase']);
  if(writes.has(input.operation)&&!require('../operations/postgres-provider-effects').definiteFailure(error)){
   await database.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
    VALUES($1,$2,$3,'AMBIGUOUS_PROVIDER_USAGE',$4::jsonb) ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN'`,
    [newId('critical'),held.scope.accountId,`ambiguous-usage:${held.input.key}`,JSON.stringify({workspaceId,operation:input.operation,
      usageKey:held.input.key,reservationRetained:true})]);
  }else await reverse(database,held,error);throw error;}
 finally{if(attempted)await control.recordCost(database,held.scope,{provider:input.provider,operation:input.operation,unit:input.unit||'operation',
  quantity:input.quantity||1,idempotencyKey:`${held.input.key}:attempt:${require('./context').current()?.attemptCount||1}`,
  providerVersion:input.providerVersion||'',detail:{attempted:true}});}}
module.exports={modelUsage,begin,complete,reverse,run};
