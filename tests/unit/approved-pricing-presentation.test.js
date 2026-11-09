'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const offer=require('../../src/commercial/offers/approved-2026-11-02'),presentation=require('../../src/commercial/public-offer');
function plans(){return Object.entries(offer.plans).map(([id,p],i)=>({id,public_name:p.name,monthly_amount_minor:p.monthlyMinor,annual_amount_minor:p.annualMinor,display_order:i,active_plan_version_id:offer.id+':'+id,configuration:offer.configuration(id),entitlements:p.capabilities.map(capability=>({capability,enabled:1})),meters:offer.meters(id)}));}
test('pricing renders every approved allowance from the same plan snapshot, including four distinct usage categories',()=>{
 const html=ejs.render(fs.readFileSync(path.join(__dirname,'../../src/web/views/public/pricing.ejs'),'utf8'),{plans:plans(),offer:presentation,planNavigation:require('../../src/commercial/plan-navigation'),currentSubscription:null,account:null,checkoutOpen:false,checkoutCancelled:false,offerPacks:[],capacityProducts:[],billingInterval:'monthly',agentComparison:require('../../src/commercial/agent-plan-comparison').comparison()},{filename:path.join(__dirname,'../../src/web/views/public/pricing.ejs')});
 for(const key of Object.keys(offer.definitions))assert.equal(html.split('data-allowance="'+key+'"').length-1,3,key);
 for(const price of [19900,49900,99900])assert(html.includes('data-monthly-minor="'+price+'"'));
 assert.match(html,/100,000 units counts as 1 product and 10 SKUs/);assert.doesNotMatch(html,/Unlimited|Customer card payment connections require Custom|size or color combination/);
 for(const plan of plans()){const displayed=presentation.describe(plan);for(const feature of displayed.features)assert(plan.entitlements.some(e=>e.capability===feature.capability&&e.enabled));
  assert(displayed.features.some(f=>f.capability==='api.public'));assert(displayed.features.some(f=>f.capability==='communications.email_ingestion'));assert(displayed.features.some(f=>f.capability==='payments.customer'));
  assert.equal(displayed.features.some(f=>f.capability==='reports.advanced'),plan.id!=='starter');assert.equal(displayed.features.some(f=>f.capability==='automation.purchasing'),plan.id==='pro');}
});
test('connection cadence uses the accepted plan floor and the provider safety floor',()=>{
 const policy=require('../../src/connections/synchronization-policy');for(const [id,p]of Object.entries(offer.plans)){const state=policy.describe({provider_type:'gmail',status:'connected',expected_interval_minutes:1,plan_sync_seconds:p.syncSeconds},{poll(){}});assert.equal(state.effectiveMinutes,p.syncSeconds/60,id);}
 assert.equal(policy.describe({provider_type:'xero',expected_interval_minutes:1,plan_sync_seconds:60},{discover(){}}).effectiveMinutes,5);
});
