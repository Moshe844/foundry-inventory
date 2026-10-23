'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('delivery belongs to every package, including missed events, duplicate events and early scans',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,shipping}=f;
 const numbers=['BOX-A','BOX-B'],states=['DELIVERED','IN_TRANSIT'],reads=[];
 const provider={async quote(){return {rates:[{rateId:'group',carrier:'usps',service:'Ground',amountMinor:200,currency:'USD'}]};},
  async buy(){return {providerShipmentIds:['label-A','label-B'],providerLabelIds:['label-A','label-B'],trackingNumber:numbers[0],labelUrl:'https://example.test/a.pdf',labelUrls:['https://example.test/a.pdf','https://example.test/b.pdf'],amountMinor:200,currency:'USD',packages:numbers.map((trackingNumber,i)=>({externalId:'label-'+['A','B'][i],trackingNumber,labelUrl:'https://example.test/'+i+'.pdf'}))};},
  async track(_ctx,input){reads.push(input.trackingNumber);return {status:states[numbers.indexOf(input.trackingNumber)],occurredAt:'2026-10-23T15:00:00Z'};},readEvent:event=>event};
 const parcel=await f.parcel({boxes:[{weightGrams:100},{weightGrams:200}]}),rates=await shipping.quote(db,ctx,parcel.shipmentId,{provider});
 await shipping.buyLabel(db,ctx,parcel.shipmentId,rates.rates[0].id,{idempotencyKey:'two-boxes'},{provider});
 await shipping.refreshTracking(db,ctx,parcel.shipmentId,{provider});assert.deepEqual(reads,numbers);
 let saved=await shipping.requireShipment(db,ctx.workspaceId,parcel.shipmentId);assert.equal(saved.status,'PACKED');assert.equal(saved.tracking_status,'IN_TRANSIT');assert.equal(saved.delivered_at,null);assert.equal(saved.provider_packages.length,2);assert.equal(await f.balance(),4);
 await shipping.handoff(db,ctx,parcel.shipmentId,{idempotencyKey:'physical-handoff'});assert.equal(await f.balance(),3);
 const event={externalEventId:'second-delivery',trackingNumber:numbers[1],status:'DELIVERED',occurredAt:'2026-10-23T16:00:00Z'};
 const wrong=await shipping.receiveProviderEvent(db,ctx,'shippo',event,{provider,connectorId:'not-this-account'});assert.equal(wrong.applied,false);
 const delivered=await shipping.receiveProviderEvent(db,ctx,'shippo',{...event,externalEventId:'correct-second-delivery'},{provider});assert.equal(delivered.status,'DELIVERED');
 assert.equal((await shipping.receiveProviderEvent(db,ctx,'shippo',{...event,externalEventId:'correct-second-delivery'},{provider})).replayed,true);
 await shipping.applyTracking(db,ctx,parcel.shipmentId,{externalEventId:'late-first-box-scan',trackingNumber:numbers[0],status:'IN_TRANSIT',occurredAt:'2026-10-23T14:00:00Z'});
 saved=await shipping.requireShipment(db,ctx.workspaceId,parcel.shipmentId);assert.equal(saved.status,'DELIVERED');assert.equal(saved.tracking_status,'DELIVERED');assert.equal(await f.balance(),3);
 assert.equal((await db.query('SELECT count(*)::int n FROM shipment_tracking_events WHERE shipment_id=$1 AND tracking_number=$2',[parcel.shipmentId,numbers[1]])).rows[0].n,2);
});
