'use strict';
const entitlements=require('./entitlements');
const control=require('./control-service');
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const GMAIL_PROJECT_DAILY_SAFE_CEILING=72000000; // 90% of Google's current 80M-unit threshold.
// Google publishes per-method Gmail quota units. Keep the method separate from
// the customer's one Connected Operation: a quiet poll and a fetched message
// have different provider exposure. Unknown paths retain an unknown rate.
function gmailQuota(url,method){const address=new URL(url);if(address.hostname!=='gmail.googleapis.com')return null;
 const path=address.pathname;const verb=String(method||'GET').toUpperCase();
 if(/^\/gmail\/v1\/users\/[^/]+\/profile$/.test(path)&&verb==='GET')return {method:'getProfile',units:1};
 if(/^\/gmail\/v1\/users\/[^/]+\/watch$/.test(path)&&verb==='POST')return {method:'watch',units:100};
 if(/^\/gmail\/v1\/users\/[^/]+\/history$/.test(path)&&verb==='GET')return {method:'history.list',units:2};
 if(/^\/gmail\/v1\/users\/[^/]+\/messages$/.test(path)&&verb==='GET')return {method:'messages.list',units:5};
 if(/^\/gmail\/v1\/users\/[^/]+\/messages\/send$/.test(path))
  return verb==='POST'?{method:'messages.send',units:100}:null;
 if(/^\/gmail\/v1\/users\/[^/]+\/messages\/[^/]+\/attachments\/[^/]+$/.test(path)&&verb==='GET')
  return {method:'messages.attachments.get',units:20};
 if(/^\/gmail\/v1\/users\/[^/]+\/messages\/[^/]+$/.test(path)&&verb==='GET')return {method:'messages.get',units:20};
 return null;}
function definition(url){const address=new URL(url);const host=address.hostname;
 if(host==='oauth2.googleapis.com'&&address.pathname==='/token')return {
  provider:'google_oauth',capability:'communications.email_ingestion',version:'oauth2-v1',host};
 const rows=[[/googleapis\.com$/,'gmail','communications.email_ingestion'],[/microsoft\.com$/,'microsoft365','communications.email_ingestion'],
 [/intuit\.com$/,'quickbooks','connections.accounting'],[/xero\.com$/,'xero','connections.accounting'],
 [/stripe\.com$/,'stripe','payments.customer'],[/easypost\.com$/,'easypost','shipping.rates'],[/goshippo\.com$/,'shippo','shipping.rates'],
 [/shipengine\.com$/,'shipengine','shipping.rates'],[/shipstation\.com$/,'shipstation','shipping.rates'],
 [/shopify\.com$/,'shopify','connections.commerce'],[/squareup\.com$/,'square','connections.commerce'],[/clover\.com$/,'clover','connections.commerce']];
 const found=rows.find(([pattern])=>pattern.test(host));return {provider:found?.[1]||host,capability:found?.[2]||'connections.commerce',
 version:address.pathname.match(/\/(v\d+(?:\.\d+)?)\//)?.[1]||'unversioned',host};}
async function reserveGmailQuota(database,quota,ceiling=GMAIL_PROJECT_DAILY_SAFE_CEILING){
 if(!quota||!Number.isSafeInteger(quota.units)||quota.units<1||
   !Number.isSafeInteger(ceiling)||ceiling<quota.units)
  throw new ValidationError('Unrecognized or over-limit Gmail API method; provider request was not sent.');
 const row=await database.query(`INSERT INTO commercial_provider_daily_quotas
   (provider,day_utc,reserved_units) VALUES('gmail',(now() AT TIME ZONE 'UTC')::date,$1)
   ON CONFLICT(provider,day_utc) DO UPDATE SET
    reserved_units=commercial_provider_daily_quotas.reserved_units+EXCLUDED.reserved_units,
    updated_at=now()
   WHERE commercial_provider_daily_quotas.reserved_units+EXCLUDED.reserved_units<=$2
   RETURNING reserved_units`,[quota.units,ceiling]);
 if(!row.rows.length)throw new ValidationError('Gmail project quota safety ceiling reached. Mail processing is paused before a chargeable provider call.');
 return Number(row.rows[0].reserved_units);
}
async function before(context,url,init,provider){const def=definition(url);
 const headers=init.headers||{};const version=Object.entries(headers).find(([key])=>
   ['stripe-version','square-version','x-api-version'].includes(key.toLowerCase()))?.[1];
 const address=new URL(url);
 def.version=version||address.pathname.match(/\/api\/(20\d{2}-\d{2})\//)?.[1]
   ||address.pathname.match(/\/api\.xro\/(\d+\.\d+)\//)?.[1]||def.version;
 if(address.searchParams.has('minorversion'))def.version+=`:minor${address.searchParams.get('minorversion')}`;
 if(provider==='StockChief Billing')return {def,key:newId('billinghttp'),billing:true,url,method:init.method||'GET'};
 if(!context.scope?.workspaceId){await control.recordCost(context.database,context.scope||{},
   {provider:def.provider,operation:'blocked_unscoped_provider_request',unit:'attempt',quantity:1,
    idempotencyKey:newId('unscoped'),providerVersion:def.version,detail:{hostname:def.host,providerNotCalled:true}});
   throw new (require('../domain/errors').ValidationError)('An outside operating request requires a scoped commercial inventory.');}
 if(!context.system)await entitlements.assertCapability(context.database,context.scope,def.capability);
 if(def.host==='gmail.googleapis.com')await reserveGmailQuota(context.database,gmailQuota(url,init.method));
 if(context.system)return {def,key:newId('system-providerattempt'),funded:true,url,method:init.method||'GET'};
 const key=newId('providerattempt');
 if(!context.funded)await entitlements.reserveUsage(context.database,context.scope,{meter:'connected_operations',units:1,idempotencyKey:key,
 detail:{operation:'provider_http',provider:def.provider,method:init.method||'GET',requestId:context.requestId}});
 return {def,key,funded:context.funded,url,method:init.method||'GET'};}
async function after(context,attempt,success,detail){
 if(!attempt.billing&&!attempt.funded){if(success)await entitlements.commitUsage(context.database,context.scope,
 {meter:'connected_operations',idempotencyKey:attempt.key});else await entitlements.reverseUsage(context.database,context.scope,
 {meter:'connected_operations',idempotencyKey:attempt.key,reason:'The provider request failed.'});}
 const gmail=attempt.url?gmailQuota(attempt.url,attempt.method):null;
 const billingClassification=attempt.billing?require('./stripe-request-classification').classify(attempt.url):null;
 const gmailNoIncrementalFee=gmail&&attempt.def.host==='gmail.googleapis.com'?{
   basis:'VERIFIED_NO_INCREMENTAL_GMAIL_API_FEE_BELOW_RESERVED_DAILY_THRESHOLD',
   source:'https://developers.google.com/workspace/gmail/api/reference/quota',
   projectDailySafetyCeiling:GMAIL_PROJECT_DAILY_SAFE_CEILING}:null;
 await control.recordCost(context.database,context.scope||{},{provider:attempt.billing?'stripe_billing':attempt.def.provider,
 operation:gmail?'gmail_api_quota':'http_request',unit:gmail?'quota_unit':'request',quantity:gmail?.units||1,
 providerVersion:attempt.def.version,idempotencyKey:attempt.key,
 ...(billingClassification?{amountMinor:0,costBasis:billingClassification.basis,costConfidence:'HIGH',
   costSource:billingClassification.source}:{}),
 ...(gmailNoIncrementalFee?{amountMinor:0,costBasis:gmailNoIncrementalFee.basis,
   costConfidence:'HIGH',costSource:gmailNoIncrementalFee.source}:{}),
 detail:{...detail,hostname:attempt.def.host,requestId:context.requestId,
   ...(billingClassification?{feeResponsibility:'NO_INCREMENTAL_HTTP_REQUEST_FEE',
     evidence:billingClassification,otherStripeFees:'Reconcile actual balance transactions and Billing volume charges separately.'}:{}),
   ...(gmailNoIncrementalFee?{feeResponsibility:'NO_INCREMENTAL_GMAIL_API_FEE_BELOW_DAILY_THRESHOLD',
     evidence:gmailNoIncrementalFee}:{}),
   providerOperation:gmail?.method||null,quotaSource:gmail?'https://developers.google.com/workspace/gmail/api/reference/quota':null}});}
module.exports={definition,before,after,gmailQuota,reserveGmailQuota,GMAIL_PROJECT_DAILY_SAFE_CEILING};
