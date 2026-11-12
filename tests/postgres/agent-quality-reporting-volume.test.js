'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-quality-fixture');
test('a native 100-line receipt checks the shared allowance once and reports only actual automatic QC work', {timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,{...f.scope,maxUnits:100});await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const savings=require('../../src/autopilot/time-saved');assert.equal((await savings.report(db,ctx)).rows.find(r=>r.key==='delivery-qc').count,0);
 const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:f.scope.supplierId,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:Array.from({length:100},()=>({skuId:f.scope.skuId,quantityUnits:1,unitCost:1}))});await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 let probes=0;const measured={...db,transaction:(fn,options)=>db.transaction(c=>fn({...c,query:(sql,args)=>{if(sql.includes('agent_instruction_rule_targets'))probes++;return c.query(sql,args);}}),options)},input={idempotencyKey:randomUUID(),lines:po.lineIds.map(lineId=>({lineId,quantity:1,locationId:f.location.id}))};
 const receipt=await f.workflows.receivePurchaseOrder(measured,ctx,po.purchaseOrderId,input);assert.equal(receipt.qualityHoldIds.length,100);assert.equal(probes,1);assert.equal(await f.balance(),108);assert.equal((await f.available()).available,8);
 assert.equal((await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,input)).replayed,true);let row=(await savings.report(db,ctx)).rows.find(r=>r.key==='delivery-qc');assert.equal(row.count,100);assert.equal(row.minutes,null);
 await savings.sample(db,ctx,{activity:'delivery-qc',manualMinutes:'2',reviewMinutes:'1',requestKey:randomUUID()});row=(await savings.report(db,ctx)).rows.find(r=>r.key==='delivery-qc');assert.equal(row.minutes,100,'Only the explicit synthetic owner timing sample supplies minutes');
 const clock=await require('../../src/lib/business-time').forWorkspace(db,ctx.workspaceId),history=await require('../../src/autopilot/agent-work-digest').report(db,ctx,{filter:clock.calendarDate});assert.equal(history.rows.filter(r=>r.link.startsWith('/autopilot/delivery-quality/')).length,100);assert.equal(history.undoForm.entries.length,0);
 assert.equal((await quality.inbox(db,ctx.workspaceId,ctx.actorId)).length,50,'The QC inbox read stays bounded');
});
test('splitting one product across receipt lines cannot exceed the owner unit limit', {timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:f.scope.supplierId,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.scope.skuId,quantityUnits:6,unitCost:1},{skuId:f.scope.skuId,quantityUnits:6,unitCost:1}]});await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 const input={idempotencyKey:randomUUID(),lines:po.lineIds.map(lineId=>({lineId,quantity:6,locationId:f.location.id}))};const suggested=await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,input);
 assert.equal(suggested.qualityHoldIds,undefined);assert.equal(suggested.qualitySuggestionIds.length,2);assert.equal((await f.available()).available,20);
 for(const id of suggested.qualitySuggestionIds){assert.match((await f.hold(id)).proposal_reason,/10-unit limit/);await quality.decide(db,ctx,id,{revision:1,decision:'hold'});assert.equal((await f.hold(id)).automatic,false);}
 assert.equal((await f.available()).available,8);
});
