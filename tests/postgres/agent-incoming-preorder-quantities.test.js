'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('preorders preserve decimal increments and wait for exact recorded lot and serial stock',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-customer-order-page-fixture').fixture(t);
  const {db,ctx,service,workflows}=f,location=f.location.id;
  const catalog=require('../../src/domain/postgres-catalog-service');
  const profile=[
    {name:'Measured resin',trackingMode:'quantity',unitLabel:'kg',quantityPrecision:2,quantityIncrement:'0.25'},
    {name:'Batch paint',trackingMode:'lot'},
    {name:'Serialized tool',trackingMode:'serial'}
  ];
  const products=[];
  for(const item of profile){
    const record=await catalog.createItem(db,ctx,item),skuId=record.skuIds[0];
    await require('../../src/pricing/postgres-service').setPrice(db,ctx,{skuId,amountMinor:1200,currency:'USD'});
    products.push(skuId);
  }
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const expectedDate=require('../../src/accounting/customer-money').addDays(today,4);
  const incoming=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location,
    expectedDate,idempotencyKey:randomUUID(),lines:products.map((skuId,i)=>({skuId,quantityPurchaseUnits:[4.75,5,2][i],unitCost:'2'}))});
  await workflows.approvePurchaseOrder(db,ctx,incoming.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,incoming.purchaseOrderId,{idempotencyKey:randomUUID()});
  const number=(await db.query('SELECT po_number FROM purchase_orders WHERE id=$1',[incoming.purchaseOrderId])).rows[0].po_number;
  const page=await f.publish({preorderOrder:number,skuIds:products,label:'Measured and tracked preorder'});
  await service.configure(db,ctx,page.id,{revision:1,confirmed:'yes'});
  const visible=await f.browser.get('/customer/order/'+page.token).expect(200);
  assert.match(visible.text,/step="0\.25\d*"/);
  const request={reference:'MIXED-STOCK',lines:products.map((skuId,i)=>({skuId,quantity:[0.5,2,1][i]}))};
  await assert.rejects(service.quoteRequest(db,page.token,{...request,lines:[{skuId:products[0],quantity:'0.10'}]}),/increments/);
  const preview=await service.quoteRequest(db,page.token,request);
  assert.equal(preview.snapshot.quote.totalMinor,4200);
  const accepted=await service.submit(db,page.token,{...request,expectedHash:preview.requestHash,expectedArrival:expectedDate,confirmed:'yes'});
  const native=await service.onRequest(db,ctx.workspaceId,accepted.id,ctx.actorId,{preorder:true});
  assert.equal(native.automatic,true,JSON.stringify(native));
  const get=async()=>(await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,native.salesOrderId])).rows[0].status;
  assert.equal(await get(),'DRAFT');
  await workflows.receivePurchaseOrder(db,ctx,incoming.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[
    {lineId:incoming.lineIds[0],locationId:location,quantity:0.25},
    {lineId:incoming.lineIds[1],locationId:location,quantity:2,lotCode:'PAINT-SYNTHETIC-1'},
    {lineId:incoming.lineIds[2],locationId:location,quantity:1,serials:['TOOL-SYNTHETIC-1']}
  ]});
  assert.equal((await service.settlePreorders(db,ctx.workspaceId)).reserved,0);
  assert.equal(await get(),'DRAFT');
  await workflows.receivePurchaseOrder(db,ctx,incoming.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:incoming.lineIds[0],locationId:location,quantity:0.25}]});
  assert.equal((await service.settlePreorders(db,ctx.workspaceId)).reserved,1);
  assert.equal(await get(),'CONFIRMED');
  const allocations=(await db.query(`SELECT l.sku_id,a.quantity::text,a.location_id FROM sales_order_lines l
    JOIN sales_order_allocations a ON a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,[ctx.workspaceId,native.salesOrderId])).rows;
  assert.equal(allocations.length,3);
  assert.deepEqual(products.map(sku=>Number(allocations.find(row=>row.sku_id===sku).quantity)),[0.5,2,1]);
  assert(allocations.every(row=>row.location_id===location));
});
