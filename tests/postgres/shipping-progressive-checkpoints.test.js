'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('multi-label checkpoints append accepted identities without replacing earlier facts or losing the claim',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,shipping}=f,effects=require('../../src/operations/postgres-provider-effects');
 const p=await f.parcel({boxes:[{weightGrams:100},{weightGrams:200}]}),quotes=await shipping.quote(db,ctx,p.shipmentId,{provider:{quote:async()=>({rates:[{rateId:'group',carrier:'usps',service:'Ground',currency:'USD',amountMinor:200}]})}});
 const queued=await shipping.queueLabelPurchase(db,ctx,p.shipmentId,quotes.rates[0].id,{idempotencyKey:'progressive'}),claimed=await effects.claim(db,ctx.workspaceId,queued.effectId),token=claimed.effect.claimToken;
 const one={externalId:'first',externalIds:['first'],expectedCount:2},both={...one,externalIds:['first','second']},save=value=>effects.checkpoint(db,ctx.workspaceId,queued.effectId,token,value,{allowReferenceExtension:true});
 await save(one);await save(both);await save(both);
 await assert.rejects(save({...both,externalIds:['replacement','second']}),/cannot be replaced/);
 await assert.rejects(save(one),/cannot be replaced/);
 await assert.rejects(effects.checkpoint(db,ctx.workspaceId,queued.effectId,'wrong-claim',both,{allowReferenceExtension:true}),/active operation/);
 const saved=await effects.get(db,ctx.workspaceId,queued.effectId);assert.deepEqual(saved.providerReference,both);assert.equal(saved.claimToken,token);assert.equal(saved.status,'RUNNING');
 assert.equal(await f.balance(),4);
});
