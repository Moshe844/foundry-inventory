'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('an all-location order allocates 1245 units across five warehouses rather than reporting a false shortage',{timeout:180000},async t=>{
 const {db,ctx,item,location,workflows}=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:387});
 for(const [index,quantity]of [200,200,200,300].entries()){
  const loc=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Warehouse '+index,kind:'warehouse'});
  await require('../../src/domain/postgres-opening-stock').receive(db,ctx,{skuId:item.skuIds[0],locationId:loc.id,quantity,unitCost:'1',idempotencyKey:'additional-stock-'+index});
 }
 const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:null,idempotencyKey:'all-warehouses',lines:[{skuId:item.skuIds[0],quantity:1245,unitPriceMinor:200}]});
 const result=await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'reserve-all',requireFullAllocation:true});
 assert.equal(result.shortage,false);assert.equal(result.status,'CONFIRMED');assert.equal(new Set(result.allocations.map(a=>a.locationId)).size,5);assert.equal(result.allocations.reduce((n,a)=>n+a.quantity,0),1245);
 assert.equal((await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'reserve-all',requireFullAllocation:true})).replayed,true);
 assert.equal(Number((await db.query('SELECT sum(quantity) n FROM sales_order_allocations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),1245);
});
