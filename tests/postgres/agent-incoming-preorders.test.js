'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('preorders claim exact placed supply and reserve the actual receipt at the permitted tiers',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-customer-order-page-fixture').fixture(t);
  const {db,ctx,service,workflows,skuId}=f;
  const existing=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:f.location.id,
    deliveryMethod:'PICKUP',currency:'USD',idempotencyKey:randomUUID(),lines:[{skuId,quantity:97}]});
  await workflows.confirmSalesOrder(db,ctx,existing.salesOrderId,{idempotencyKey:randomUUID()});
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const expectedDate=require('../../src/accounting/customer-money').addDays(today,4);
  const incoming=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    expectedDate,idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:15,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,incoming.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,incoming.purchaseOrderId,{idempotencyKey:randomUUID()});
  const preorderOrder=(await db.query('SELECT po_number FROM purchase_orders WHERE id=$1',[incoming.purchaseOrderId])).rows[0].po_number;
  await f.subscribe('starter');
  await assert.rejects(f.publish({preorderOrder}),e=>e.code==='entitlement_required'&&/Growth/.test(e.message));
  await f.subscribe('growth');
  await assert.rejects(f.publish(),e=>e.code==='entitlement_required'&&/Pro/.test(e.message));
  const growth=await f.publish({preorderOrder,label:'Growth incoming offer'});
  const published=await service.page(db,ctx,growth.id);
  const {preorderPrecision,...legacy}=published.source_snapshot;
  assert.equal(preorderPrecision,true);
  legacy.products=legacy.products.map(({unit_label,quantity_increment,quantity_precision,tracking_mode,...product})=>product);
  await db.query('UPDATE stockchief_runtime.agent_customer_order_pages SET source_snapshot=$3::jsonb,source_hash=$4 WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,growth.id,JSON.stringify(legacy),require('../../src/pricing/postgres-promotions').hash(legacy)]);
  const publicPage=await f.browser.get('/customer/order/'+growth.token).expect(200);
  assert.match(publicPage.text,/preorder for incoming stock/);
  const reviewed=await f.browser.post('/customer/order/'+growth.token+'/review').type('form').send({
    _csrf:f.csrf(publicPage.text),reference:'VISIBLE-PREORDER','lines[0][skuId]':skuId,'lines[0][quantity]':'3'
  });
  assert.equal(reviewed.status,200,/<p role="alert">([^<]+)/.exec(reviewed.text)?.[1]);
  assert.match(reviewed.text,new RegExp(expectedDate));
  const offered=await service.quoteRequest(db,growth.token,{reference:'ETA-CHECK',lines:[{skuId,quantity:3}]});
  await assert.rejects(service.submit(db,growth.token,{reference:'ETA-CHECK',lines:[{skuId,quantity:3}],
    confirmed:'yes',expectedHash:offered.requestHash,expectedArrival:today}),/expected stock arrival changed/);assert.doesNotMatch(reviewed.text,/Fixture parts/);
  const growthRequest=await f.send(growth,{quantity:3});
  await assert.rejects(service.configure(db,ctx,growth.id,{revision:1,confirmed:'yes'}),e=>e.code==='entitlement_required');
  assert.equal((await service.onRequest(db,ctx.workspaceId,growthRequest.id,ctx.actorId)).held,true);
  const order=async id=>(await db.query('SELECT status,confirmed_at FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  assert.equal((await order((await f.manual(growthRequest.id)).salesOrderId)).status,'DRAFT');

  await f.subscribe('pro');
  const pro=await f.publish({preorderOrder,label:'Pro incoming offer'});
  await service.configure(db,ctx,pro.id,{revision:1,confirmed:'yes'});
  const accepted=await f.send(pro,{quantity:5});
  assert.equal((await service.submit(db,pro.token,{...accepted.input,expectedHash:accepted.preview.requestHash,expectedArrival:accepted.preview.preorderArrival,confirmed:'yes'})).replayed,true);
  const jobs=require('../../src/operations/postgres-job-queue');
  assert.equal(await jobs.claim(db,{owner:'older-order-worker',kinds:[service.kind]}),null);
  const routine=await service.onRequest(db,ctx.workspaceId,accepted.id,ctx.actorId);
  assert.equal(routine.automatic,true,JSON.stringify(routine));
  assert.equal((await order(routine.salesOrderId)).status,'DRAFT');
  await assert.rejects(f.send(pro,{quantity:8}),/enough incoming stock/);
  assert.deepEqual(await service.settlePreorders(db,ctx.workspaceId),{reserved:0,held:0,drafted:0,released:0,flagged:0});
  assert.equal(await f.balance(),100);

  await workflows.receivePurchaseOrder(db,ctx,incoming.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'PREORDER-ARRIVAL',
    lines:[{lineId:incoming.lineIds[0],locationId:f.location.id,quantity:7}]});
  assert.deepEqual(await service.settlePreorders(db,ctx.workspaceId),{reserved:0,held:0,drafted:1,released:0,flagged:0},'The individually accepted Growth preorder gets a fill to approve; the Pro preorder still waits for its last unit.');
  assert.equal((await order(routine.salesOrderId)).status,'DRAFT');
  const remainder=await workflows.receivePurchaseOrder(db,ctx,incoming.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'PREORDER-REMAINDER',
    lines:[{lineId:incoming.lineIds[0],locationId:f.location.id,quantity:1}]});
  assert.equal((await db.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND payload->>'receiptId'=$3`,
    [ctx.workspaceId,service.arrivalKind,remainder.receiptId])).rowCount,1);
  await f.subscribe('growth');
  assert.equal((await service.settlePreorders(db,ctx.workspaceId)).reserved,0);
  assert.equal((await order(routine.salesOrderId)).status,'DRAFT');
  await f.subscribe('pro');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const deliveryHandlers={[service.arrivalKind]:handlers[service.arrivalKind]};
  await jobs.processOne(db,deliveryHandlers,{owner:'preorder-partial-receipt-worker'});
  await jobs.processOne(db,deliveryHandlers,{owner:'preorder-final-receipt-worker'});
  assert.equal((await order(routine.salesOrderId)).status,'CONFIRMED');
  assert.equal(await f.balance(),108);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM accounting_customer_invoices WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);

  await f.subscribe('enterprise');
  const custom=await f.publish({preorderOrder,label:'Custom incoming offer'});
  await service.configure(db,ctx,custom.id,{revision:1,confirmed:'yes'});
  const customRequest=await f.send(custom,{quantity:2});
  assert.equal((await service.onRequest(db,ctx.workspaceId,customRequest.id,ctx.actorId)).automatic,true);
  // Seven units are still coming. The Growth preorder's three already arrived and are held for it,
  // so 7 - 2 = 5 remain to claim: only one of two simultaneous claims for 3 fits.
  const contenders=await Promise.allSettled([f.send(custom,{quantity:3}),f.send(custom,{quantity:3})]);
  assert.equal(contenders.filter(result=>result.status==='fulfilled').length,1);
  assert.match(contenders.find(result=>result.status==='rejected').reason.message,/enough incoming stock/);
  assert.deepEqual(await service.settlePreorders(db,ctx.workspaceId),{reserved:0,held:0,drafted:0,released:0,flagged:0});
});
