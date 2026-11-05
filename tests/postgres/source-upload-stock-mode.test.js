'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('native saved uploads retain an explicit additional-stock mode through approval and execution',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,uploads=require('../../src/imports/postgres-source-uploads'),jobs=require('../../src/operations/postgres-job-queue'),imports=require('../../src/imports/postgres-service'),handlers=require('../../src/operations/postgres-runtime-handlers').create({});
 const sku=(await db.query('SELECT s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2',[ctx.workspaceId,f.item.skuIds[0]])).rows[0],text=`Product,SKU,Location,Quantity,Unit cost\n${sku.name},${sku.code},${f.location.name},1,1.00`,input={text,filename:'Additional stock.csv',requestKey:'source-stock-add-mode',allowModel:false,importMode:'add'};
 await assert.rejects(uploads.enqueue(db,ctx,{...input,importMode:'delete'}),/Choose whether/);
 const first=await uploads.enqueue(db,ctx,input);assert.equal((await uploads.enqueue(db,ctx,input)).id,first.id);
 await assert.rejects(uploads.enqueue(db,ctx,{...input,importMode:'set'}),/another file or set of choices/);
 const analysed=await jobs.processOne(db,{'import.analyse-source':handlers['import.analyse-source']},{owner:'source-mode-fixture'});assert.equal(analysed.status,'COMPLETED',JSON.stringify(analysed.lastError));
 const plan=await imports.get(db,ctx.workspaceId,analysed.result.planId);assert.equal(plan.transformations.importMode,'add');assert.equal(plan.recordsInvalid,0);assert.equal(plan.recordsValid,1);
 await imports.approveAndQueue(db,ctx,plan.id,plan.integrityHash);
 const executed=await jobs.processOne(db,{'import.execute-approved':handlers['import.execute-approved']},{owner:'stock-mode-fixture'});assert.equal(executed.status,'COMPLETED',JSON.stringify(executed.lastError));assert.equal(executed.result.verified,true);
 assert.equal(await f.balance(),5,'Additional receipt must add one unit to four, rather than set stock to one');
 assert.equal(Number((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],f.location.id])).rows[0].total_cost_minor),500);
});
