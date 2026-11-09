'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('every current plan preserves supplier-owned goods under an actual physical site during product deletion',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;await f.subscribe('growth');
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),custody=require('../../src/custody/postgres-service'),removal=require('../../src/domain/postgres-record-removal');
 const agreement=await custody.create(db,ctx,{kind:'CONSIGN_IN',supplierId:'fixture-supplier',inspectionParentLocationId:f.location.id,startDate:today,dueDate:today,requestKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:2,unitCostMinor:150,unitPriceMinor:200}]});
 await custody.operate(db,ctx,agreement.id,'receive_consigned',{confirmed:'yes',requestKey:randomUUID(),lineId:agreement.lines[0].id,quantity:2});
 assert.equal((await db.query('SELECT parent_location_id FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,agreement.external_location_id])).rows[0].parent_location_id,f.location.id);
 const before=await f.balance();for(const tier of ['starter','growth','pro','enterprise']){await f.subscribe(tier);const preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId);await assert.rejects(removal.remove(db,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash}),/consign|custody|agreement/i);assert.equal(await f.balance(),before);}
 assert.equal(Number((await custody.get(db,ctx,agreement.id)).lines[0].external_quantity),2);assert.equal(Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],agreement.external_location_id])).rows[0].on_hand),2);
});
