'use strict';
const entitlements=require('../entitlements/postgres-service');
const control=require('./control-service');
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const MAIL_WRAPPERS=new Set(['authorization_exchange','catalog_sync','mailbox_poll','outbound_email','reply_email','push_renewal','webhook_registration']);
const LOGICAL_WRAPPERS=new Map([
 ['gmail',MAIL_WRAPPERS],
 ['microsoft365',MAIL_WRAPPERS],
 ['square',new Set(['authorization_exchange','catalog_sync','webhook_registration'])],
 ['shopify',new Set(['authorization_exchange','catalog_sync','webhook_registration','event_ingestion'])],
]);
async function modelUsage(database,scope,usage,key,detail={}){
 const fields=[['model_input',usage.inputTokens],['model_output',usage.outputTokens],['cache_read',usage.cacheReadTokens],
 ['cache_write_5m',usage.cacheWrite5mTokens],['cache_write_1h',usage.cacheWrite1hTokens]];
 if(usage.inputTokens==null||usage.outputTokens==null)await control.recordCost(database,scope,{provider:usage.provider||'unknown',
  model:usage.model||'',operation:'missing_token_usage',unit:'request',quantity:1,idempotencyKey:key,detail});
 // Components of one receipt are independent, idempotent cost events. Wait
 // for every write before settlement, including when one component fails.
 const component=([operation,quantity])=>({provider:usage.provider||'unknown',
  model:usage.model||'',providerVersion:usage.providerVersion||'',operation,unit:'token',quantity:Number(quantity),
  idempotencyKey:`${key}:${operation}`,detail:{...detail,latencyMs:usage.latencyMs}});
 const components=fields.filter(([,quantity])=>quantity);
 // One scope check, one priced receipt lookup and one idempotent insert for
 // all token components, on the same financial transaction as settlement.
 if(components.length)await control.recordCosts(database,scope,components.map(component));
}
async function begin(database,workspaceId,input){const scope=await entitlements.ownerScopeForWorkspace(database,workspaceId);
 if(!input.key||typeof input.key!=='string')throw new ValidationError('An operation needs its stable usage key.');
 input={...input,key:`${workspaceId}:${input.key}`};
 const category=require('./usage-operation-contract').category(input.operation),sub=await entitlements.subscriptionFor(database,scope.accountId);
 input.category=category==='api_requests'&&!sub?.plan_configuration?.offerId?'api_events':category;
 if(input.category==='emails_sent'&&!await require('./email-allowance').applies(database,scope))input.category=null;
 await entitlements.assertCapability(database,scope,input.capability);
 if(input.category==='api_requests')await require('./api-resources').admitMinute(database,scope);
 if(!input.category)return {scope,input,unmetered:true};
 const reservation=await entitlements.reserveUsage(database,scope,{id:newId('usage'),meter:input.category,
  units:input.units||1,idempotencyKey:input.key,retryReversed:input.retryReversed===true,detail:{operation:input.operation}});
 if(!reservation.created)throw new ValidationError('This operation is already recorded or in progress. Its provider work was not repeated.');
 return {scope,input};}
async function complete(database,held,detail={}){if(held.unmetered)return {unmetered:true};return entitlements.commitUsage(database,held.scope,
 {meter:held.input.category,idempotencyKey:held.input.key,detail});}
async function reverse(database,held,error){if(held.unmetered)return {unmetered:true};return entitlements.reverseUsage(database,held.scope,
 {meter:held.input.category,idempotencyKey:held.input.key,reason:error?.message});}
async function completeRetained(database,workspaceId,input,detail={}){
 const scope=await entitlements.ownerScopeForWorkspace(database,workspaceId),category=require('./usage-operation-contract').category(input.operation),key=`${workspaceId}:${input.key}`;
 if(!category)return {unmetered:true};
 const event=(await database.query('SELECT status FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2 AND meter=$3 AND idempotency_key=$4',[scope.accountId,workspaceId,category,key])).rows[0];
 if(!event)return {unmetered:true};
 // A readback settles the original hold; it cannot reserve another unit or
 // dispatch the provider operation again, even after a plan change.
 const result=await complete(database,{scope,input:{category,key}},detail);
 await database.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE account_id=$1 AND fingerprint=$2",[scope.accountId,`ambiguous-usage:${key}`]);
 return result;
}
async function run(database,workspaceId,input,operation){const held=await begin(database,workspaceId,input);let attempted=false;
 const wrapper=LOGICAL_WRAPPERS.get(input.provider)?.has(input.operation);
 try{attempted=true;const result=await require('./context').run({...require('./context').current(),database,scope:held.scope,funded:true,requestId:input.key},operation);
 await complete(database,held);return result;}
 catch(error){const writes=new Set([...require('./usage-operation-contract').writes,'outbound_email','reply_email']);
  if(writes.has(input.operation)&&!require('../operations/postgres-provider-effects').definiteFailure(error)&&
    !require('./usage-operation-contract').definiteRejection(input.operation,error)){
   await database.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
    VALUES($1,$2,$3,'AMBIGUOUS_PROVIDER_USAGE',$4::jsonb) ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN'`,
    [newId('critical'),held.scope.accountId,`ambiguous-usage:${held.input.key}`,JSON.stringify({workspaceId,operation:input.operation,
      usageKey:held.input.key,reservationRetained:true})]);
  }else await reverse(database,held,error);throw error;}
 finally{if(attempted)await control.recordCost(database,held.scope,{provider:input.provider,operation:input.operation,unit:input.unit||'operation',
  quantity:input.quantity||1,idempotencyKey:`${held.input.key}:attempt:${require('./context').current()?.attemptCount||1}`,
  providerVersion:input.providerVersion||'',
  // New provider attempts are recorded independently and
  // shared CPU/DB work is measured by the resource ledger.
  ...(wrapper?{amountMinor:0,costBasis:input.provider==='gmail'?'NO_EXTRA_GMAIL_WRAPPER_PROVIDER_FEE':'NO_EXTRA_CONNECTOR_WRAPPER_PROVIDER_FEE',
    costConfidence:'HIGH',costSource:'src/commercial/operations.js; API attempts are accounted separately'}:{}),
  detail:{attempted:true,...(wrapper?
   {feeResponsibility:'NO_EXTRA_PROVIDER_CALL_FOR_WRAPPER'}:{})}});}}
module.exports={modelUsage,begin,complete,reverse,completeRetained,run};
