'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const billing=require('../../src/commercial/shopify-billing');
const owner={appId:'gid://shopify/App/448446889985',shopId:'gid://shopify/Shop/42',shop:'fixture.myshopify.com',appHandle:'stockchief',developmentStore:false};
function contract(plan,overrides={}){return {shop:{id:owner.shopId,myshopifyDomain:owner.shop},billingPeriod:'EVERY_30_DAYS',cancelAtEndOfCycle:false,trialEndsAt:null,currentBillingCycle:{startTime:new Date(Date.now()-60000).toISOString(),endTime:new Date(Date.now()+29*86400000).toISOString()},items:[{handle:plan,price:{__typename:'FlatRatePrice',active:true,currency:'USD',amount:(billing.PRICES[plan]/100).toFixed(2)}}],...overrides};}
for(const plan of Object.keys(billing.PRICES))test('Shopify '+plan+' validates its actual price and verified period',()=>{
 const result=billing.contract(contract(plan),owner);assert.equal(result.planId,plan);assert.equal(result.amountMinor,billing.PRICES[plan]);assert.equal(result.status,'ACTIVE');
 const free=contract(plan);free.items[0].price.amount='0';assert.throws(()=>billing.contract(free,owner),/price differs/);free.items[0].price.active=false;assert.equal(billing.contract(free,{...owner,developmentStore:true}).amountMinor,0);assert.throws(()=>billing.contract(free,owner),/active paid price/);
 const foreign=contract(plan);foreign.shop.id='gid://shopify/Shop/666';assert.throws(()=>billing.contract(foreign,owner),/another store/);
 const expired=contract(plan,{currentBillingCycle:{startTime:new Date(Date.now()-31*86400000),endTime:new Date(Date.now()-1000)}});assert.throws(()=>billing.contract(expired,owner),/current subscription period/);
});
test('Shopify rejects unknown plans, extra billable items, currencies and unsupported billing periods',()=>{
 const raw=contract('starter');raw.items[0].handle='enterprise';assert.throws(()=>billing.contract(raw,owner),/could not be matched/);
 assert.throws(()=>billing.contract(contract('starter',{billingPeriod:'ANNUAL'}),owner),/not supported/);
 const extra=contract('growth');extra.items.push({...extra.items[0]});assert.throws(()=>billing.contract(extra,owner),/not supported/);
 const wrong=contract('pro');wrong.items[0].price.currency='EUR';assert.throws(()=>billing.contract(wrong,owner),/could not be matched/);
});
test('Shopify decimal amounts are exact and reject negative or fractional cents',()=>{
 assert.equal(billing.money('199.00'),19900);for(const value of ['-199','1.999','1e3','NaN',Infinity])assert.throws(()=>billing.money(value));
});
test('Shopify period expiry independently closes operational access without waiting for a worker',()=>{
 const ent=require('../../src/commercial/entitlements');assert.equal(ent.operationalAccess({source:'SHOPIFY',status:'ACTIVE',current_period_end:new Date(Date.now()-1000)}).canOperate,false);
 assert.equal(ent.operationalAccess({source:'SELF_SERVICE',status:'ACTIVE',current_period_end:new Date(Date.now()-1000)}).canOperate,true,'Existing Stripe access logic is unchanged');
});
test('Shopify plan navigation never sends a Shopify-paid account into Stripe checkout',()=>{
 assert.equal(require('../../src/commercial/plan-navigation').destination({id:'pro'},{account:{id:'acc'},subscription:{source:'SHOPIFY',plan_id:'starter'}}),'/settings/billing');
});
module.exports={owner,contract};
