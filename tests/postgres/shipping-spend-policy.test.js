'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('postage limits reserve pending and uncertain purchases atomically and exclude ineligible services',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),policy=require('../../src/shipping/postgres-purchase-policy'),a=await f.parcel(),b=await f.parcel();
 const provider={quote:async()=>({providerShipmentIds:['carrier'],rates:[{rateId:'restricted',carrier:'usps',service:'MediaMail',amountMinor:100,currency:'USD'},{rateId:'normal',carrier:'usps',service:'GroundAdvantage',amountMinor:300,currency:'USD'}]})};
 await policy.save(f.db,f.ctx,{currency:'USD',perLabelMinor:400,rollingDayMinor:500});
 const ra=(await f.shipping.quote(f.db,f.ctx,a.shipmentId,{provider})).rates;assert.equal(ra.length,1);assert.equal(ra[0].service,'GroundAdvantage');
 const rb=(await f.shipping.quote(f.db,f.ctx,b.shipmentId,{provider})).rates;
 await f.db.query('UPDATE shipment_rates SET service=$2 WHERE id=$1',[ra[0].id,'USPS Media Mail']);await assert.rejects(f.shipping.queueLabelPurchase(f.db,f.ctx,a.shipmentId,ra[0].id,{idempotencyKey:'legacy-restricted-quote'}),/content eligibility/i);await f.db.query('UPDATE shipment_rates SET service=$2 WHERE id=$1',[ra[0].id,'GroundAdvantage']);
 const outcomes=await Promise.allSettled([f.shipping.queueLabelPurchase(f.db,f.ctx,a.shipmentId,ra[0].id,{idempotencyKey:'a'}),f.shipping.queueLabelPurchase(f.db,f.ctx,b.shipmentId,rb[0].id,{idempotencyKey:'b'})]);assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.match(outcomes.find(o=>o.status==='rejected').reason.message,/24.hour.*limit/i);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM shipping_label_transactions')).rows[0].n,1);
 assert.equal(await f.balance(),4);
});
