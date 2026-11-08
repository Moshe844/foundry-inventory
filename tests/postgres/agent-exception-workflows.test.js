'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const reviews=require('../../src/autopilot/job-reviews');
const returns=require('../../src/operations/postgres-returns');

test('exception reviews distinguish shortages, deliveries, overdue documents and physically received returns on each tier', {timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10});
  const {db,ctx,workflows,shipping,subscribe,browser}=f;
  const sku=f.item.skuIds[0];
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const yesterday=require('../../src/accounting/customer-money').addDays(today,-1);
  const read=(key,more)=>reviews.run(db,ctx,key,more);
  await subscribe('pro');
  const parcel=await f.parcel({quantity:4});
  await shipping.markPacked(db,ctx,parcel.shipmentId);
  await shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TRACK-EXAMPLE'});
  await db.query('UPDATE sales_shipments SET expected_delivery_date=$2 WHERE id=$1',[parcel.shipmentId,yesterday]);
  const later=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:10,unitPriceMinor:1200}]});
  await workflows.confirmSalesOrder(db,ctx,later.salesOrderId,{idempotencyKey:randomUUID()});
  const rma=await returns.requestCustomerReturn(db,ctx,{salesOrderId:parcel.order.salesOrderId,quarantineLocationId:f.location.id,resolution:'NO_REFUND',
    idempotencyKey:randomUUID(),lines:[{salesOrderLineId:parcel.order.lineIds[0],quantity:1}]});
  await returns.authorizeCustomerReturn(db,ctx,rma.customerReturnId,{idempotencyKey:randomUUID()});
  assert.equal((await read('customer-return-rates')).rows.length,0);
  const {rows:[line]}=await db.query('SELECT id FROM customer_return_lines WHERE customer_return_id=$1',[rma.customerReturnId]);
  await returns.receiveCustomerReturn(db,ctx,rma.customerReturnId,{idempotencyKey:randomUUID(),lines:[{lineId:line.id,quantity:1}]});
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,expectedDate:yesterday,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:2,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await db.query('UPDATE accounting_customer_invoices SET due_date=$2 WHERE sales_order_id=$1',[parcel.order.salesOrderId,yesterday]);
  const stock=require('../../src/domain/postgres-inventory-engine');
  const side=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Count shelf',kind:'warehouse'});
  await stock.receive(db,ctx,{skuId:sku,locationId:side.id,quantity:3,idempotencyKey:randomUUID()});
  for(const quantity of [2,1])await stock.adjust(db,ctx,{skuId:sku,locationId:side.id,countedQuantity:quantity,reasonCode:'cycle_count',idempotencyKey:randomUUID()});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const late=await read('overdue-work');
    assert.deepEqual(new Set(late.rows.map(r=>r.Type)),new Set(['Purchase order','Shipment','Customer invoice']));
    assert.ok(late.rows.every(r=>Number(r['Days late'])===1));
    const waiting=await read('waiting-orders');
    const losses=await read('stock-exceptions');
    const rates=await read('customer-return-rates');
    if(tier==='starter'){
      await assert.rejects(read('parcel-exceptions'),e=>e.code==='entitlement_required');
      assert.match(waiting.rows[0].Suggestion,/4 units/);
      assert.match(losses.rows[0].Suggestion,/Count shelf/);
      assert.match(rates.rows[0].Suggestion,/1 of 4/);
    }else{
      assert.equal((await read('parcel-exceptions')).rows[0].Tracking,'TRACK-EXAMPLE');
      assert.equal(Number(waiting.rows[0]['Waiting units']),4);
      assert.equal(Number(losses.rows[0].Units),2);
      assert.deepEqual(rates.rows.map(r=>[r.Group,Number(r['Returned %'])]),[['Customer',25],['SKU',25]]);
      for(const r of rates.rows)await browser.get(r.link).expect(200);
    }
    const page=await browser.get('/autopilot/reviews/overdue-work').expect(200);
    assert.ok(page.text.includes(po.poNumber));
  }
  await db.query("UPDATE sales_shipments SET status='DELIVERED' WHERE id=$1",[parcel.shipmentId]);
  assert.equal((await read('parcel-exceptions')).rows.length,0);
  assert.ok(!(await read('overdue-work')).rows.some(r=>r.Type==='Shipment'));
});
