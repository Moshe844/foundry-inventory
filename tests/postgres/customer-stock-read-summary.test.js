'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('stock reads carry an atomic filtered total even when location rows are bounded',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:7}),{db,ctx}=f;
 const locations=require('../../src/domain/postgres-location-service'),inventory=require('../../src/domain/postgres-inventory-engine');
 for(let i=0;i<100;i++){
  const location=await locations.createLocation(db,ctx,{name:'Summary shelf '+i,kind:'warehouse'});
  await inventory.receive(db,ctx,{skuId:f.item.skuIds[0],locationId:location.id,quantity:2,idempotencyKey:'summary-'+i});
 }
 const auth=require('../../src/domain/postgres-auth-service'),foreign=await auth.createBusiness(db,{name:'Other owner',businessName:'Other inventory',email:randomUUID()+'@example.test',password:'Other!'+randomUUID()}),foreignCtx={workspaceId:foreign.workspaceId,actorId:foreign.userId};
 const foreignLocation=await locations.createLocation(db,foreignCtx,{name:'Foreign shelf',kind:'warehouse'}),foreignItem=await require('../../src/domain/postgres-catalog-service').createItem(db,foreignCtx,{name:'Parcel item',baseCode:f.item.skuCodes?.[0]||'OTHER-SUMMARY',trackingMode:'quantity'});
 await inventory.receive(db,foreignCtx,{skuId:foreignItem.skuIds[0],locationId:foreignLocation.id,quantity:9999,idempotencyKey:'foreign-summary'});
 const read=require('../../src/assistant/postgres-service').lookup,result=await read(db,ctx,{view:'inventory_positions',search:'Parcel item'});
 assert.equal(result.rows.length,100);assert.deepEqual(result.summary,{positionCount:101,onHand:207});
 assert.deepEqual(result.coverage,{complete:false,totalRows:101,shownRows:100,limit:100});
 assert.match(result.answer,/101/);assert.match(result.answer,/207/);
 const filtered=await read(db,ctx,{view:'inventory_positions',search:'Summary shelf 99'});assert.deepEqual(filtered.summary,{positionCount:1,onHand:2});assert.equal(filtered.coverage.complete,true);
 const empty=await read(db,ctx,{view:'inventory_positions',search:'Absent '+randomUUID()});assert.deepEqual(empty.summary,{positionCount:0,onHand:0});assert.equal(empty.coverage.complete,true);
 assert.equal(await f.balance(),207);t.diagnostic('Actual isolated PostgreSQL; bounded rows, complete aggregate, search filter and tenant isolation; no model calls.');
});
