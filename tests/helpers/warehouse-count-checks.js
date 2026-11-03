'use strict';const assert=require('node:assert/strict');
async function check(t,{db,ctx,locations},{category='',large=false}={}){
 const counts=require('../../src/operations/postgres-count-campaigns'),created=await counts.create(db,ctx,{locationId:locations[0].id,category,title:'Warehouse qualification count'});
 let page=await counts.page(db,ctx,created.id);assert(page.totals.positions>=(large?1000:1));if(large)assert(page.next,'Large worksheet must paginate');
 await assert.rejects(counts.page(db,{...ctx,workspaceId:'another-inventory'},created.id),/membership|permission|not in/);
 await assert.rejects(counts.approve(db,ctx,created.id,page.campaign.revision),/still need a count/);
 const first=page.rows[0],before=Number(first.before_quantity);let afterLocation='',afterSku='';
 do{
  page=await counts.page(db,ctx,created.id,{afterLocation,afterSku});
  await counts.save(db,ctx,created.id,{revision:page.campaign.revision,lines:page.rows.map(l=>({skuId:l.sku_id,locationId:l.location_id,quantity:l.sku_id===first.sku_id&&l.location_id===first.location_id?before-1:l.before_quantity}))});
  if(!page.next)break;afterLocation=page.next.location_id;afterSku=page.next.sku_id;
 }while(true);
 page=await counts.page(db,ctx,created.id);assert.equal(page.totals.uncounted,0);assert.equal(page.totals.variances,1);assert.equal(Number(page.rows[0].cost_delta_minor),-Number(first.before_value)/before);
 await assert.rejects(counts.save(db,ctx,created.id,{revision:1,lines:[{skuId:first.sku_id,locationId:first.location_id,quantity:0}]}),/changed/);
 await counts.approve(db,ctx,created.id,page.campaign.revision);assert((await counts.approve(db,ctx,created.id,page.campaign.revision)).replayed);
 let runs=0;do{await counts.run({workspaceId:ctx.workspaceId,payload:{campaignId:created.id,actorId:ctx.actorId}},db);page=await counts.page(db,ctx,created.id);assert(++runs<2000);}while(page.campaign.status==='APPLYING');
 assert.equal(page.campaign.status,'COMPLETED');assert.equal(page.totals.applied,page.totals.positions);
 assert.equal(Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,first.sku_id,first.location_id])).rows[0].on_hand),before-1);
 assert.equal((await counts.run({workspaceId:ctx.workspaceId,payload:{campaignId:created.id,actorId:ctx.actorId}},db)).status,'COMPLETED');
 // Concurrent stock changes must stop before applying an out-of-date count.
 const stale=await counts.create(db,ctx,{locationId:locations[0].id,category,title:'Stale worksheet guard'});let stalePage=await counts.page(db,ctx,stale.id);
 const line=stalePage.rows[0];await counts.save(db,ctx,stale.id,{revision:1,lines:[{skuId:line.sku_id,locationId:line.location_id,quantity:line.before_quantity}]});
 if(!large){
  await counts.approve(db,ctx,stale.id,2);await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:line.sku_id,locationId:line.location_id,quantity:1,unitCost:1,idempotencyKey:'count-concurrent-receipt'});
  assert.equal((await counts.run({workspaceId:ctx.workspaceId,payload:{campaignId:stale.id,actorId:ctx.actorId}},db)).status,'REVIEW_REQUIRED');
  stalePage=await counts.page(db,ctx,stale.id);assert.match(stalePage.campaign.problem,/Stock or cost changed/);assert.equal(stalePage.totals.applied,0);
 }
 return {positions:page.totals.positions,batches:runs};
}module.exports={check};
