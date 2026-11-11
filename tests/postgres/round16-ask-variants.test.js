'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Ask reads arbitrary option values exactly, includes every location and preserves single-character variant identities',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),read=require('../../src/assistant/postgres-variant-stock-read').read,direct=require('../../src/assistant/direct-business-reads'),other=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Overflow',kind:'warehouse'});
 const item=await catalog.createItem(db,ctx,{name:'Read Test Product',baseCode:'READ-V',trackingMode:'quantity',hasVariants:true,options:[{name:'Size',values:'9,19'},{name:'Color',values:'Black,White'},{name:'Fit',values:'L,XL'}]});
 const small=(await db.query("SELECT id,code FROM skus WHERE workspace_id=$1 AND item_id=$2 AND variant_label='9 / Black / L'",[ctx.workspaceId,item.itemId])).rows[0];for(const [locationId,quantity]of [[f.location.id,4],[other.id,3]])await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:small.id,locationId,quantity,unitCost:'4',idempotencyKey:'ask-variant-'+locationId});
 const exact=await read(db,ctx.workspaceId,'Read Test Product size 9 color Black fit L');assert.equal(exact.skuCount,1);assert.equal(exact.rows.length,2);assert.equal(exact.totals[0].quantity,7);assert(exact.rows.every(r=>r.sku===small.code));assert.equal(await read(db,'other-inventory','Read Test Product size 9 color Black fit L'),null);
 const service={resolveSku:async()=>{throw Error('The exact configured option read should handle this question');}},answer=await direct.run(service,db,ctx,'How many size 9 Black fit L units of Read Test Product are on hand, by warehouse?');assert.equal(answer.result.status,'ANSWERED');assert.match(answer.result.answer,/7 units on hand/);assert.match(answer.result.answer,/Dispatch: 4/);assert.match(answer.result.answer,/Overflow: 3/);assert.equal(answer.provenance.modelCalls,0);
 const coffee=await catalog.createItem(db,ctx,{name:'Coffee by weight',baseCode:'COFF-W',trackingMode:'quantity',hasVariants:true,options:[{name:'Flavor',values:'Original,Vanilla'},{name:'Bag size',values:'0.5kg,1kg'}]});const result=await read(db,ctx.workspaceId,'Coffee by weight Flavor Vanilla Bag size 0.5kg');assert.equal(result.skuCount,1);assert.match(result.rows[0].variant,/Vanilla.*0\.5kg/);assert.equal(result.rows[0].onHand,0);
 await require('../../src/domain/postgres-sku-maintenance').update(db,ctx,coffee.itemId,result.rows[0].href.split('#sku-')[1],{active:false});assert.equal(await read(db,ctx.workspaceId,'Coffee by weight Flavor Vanilla Bag size 0.5kg'),null);
 assert.equal(direct.classify('Which variant sells best?').kind,'product_ranking');
 // An exact code must not also match unrelated product names containing its
 // words. Barcode lookup must return the same variant across all locations.
 await catalog.createItem(db,ctx,{name:'Another '+small.code,baseCode:'UNRELATED-EXACT',trackingMode:'quantity'});
 await db.query('UPDATE skus SET barcode=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,small.id,'EXACT-READ-987']);
 for(const code of [small.code.toLowerCase(),'exact-read-987']){const matched=await read(db,ctx.workspaceId,code);assert.equal(matched.skuCount,1);assert.equal(matched.totals[0].quantity,7);assert(matched.rows.every(r=>r.sku===small.code));}
});

test('one Ask answer shows exact stock across locations without counting transit or supplier custody as owned on hand',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx}=f;
 const {randomUUID}=require('node:crypto');
 const locations=require('../../src/domain/postgres-location-service');
 const transfers=require('../../src/transfers/postgres-transfer-service');
 const custody=require('../../src/custody/postgres-service');
 const direct=require('../../src/assistant/direct-business-reads');
 const skuId=f.item.skuIds[0];
 const code=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId])).rows[0].code;
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 await f.subscribe('pro');
 const west=await locations.createLocation(db,ctx,{name:'West warehouse',kind:'warehouse'});
 const bin=await locations.createLocation(db,ctx,{name:'Receiving bin',kind:'bin',parentLocationId:west.id});
 const incoming=await custody.create(db,ctx,{kind:'CONSIGN_IN',supplierId:'fixture-supplier',inspectionParentLocationId:f.location.id,
  startDate:today,dueDate:today,requestKey:randomUUID(),lines:[{skuId,quantity:4,unitPriceMinor:900,unitCostMinor:175}]});
 await custody.operate(db,ctx,incoming.id,'receive_consigned',{confirmed:'yes',requestKey:randomUUID(),lineId:incoming.lines[0].id,quantity:4});
 const transfer=await transfers.request(db,ctx,{fromLocationId:f.location.id,toLocationId:bin.id,expectedArrivalDate:today,
  idempotencyKey:randomUUID(),lines:[{skuId,quantity:3}]});
 for(const stage of ['approve','pick','dispatch','markInTransit']){
  await transfers[stage](db,ctx,transfer.id,{idempotencyKey:randomUUID()});
 }
 const inTransit=await transfers.get(db,ctx.workspaceId,transfer.id);
 await transfers.receive(db,ctx,transfer.id,{idempotencyKey:randomUUID(),lines:[{lineId:inTransit.lines[0].id,received:1}]});
 const measured=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{
  name:'Catch-weight cartons',baseCode:'LOC-WEIGHT',trackingMode:'quantity',unitLabel:'piece',
  secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'});
 for(const [locationId,quantity,secondaryQuantity] of [[f.location.id,2,'5.125'],[bin.id,1,'4.250']]){
  await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:measured.skuIds[0],locationId,quantity,
   secondaryQuantity,unitCost:'4',idempotencyKey:randomUUID()});
 }
 const service={resolveSku:async()=>{throw Error('Expected the native location answer for an exact SKU');}};
 for(const plan of ['starter','growth','pro','enterprise']){
  await f.subscribe(plan);
  const answer=await direct.run(service,db,ctx,'How many units of '+code+' are on hand across all our locations?');
  assert.equal(answer.result.status,'ANSWERED');
  assert.match(answer.result.answer,/8 units on hand/);
  assert.match(answer.result.answer,/Dispatch: 7/);
  assert.match(answer.result.answer,/West warehouse \/ Receiving bin: 1/);
  assert.match(answer.result.answer,/in transit to West warehouse \/ Receiving bin: 2/);
  assert.deepEqual(answer.result.rows.filter(r=>r.onHand>0).map(r=>[r.holding,r.onHand]).sort(),
   [['In transit',2],['On hand',1],['On hand',7],['Supplier-owned consignment',4]]);
  assert.equal(answer.result.extent.complete,true);
  assert.equal(answer.provenance.modelCalls,0);
  const weights=await direct.run(service,db,ctx,'Show stock for LOC-WEIGHT across all warehouses');
  assert.deepEqual(weights.result.rows.map(r=>[r.onHand,Number(r.measured.split(' ')[0])]),[[2,5.125],[1,4.25]]);
  assert(weights.result.columns.includes('measured'));
 }
 await transfers.receive(db,ctx,transfer.id,{idempotencyKey:randomUUID(),lines:[{lineId:inTransit.lines[0].id,received:2}]});
 const answer=await direct.run(service,db,ctx,'Show stock for '+code+' across every location');
 assert.match(answer.result.answer,/10 units on hand/);
 assert.equal(answer.result.rows.some(row=>row.holding==='In transit'),false);
});
