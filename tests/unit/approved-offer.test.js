'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),offer=require('../../src/commercial/offers/approved-2026-11-02');
test('the owner-approved prices and allowances cannot drift',()=>{
 const keys=['products','active_skus','import_rows','members','workspaces','locations','sublocations','connections','ai_work_credits','incoming_emails','emails_sent','connected_operations'];
 const approved={starter:[1000,5000,25000,3,1,2,100,5,3000,2000,1000,5000],growth:[50000,400000,500000,10,3,10,1000,20,10000,20000,10000,50000],pro:[250000,1000000,1000000,25,10,50,10000,100,25000,100000,50000,100000]};
 assert.deepEqual(Object.values(offer.plans).map(p=>p.monthlyMinor),[19900,49900,99900]);assert.deepEqual(Object.values(offer.plans).map(p=>p.annualMinor),[199000,499000,999000]);
 for(const [id,values]of Object.entries(approved)){assert.deepEqual(keys.map(k=>offer.plans[id].limits[k]),values,id);assert(Object.isFrozen(offer.plans[id].limits));assert.equal(offer.configuration(id).stockQuantityPlanCap,null);assert.equal(offer.configuration(id).liveCheckoutAuthorized,false);}
});
test('plan definitions distinguish essential connectivity from higher automation authority',()=>{
 for(const p of Object.values(offer.plans))for(const key of ['communications.email_ingestion','connections.accounting','connections.commerce','shipping.labels','payments.customer'])assert(p.capabilities.includes(key));
 assert(!offer.plans.starter.capabilities.includes('warehouse.advanced'));assert(offer.plans.growth.capabilities.includes('warehouse.advanced'));assert(!offer.plans.growth.capabilities.includes('automation.purchasing'));assert(offer.plans.pro.capabilities.includes('automation.purchasing'));
 assert(!offer.plans.growth.capabilities.includes('authority.autonomous'));assert(offer.plans.pro.capabilities.includes('authority.autonomous'));
});
