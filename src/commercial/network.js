'use strict';
const entitlements=require('./entitlements');
const control=require('./control-service');
const {newId}=require('../lib/util');
function definition(url){const address=new URL(url);const host=address.hostname;
 const rows=[[/googleapis\.com$/,'gmail','communications.email_ingestion'],[/microsoft\.com$/,'microsoft365','communications.email_ingestion'],
 [/intuit\.com$/,'quickbooks','connections.accounting'],[/xero\.com$/,'xero','connections.accounting'],
 [/stripe\.com$/,'stripe','payments.customer'],[/easypost\.com$/,'easypost','shipping.rates'],[/goshippo\.com$/,'shippo','shipping.rates'],
 [/shipengine\.com$/,'shipengine','shipping.rates'],[/shipstation\.com$/,'shipstation','shipping.rates'],
 [/shopify\.com$/,'shopify','connections.commerce'],[/squareup\.com$/,'square','connections.commerce'],[/clover\.com$/,'clover','connections.commerce']];
 const found=rows.find(([pattern])=>pattern.test(host));return {provider:found?.[1]||host,capability:found?.[2]||'connections.commerce',
 version:address.pathname.match(/\/(v\d+(?:\.\d+)?)\//)?.[1]||'unversioned',host};}
async function before(context,url,init,provider){const def=definition(url);
 const headers=init.headers||{};const version=Object.entries(headers).find(([key])=>
   ['stripe-version','square-version','x-api-version'].includes(key.toLowerCase()))?.[1];
 const address=new URL(url);
 def.version=version||address.pathname.match(/\/api\/(20\d{2}-\d{2})\//)?.[1]
   ||address.pathname.match(/\/api\.xro\/(\d+\.\d+)\//)?.[1]||def.version;
 if(address.searchParams.has('minorversion'))def.version+=`:minor${address.searchParams.get('minorversion')}`;
 if(provider==='StockChief Billing')return {def,key:newId('billinghttp'),billing:true};
 if(!context.scope?.workspaceId){await control.recordCost(context.database,context.scope||{},
   {provider:def.provider,operation:'blocked_unscoped_provider_request',unit:'attempt',quantity:1,
    idempotencyKey:newId('unscoped'),providerVersion:def.version,detail:{hostname:def.host,providerNotCalled:true}});
   throw new (require('../domain/errors').ValidationError)('An outside operating request requires a scoped commercial inventory.');}
 if(context.system)return {def,key:newId('system-providerattempt'),funded:true};
 await entitlements.assertCapability(context.database,context.scope,def.capability);
 const key=newId('providerattempt');
 if(!context.funded)await entitlements.reserveUsage(context.database,context.scope,{meter:'connected_operations',units:1,idempotencyKey:key,
 detail:{operation:'provider_http',provider:def.provider,method:init.method||'GET',requestId:context.requestId}});
 return {def,key,funded:context.funded};}
async function after(context,attempt,success,detail){
 if(!attempt.billing&&!attempt.funded){if(success)await entitlements.commitUsage(context.database,context.scope,
 {meter:'connected_operations',idempotencyKey:attempt.key});else await entitlements.reverseUsage(context.database,context.scope,
 {meter:'connected_operations',idempotencyKey:attempt.key,reason:'The provider request failed.'});}
 await control.recordCost(context.database,context.scope||{},{provider:attempt.billing?'stripe_billing':attempt.def.provider,
 operation:'http_request',unit:'request',quantity:1,providerVersion:attempt.def.version,idempotencyKey:attempt.key,
 detail:{...detail,hostname:attempt.def.host,requestId:context.requestId}});}
module.exports={definition,before,after};
