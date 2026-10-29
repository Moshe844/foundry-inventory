'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('business numbers use atomic counters, respect imported numbers and roll back with failed work',{timeout:180000},async t=>{
 const {db,ctx,item,workflows,parcel}=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:20});
 const numbers=require('../../src/operations/postgres-business-numbers');
 const make=(key,orderNumber)=>workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',idempotencyKey:key,orderNumber,lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:500}]});
 await make('imported-number','SO-5000000');const next=await make('after-imported');
 assert.equal((await db.query('SELECT order_number FROM sales_orders WHERE id=$1',[next.salesOrderId])).rows[0].order_number,'SO-5000001');
 await assert.rejects(db.transaction(async c=>{assert.equal(await numbers.next(c,ctx.workspaceId,'sales_orders','SO'),'SO-5000002');throw Error('rollback document');}),/rollback document/);
 const concurrent=await Promise.all(Array.from({length:10},()=>db.transaction(c=>numbers.next(c,ctx.workspaceId,'sales_orders','SO'),{retrySafe:true})));
 assert.equal(new Set(concurrent).size,10);assert(concurrent.includes('SO-5000002'));assert(concurrent.includes('SO-5000011'));
 const first=await parcel();await db.query("UPDATE sales_shipments SET shipment_number='SHP-9000000' WHERE id=$1",[first.shipmentId]);
 const second=await parcel();assert.equal((await db.query('SELECT shipment_number FROM sales_shipments WHERE id=$1',[second.shipmentId])).rows[0].shipment_number,'SHP-9000001');
 await assert.rejects(db.transaction(c=>numbers.next(c,ctx.workspaceId,'invented_table','X')),/Unsupported/);
});
