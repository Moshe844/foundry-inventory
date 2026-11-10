'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('only actual automatic release drafts count as measured administration; replay, previews, manual examples and cancelled orders cannot inflate it',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-blanket-release-fixture').fixture(t),{db,ctx,service:s}=f,p=await f.contract(),roi=require('../../src/autopilot/time-saved'),digest=require('../../src/autopilot/agent-work-digest'),projection=require('../../src/projections/postgres-service');
 const row=async()=>(await roi.report(db,ctx)).rows.find(r=>r.key==='blanket-release'),pending=async()=>(await projection.needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>n.sourceId==='blanket-contracts');
 assert.equal((await row()).count,0);
 const example=await s.manual(db,ctx,p.slots[0].id,{confirmed:'yes'});await f.workflows.approvePurchaseOrder(db,ctx,example.purchaseOrderId,{idempotencyKey:randomUUID()});await s.teach(db,ctx,p.slots[0].id,{confirmed:'yes'});await s.configure(db,ctx,p.id,{revision:2,confirmed:'yes'});
 assert.equal((await row()).count,0);assert.equal((await pending()).length,0);
 const created=await s.onContract(db,ctx.workspaceId,p.id);assert(created.purchaseOrderId);assert.equal((await s.onContract(db,ctx.workspaceId,p.id)).notDue,true);
 assert.equal((await row()).count,1);assert.equal((await row()).minutes,null);assert.equal((await pending()).length,1);assert.match((await pending())[0].title,/REVIEWED-CONTRACT-1/);
 await roi.sample(db,ctx,{activity:'blanket-release',manualMinutes:'12',reviewMinutes:'3',requestKey:randomUUID()});assert.equal((await row()).minutes,9);
 const work=(await digest.report(db,ctx)).rows.filter(r=>r.link==='/autopilot/blanket-releases/'+p.id);assert.equal(work.length,1);assert.match(work[0].Action,/Unapproved supplier release/);
 await f.workflows.cancelPurchaseOrder(db,ctx,created.purchaseOrderId,{idempotencyKey:randomUUID(),reason:'Owner cancelled this unplaced synthetic release'});assert.equal((await row()).count,0);assert.equal((await pending()).length,0);assert.equal((await digest.report(db,ctx)).rows.filter(r=>r.link==='/autopilot/blanket-releases/'+p.id).length,0);
});
test('reviewed schedules preserve dates and source facts rather than truncating, rounding or guessing missing terms',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-blanket-release-fixture').fixture(t),{db,ctx,service:s}=f;
 await assert.rejects(s.preview(db,ctx,{...f.input,firstRelease:'2026-02-30'}),/real calendar date/);
 await assert.rejects(f.contract({firstRelease:f.today,lastRelease:f.today}),/full contract quantity/);
 await assert.rejects(f.contract({firstRelease:f.today,lastRelease:f.add(f.today,100),intervalDays:1,lines:[{sku:f.sku,totalUnits:100,releaseUnits:1,unitPrice:'1.00'}]}),/52 releases/);
 const original=await s.preview(db,ctx,f.input);await require('../../src/pricing/postgres-service').setPurchaseCost(db,ctx,{skuId:f.item.skuIds[0],amount:'1.10',currency:'USD'});
 await assert.rejects(s.save(db,ctx,{...f.input,sourceHash:original.sourceHash,confirmed:'yes'}),/purchase-price basis/);
 assert.equal((await s.screen(db,ctx)).rows.length,0);
 const args={reference:'Case-Exact-52',firstRelease:f.today,lastRelease:f.add(f.today,357),intervalDays:7,lines:[{sku:f.sku,totalUnits:52,releaseUnits:1,unitPrice:'1.10'}]},full=await f.contract(args);assert.equal(full.slots.length,52);assert.equal(full.slots.at(-1).release_date,f.add(f.today,357));assert.equal((await s.get(db,ctx,full.id)).reference,'Case-Exact-52');await assert.rejects(f.contract({...args,reference:'case-exact-52'}),/already exists/);
});
