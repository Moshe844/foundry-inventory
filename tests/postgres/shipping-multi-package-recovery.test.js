'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('a partially purchased parcel group retains all known identities and cannot buy its first label twice',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{provider:'easypost'}),{db,ctx,shipping}=f,p=await f.parcel({boxes:[{weightGrams:100},{weightGrams:200}]}),original=global.fetch;let buys=0,reads=0;
 global.fetch=async(url,init={})=>{const u=new URL(url);if(u.hostname!=='api.easypost.com')return original(url,init);
  const write=u.pathname.endsWith('/buy');if(write)buys++;else reads++;
  const second=u.pathname.includes('parcel-b'),body=write&&second?{error:{message:'This parcel cannot use the selected carrier service.'}}:
   {id:second?'parcel-b':'parcel-a',rates:[{id:second?'r-b':'r-a',rate:'1',currency:'USD'}],selected_rate:{rate:'1',currency:'USD'},...(write||!second?{postage_label:{label_url:'https://labels.example.test/a.pdf',label_file_type:'PDF'},tracking_code:'TN'}:{})};
  return {ok:!(write&&second),status:write&&second?400:200,text:async()=>JSON.stringify(body)};};f.cleanup(()=>{global.fetch=original;});
 const adapter=require('../../src/shipping/providers/easypost'),provider={...adapter,async quote(){return {providerShipmentIds:['parcel-a','parcel-b'],rates:[{rateIds:['r-a','r-b'],carrier:'usps',service:'Ground',amountMinor:200,currency:'USD'}]};}};
 const quote=await shipping.quote(db,ctx,p.shipmentId,{provider}),queued=await shipping.queueLabelPurchase(db,ctx,p.shipmentId,quote.rates[0].id,{idempotencyKey:'two-labels'});
 const execution=await shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider});assert.equal(execution.pending,true);assert.equal(buys,2);
 const effect=await require('../../src/operations/postgres-provider-effects').get(db,ctx.workspaceId,queued.effectId);assert.deepEqual(effect.providerReference.externalIds,['parcel-a','parcel-b']);
 await assert.rejects(shipping.verifyLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider,finalAttempt:true}),error=>error.code==='shipping_label_verification_required');
 assert(reads>=2);assert.equal(buys,2);assert.equal(await f.balance(),4);
 await assert.rejects(shipping.queueLabelPurchase(db,ctx,p.shipmentId,quote.rates[0].id,{idempotencyKey:'new-click'}),/pending|review/i);assert.equal(buys,2);
});
