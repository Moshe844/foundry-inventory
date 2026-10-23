'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('batch approval is atomic, tenant scoped, price bounded and replays the original queue without a second purchase',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),batch=require('../../src/shipping/postgres-batches'),a=await f.parcel(),b=await f.parcel();let purchases=0;
 const provider={quote:async()=>({providerShipmentIds:['carrier-parcel'],rates:[{rateId:'carrier-rate',carrier:'usps',service:'Ground',amountMinor:325,currency:'USD'}]}),buy:async()=>{purchases++;return {providerShipmentIds:['label-'+purchases],labelUrl:'https://labels.example.test/'+purchases+'.pdf',labelFormat:'PDF',trackingNumber:'TRACK-'+purchases,amountMinor:325,currency:'USD'};}};
 const ra=(await f.shipping.quote(f.db,f.ctx,a.shipmentId,{provider})).rates[0],rb=(await f.shipping.quote(f.db,f.ctx,b.shipmentId,{provider})).rates[0],entries=[{shipmentId:a.shipmentId,rateId:ra.id},{shipmentId:b.shipmentId,rateId:rb.id}];
 await assert.rejects(batch.queue(f.db,f.ctx,{entries,currency:'USD',maxAmountMinor:649,idempotencyKey:'batch-low'}),/approved.*limit/i);
 await assert.rejects(batch.queue(f.db,f.ctx,{entries:[entries[0],{...entries[1],rateId:'missing'}],currency:'USD',maxAmountMinor:650,idempotencyKey:'batch-invalid'}),/current rate/i);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM shipping_label_transactions')).rows[0].n,0);
 const result=await batch.queue(f.db,f.ctx,{entries,currency:'USD',maxAmountMinor:650,idempotencyKey:'batch-approved'});assert.equal(result.totalMinor,650);assert.equal(result.entries.length,2);
 const replay=await batch.queue(f.db,f.ctx,{entries:[...entries].reverse(),currency:'USD',maxAmountMinor:650,idempotencyKey:'batch-approved'});assert.equal(replay.id,result.id);assert.equal(replay.replayed,true);
 await assert.rejects(batch.queue(f.db,f.ctx,{entries:[entries[0]],currency:'USD',maxAmountMinor:650,idempotencyKey:'batch-approved'}),/different.*batch/i);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM shipping_label_transactions')).rows[0].n,2);assert.equal(purchases,0);
 for(const row of result.entries)await f.shipping.executeLabelPurchaseEffect(f.db,f.ctx.workspaceId,row.effect_id,{provider});
 assert.equal(purchases,2);const ready=await batch.detail(f.db,f.ctx.workspaceId,result.id);assert.equal(ready.complete,2);assert.equal(ready.entries[0].documents.length,1);assert.equal(await f.balance(),4);
 await assert.rejects(batch.detail(f.db,'another-business',result.id),/not.*found/i);
 await f.db.query("UPDATE sales_shipments SET label_status='VOIDED' WHERE id=$1",[a.shipmentId]);const voided=await batch.detail(f.db,f.ctx.workspaceId,result.id);assert.equal(voided.entries.find(r=>r.shipment_id===a.shipmentId).documents.length,0);
 assert.equal(purchases,2);
});
