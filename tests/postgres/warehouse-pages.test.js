'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('warehouse pages retain whole-wave totals and never infer carton readiness from a partial page',{timeout:180000},async t=>{
 const {db,ctx,item,location,workflows}=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:20});
 const waves=require('../../src/operations/postgres-fulfillment-waves');
 const orders=[];
 for(let i=0;i<3;i++){
  const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,idempotencyKey:'page-order-'+i,
   lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:100}]});
  await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'confirm-page-'+i});orders.push(order);
 }
 let ready=await waves.readyOrders(db,ctx.workspaceId,{limit:2});assert.equal(ready.length,2);assert(ready.nextId);
 const rest=await waves.readyOrders(db,ctx.workspaceId,{limit:2,afterId:ready.nextId});assert.equal(rest.length,1);assert.equal(rest.nextId,null);
 assert.equal(new Set([...ready,...rest].map(r=>r.id)).size,3);
 const first=await waves.create(db,ctx,{orderIds:orders.slice(0,2).map(o=>o.salesOrderId),idempotencyKey:'page-wave-1'});
 const second=await waves.create(db,ctx,{orderIds:[orders[2].salesOrderId],idempotencyKey:'page-wave-2'});
 let all=await waves.list(db,ctx.workspaceId,{limit:1});assert.equal(all[0].id,second.waveId);assert(all.nextId);
 all=await waves.list(db,ctx.workspaceId,{limit:1,afterId:all.nextId});assert.equal(all[0].id,first.waveId);assert.equal(all.nextId,null);
 const full=await waves.get(db,ctx.workspaceId,first.waveId);
 await db.query("UPDATE fulfillment_wave_lines SET picked_quantity=planned_quantity,status='PICKED' WHERE id=$1",[full.lines[0].id]);
 const p1=await waves.get(db,ctx.workspaceId,first.waveId,{limit:1});assert.equal(p1.lines.length,1);assert.equal(p1.shipments.length,1);
 assert.deepEqual(p1.units,{planned:4,picked:2});assert.equal(p1.coverage.lineCount,2);assert(p1.coverage.nextLineId);assert(p1.coverage.nextShipmentId);
 const p2=await waves.get(db,ctx.workspaceId,first.waveId,{limit:1,afterLineId:p1.coverage.nextLineId,afterShipmentId:p1.coverage.nextShipmentId});
 assert.notEqual(p1.lines[0].id,p2.lines[0].id);assert.equal(p2.coverage.nextLineId,null);
 const shipments=[...p1.shipments,...p2.shipments];assert.equal(shipments.filter(s=>s.pick_complete).length,1);
 assert.equal(shipments.find(s=>s.shipment_id===full.lines[1].shipment_id).pick_complete,false,'An off-page unpicked line still blocks its carton');
 await assert.rejects(waves.packShipment(db,ctx,first.waveId,full.lines[1].shipment_id,{}),/pick|scan|verified/i);
 assert.equal((await waves.get(db,ctx.workspaceId,first.waveId,{afterLineId:(await waves.get(db,ctx.workspaceId,second.waveId)).lines[0].id})).lines.length,0,'Cursor from another wave cannot expose its lines');
});
