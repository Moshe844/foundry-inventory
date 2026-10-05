'use strict';
const stripe=require('./stripe-billing');
const REQUIRED_EVENTS=Object.freeze([
 'checkout.session.completed','checkout.session.expired',
 'checkout.session.async_payment_succeeded','checkout.session.async_payment_failed',
 'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted',
 'invoice.paid','invoice.payment_failed',
 'payment_intent.succeeded','payment_intent.payment_failed',
 'charge.succeeded','charge.updated','refund.created','refund.updated','refund.failed',
 'charge.dispute.created','charge.dispute.updated','charge.dispute.closed',
]);
function inspectEndpoint(endpoint,expectedUrl){
 const all=endpoint.enabled_events?.includes('*');
 const missingEvents=all?[]:REQUIRED_EVENTS.filter(type=>!endpoint.enabled_events?.includes(type));
 const issues=[];
 if(endpoint.status!=='enabled')issues.push('WEBHOOK_DISABLED');
 if(endpoint.url!==expectedUrl)issues.push('WEBHOOK_URL_MISMATCH');
 if(missingEvents.length)issues.push('WEBHOOK_EVENTS_MISSING');
 if(!endpoint.api_version)issues.push('WEBHOOK_API_VERSION_UNPINNED');
 else if(endpoint.api_version!==stripe.__internal.apiVersion)issues.push('WEBHOOK_API_VERSION_MISMATCH');
 return {id:endpoint.id,url:endpoint.url,liveMode:endpoint.livemode,apiVersion:endpoint.api_version,
  missingEvents,issues,ready:issues.length===0};
}
async function audit(options={}){
 if(!options.expectedUrl)throw Error('An exact expected webhook URL is required');
 const call=options.call||stripe.__internal.call;const endpoints=[];let cursor;
 do{const page=await call(`/webhook_endpoints?limit=100${cursor?`&starting_after=${encodeURIComponent(cursor)}`:''}`,{...options,method:'GET'});
  endpoints.push(...page.data);if(page.has_more&&!page.data.length)throw Error('Stripe returned an invalid webhook page');
  cursor=page.has_more?page.data.at(-1).id:null;
 }while(cursor);
 const matches=endpoints.filter(row=>row.url===options.expectedUrl&&row.status==='enabled');
 return {endpoints:matches.map(row=>inspectEndpoint(row,options.expectedUrl)),ready:matches.length===1&&inspectEndpoint(matches[0],options.expectedUrl).ready,
  issues:matches.length===0?['NO_ACTIVE_WEBHOOK']:matches.length>1?['MULTIPLE_ACTIVE_WEBHOOKS']:[]};
}
async function repairTestEvents(endpointId,options={}){
 if(!/^sk_test_/.test(options.secretKey||''))throw Error('Configuration repair requires an explicit full TEST key; live configuration is never modified');
 const call=options.call||stripe.__internal.call;
 const row=await call(`/webhook_endpoints/${encodeURIComponent(endpointId)}`,{...options,method:'GET'});
 if(row.livemode!==false||row.url!==options.expectedUrl||row.status!=='enabled')throw Error('Refusing to modify an unexpected webhook target');
 const enabled=[...new Set([...row.enabled_events,...REQUIRED_EVENTS])];
 const values=Object.fromEntries(enabled.map((type,index)=>[`enabled_events[${index}]`,type]));
 const saved=await call(`/webhook_endpoints/${encodeURIComponent(endpointId)}`,{...options,values,
  idempotencyKey:`stockchief-webhook-events:${endpointId}:${require('node:crypto').createHash('sha256').update(enabled.join(',')).digest('hex')}`});
 return inspectEndpoint(saved,options.expectedUrl);
}
module.exports={REQUIRED_EVENTS,inspectEndpoint,audit,repairTestEvents};
