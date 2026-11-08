'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const reviews=require('../../src/autopilot/job-reviews');
const returns=require('../../src/operations/postgres-returns');

test('scheduled transfer follow-ups reach the inbox, retain partial receipts and clear on arrival',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10});
  const {db,ctx,subscribe,browser}=f,tr=require('../../src/transfers/postgres-transfer-service');
  const notices=require('../../src/autopilot/operational-notices'),handler=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  await subscribe('pro');
  const destination=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'East store',kind:'warehouse'});
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),past=require('../../src/accounting/customer-money').addDays(today,-2);
  const transfer=await tr.request(db,ctx,{fromLocationId:f.location.id,toLocationId:destination.id,expectedArrivalDate:past,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:4}]});
  for(const operation of ['approve','pick','dispatch','markInTransit'])await tr[operation](db,ctx,transfer.id,{idempotencyKey:randomUUID()});
  const [line]=(await tr.get(db,ctx.workspaceId,transfer.id)).lines;
  await db.transaction(c=>handler({id:randomUUID(),workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  await notices.refresh(db,ctx.workspaceId);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);const report=()=>reviews.run(db,ctx,'transfer-arrivals');
    if(tier==='starter'){
      await assert.rejects(report(),e=>e.code==='entitlement_required');
      assert.equal((await notices.inbox(db,ctx.workspaceId)).some(n=>n.sourceId==='agent-notice-124'),false);
    }else{
      const [r]=(await report()).rows;
      assert.equal(r.Result,'Past expected arrival');assert.equal(Number(r['Still in transit']),4);assert.equal(r['In-app reminders'],1);
      assert.ok((await notices.inbox(db,ctx.workspaceId)).some(n=>n.href==='/autopilot/reviews/transfer-arrivals'));
    }
  }
  const view=await browser.get('/needs-you').expect(200);assert.match(view.text,/Overdue warehouse transfers/);
  const receive=(received,lost)=>tr.receive(db,ctx,transfer.id,{idempotencyKey:randomUUID(),lines:[{lineId:line.id,received,lost,damaged:0}]});
  await receive(2,0);await notices.refresh(db,ctx.workspaceId);
  const partial=(await reviews.run(db,ctx,'transfer-arrivals')).rows[0];
  assert.equal(Number(partial['Still in transit']),2);assert.equal(Number(partial.Received),2);
  await receive(1,1);await notices.refresh(db,ctx.workspaceId);
  const closed=(await reviews.run(db,ctx,'transfer-arrivals')).rows[0];
  assert.equal(closed.Result,'Closed with a difference');assert.equal(Number(closed['Lost or damaged']),1);
  assert.equal((await notices.inbox(db,ctx.workspaceId)).some(n=>n.sourceId==='agent-notice-124'),false);
});

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
    const checks=await read('sales-order-checks',{filter:later.orderNumber});
    if(tier==='starter'){
      assert.match(checks.rows[0].Suggestion,/4 unreserved units and 1 overdue/);
      await assert.rejects(read('overdue-customer-orders'),e=>e.code==='entitlement_required');
    }else{
      assert.equal(checks.rows[0]['Unreserved units'],4);assert.equal(checks.rows[0]['Delivery address'],'Pickup');
      assert.equal(checks.rows[0]['Missing line prices'],0);assert.equal(checks.rows[0]['Overdue invoices'],1);
      const debt=await read('overdue-customer-orders',{filter:later.orderNumber});
      if(tier==='growth'){
        assert.match(debt.rows[0].Suggestion,/credit hold/);
        assert.match((await browser.get('/autopilot/reviews/overdue-customer-orders').expect(200)).text,/Automatic holds require Pro/);
      }else assert.equal(debt.rows[0]['Oldest due date'],yesterday);
    }
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
  const holds=require('../../src/sales/agent-order-checks');
  const draft=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:side.id,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:1200}]});
  const confirm=()=>workflows.confirmSalesOrder(db,ctx,draft.salesOrderId,{idempotencyKey:randomUUID()});
  await subscribe('pro');
  const holdPage=await browser.get('/autopilot/reviews/overdue-customer-orders').expect(200);
  await browser.post('/autopilot/reviews/overdue-customer-orders/rule').type('form').send({_csrf:f.csrf(holdPage.text),mode:'on'}).expect(303);
  await holds.assertCanRelease(db,ctx.workspaceId,draft.salesOrderId);
  await db.query("UPDATE accounts SET created_at=(now()-interval '15 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await assert.rejects(confirm(),/on hold/);
  let current=await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,draft.salesOrderId]);
  assert.equal(current.rows[0].status,'DRAFT');
  for(const tier of ['starter','growth']){
    await subscribe(tier);
    await assert.rejects(holds.configure(db,ctx,'on'),e=>e.code==='entitlement_required');
    await holds.assertCanRelease(db,ctx.workspaceId,draft.salesOrderId);
  }
  await subscribe('enterprise');
  await assert.rejects(confirm(),/on hold/);
  const invoice=(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,parcel.order.salesOrderId])).rows[0];
  const pay=amountMinor=>workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:invoice.id,method:'cash',paymentDate:today,amountMinor,idempotencyKey:randomUUID()});
  await pay(1);await assert.rejects(confirm(),/on hold/);
  await pay(Number(invoice.balance_minor)-1);
  await confirm();
  assert.equal((await read('overdue-customer-orders')).rows.length,0);
});
