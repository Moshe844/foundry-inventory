'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('an asynchronous carrier response cannot replace its checkpoint or strand the operation in RUNNING',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,shipping}=f,original=global.fetch;let writes=0;
 global.fetch=async(url,init={})=>{const u=new URL(url);if(u.hostname!=='api.goshippo.com')return original(url,init);const rate={object_id:'rate',amount:'1.00',currency:'USD',provider:'usps',servicelevel:{name:'Ground'}};
  const body=u.pathname.startsWith('/rates/')?rate:init.method==='POST'?(writes++,{object_id:'accepted',status:'QUEUED',rate:'rate'}):{object_id:'accepted',status:'SUCCESS',rate,label_url:'https://example.test/label.pdf',tracking_number:'TRACK'};
  return {ok:true,status:200,text:async()=>JSON.stringify(body)};};f.cleanup(()=>{global.fetch=original;});
 const adapter=require('../../src/shipping/providers/shippo'),provider={...adapter,quote:async()=>({rates:[{rateId:'rate',carrier:'usps',service:'Ground',amountMinor:100,currency:'USD'}]})},parcel=await f.parcel(),quotes=await shipping.quote(db,ctx,parcel.shipmentId,{provider}),queued=await shipping.queueLabelPurchase(db,ctx,parcel.shipmentId,quotes.rates[0].id,{idempotencyKey:'accepted-once'});
 assert.equal((await shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider})).pending,true);
 const effect=await require('../../src/operations/postgres-provider-effects').get(db,ctx.workspaceId,queued.effectId);assert.equal(effect.status,'AMBIGUOUS');assert.deepEqual(effect.providerReference,{externalId:'accepted',externalIds:['accepted'],expectedCount:1});
 assert.equal((await shipping.verifyLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider})).verified,true);assert.equal(writes,1);assert.equal((await shipping.requireShipment(db,ctx.workspaceId,parcel.shipmentId)).label_status,'PURCHASED');assert.equal(await f.balance(),4);
});
