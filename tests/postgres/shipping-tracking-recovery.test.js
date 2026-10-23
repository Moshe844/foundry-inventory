'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('automatic carrier checks recover missed webhooks without fulfilling stock or repeating scans',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,shipping}=f;
 const tracking=require('../../src/shipping/postgres-tracking'),jobs=require('../../src/operations/postgres-job-queue');
 let reads=0;const provider={async quote(){return {rates:[{rateId:'g',carrier:'usps',service:'Ground',amountMinor:100,currency:'USD'}]};},async buy(){return {providerShipmentId:'label-fixture',trackingNumber:'TN-fixture',labelUrl:'https://example.test/label.pdf',amountMinor:100,currency:'USD'};},async track(){reads++;return {status:'DELIVERED',events:[{externalEventId:'carrier-delivery',status:'DELIVERED',occurredAt:'2026-10-23T12:00:00Z'}]};}};
 const p=await f.parcel(),rates=await shipping.quote(db,ctx,p.shipmentId,{provider});await shipping.buyLabel(db,ctx,p.shipmentId,rates.rates[0].id,{idempotencyKey:'buy'},{provider});
 const due=()=>db.transaction(client=>tracking.schedule(client));await due();await due();
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE kind='shipping.tracking.check'")).rows[0].n,1);
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{shippingProviderResolver:()=>provider});
 const checked=await jobs.processOne(db,{'shipping.tracking.check':handlers['shipping.tracking.check']},{owner:'tracking-fixture'});assert.equal(checked.status,'COMPLETED');assert.equal(reads,1);
 const parcel=await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId);assert.equal(parcel.status,'PACKED','a carrier scan cannot replace confirmed physical handoff');assert.equal(parcel.tracking_status,'DELIVERED');assert.equal(await f.balance(),4);
 await shipping.refreshTracking(db,ctx,p.shipmentId,{provider});assert.equal((await db.query('SELECT count(*)::int n FROM shipment_tracking_events WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
 await shipping.handoff(db,ctx,p.shipmentId,{idempotencyKey:'physical-confirmation'});assert.equal(await f.balance(),3);assert.equal((await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId)).status,'DELIVERED');
 t.diagnostic('Real PostgreSQL and durable job dispatch; simulated carrier scans.');
});
