'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('multi-package measurements and format choices invalidate quotes, reject stale tabs and retain every document',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,shipping}=f,options=require('../../src/shipping/postgres-parcel-options'),p=await f.parcel();
 const original=await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId),preset=await options.savePreset(db,ctx,{name:'Two measured parcels',packages:[{weightGrams:100,lengthMm:100,widthMm:100,heightMm:100},{weightGrams:200,lengthMm:200,widthMm:100,heightMm:100}]});
 await options.applyPreset(db,ctx,p.shipmentId,preset.id,{expectedUpdatedAt:original.updated_at});assert.equal((await shipping.packagesFor(db,ctx.workspaceId,p.shipmentId)).length,2);
 await assert.rejects(shipping.setPackages(db,ctx,p.shipmentId,[{weightGrams:900}],{expectedUpdatedAt:original.updated_at}),/changed.*tab/i);
 assert.match((await shipping.state(db,ctx.workspaceId,p.shipmentId)).blocked.join(' '),/actual weight/);await shipping.setPackages(db,ctx,p.shipmentId,preset.packages);
 const provider={async quote(_ctx,input){assert.equal(input.packages.length,2);return {rates:[{rateId:'multi',carrier:'usps',service:'Ground',amountMinor:100,currency:'USD'}]};},async buy(_ctx,input){assert.equal(input.options.labelFormat,'ZPL');assert.equal(input.options.signature,'ADULT');return {providerShipmentIds:['parcel-a','parcel-b'],labelUrl:'https://labels.example.test/a.zpl',labelUrls:['https://labels.example.test/a.zpl','https://labels.example.test/b.zpl'],customsUrls:['https://labels.example.test/customs.pdf'],labelFormat:'ZPL',trackingNumber:'MULTI',packages:[{externalId:'parcel-a',trackingNumber:'MULTI'},{externalId:'parcel-b',trackingNumber:'MULTI-B'}],amountMinor:100,currency:'USD'};}};
 const quoted=await shipping.quote(db,ctx,p.shipmentId,{provider}),fresh=await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId);
 await options.saveOptions(db,ctx,p.shipmentId,{labelFormat:'ZPL',labelLayout:'4x6',signature:'ADULT',expectedUpdatedAt:fresh.updated_at});
 assert.equal((await shipping.ratesFor(db,ctx.workspaceId,p.shipmentId)).length,0);await assert.rejects(shipping.queueLabelPurchase(db,ctx,p.shipmentId,quoted.rates[0].id,{idempotencyKey:'stale-format'}),/current rate|changed/i);
 const current=await shipping.quote(db,ctx,p.shipmentId,{provider});await shipping.buyLabel(db,ctx,p.shipmentId,current.rates[0].id,{idempotencyKey:'multi-format'},{provider});
 const purchased=await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId);assert.equal(purchased.shipping_documents.length,3);assert.equal(purchased.shipping_documents[1].url,'https://labels.example.test/b.zpl');assert.equal(await f.balance(),4);
 await assert.rejects(options.saveOptions(db,ctx,p.shipmentId,{labelFormat:'PDF'}),/resolve|void/i);
});
