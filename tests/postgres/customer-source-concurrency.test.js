'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('source review, units, currency, updates, transfer availability and stale edits use canonical PostgreSQL rules',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),imports=require('../../src/imports/postgres-service'),catalog=require('../../src/domain/postgres-catalog-service'),locations=require('../../src/domain/postgres-location-service'),transfers=require('../../src/transfers/postgres-transfer-service');
 const owner=await auth.createBusiness(db,{name:'Owner',businessName:'Shared source rules',email:randomUUID()+'@example.test',password:'Test!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const room=await locations.createLocation(db,ctx,{name:'Counted stock',kind:'warehouse'}),other=await locations.createLocation(db,ctx,{name:'Display stock',kind:'store'});
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{currency:'USD',startDate:'2026-01-01'});
 let plan=await imports.analyse(db,ctx,{text:'SKU,Product name,Qty,Unit,Unit price\nUT-7,Curved knife,7,knives,4.25\nUT-9,Soft shirt,9,shirts,6.75\n,Grand total,16,,\n,סה״כ פריטים,16,,\n,Summary of inspection ✓,,,',defaultLocationId:room.id,allowModel:false});
 assert.equal(plan.recordsValid,2);assert.equal(plan.recordsInvalid,2);assert.equal((await imports.counts(db,ctx.workspaceId,plan.id)).EXCLUDED,1);
 await assert.rejects(imports.approve(db,ctx,plan.id,plan.integrityHash),/correct|partial|review/i);
 const rows=await imports.rowsFor(db,ctx.workspaceId,plan.id),uncertain=rows.filter(r=>r.parsed.documentEvidence?.kind==='uncertain');
 plan=await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,documentRowRoles:Object.fromEntries(uncertain.map(r=>[r.rowNumber,'document']))});
 assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);assert((await imports.execute(db,ctx,plan.id)).verified);
 const knife=(await db.query('SELECT s.id sku_id,i.* FROM items i JOIN skus s ON s.item_id=i.id WHERE i.workspace_id=$1 AND s.code=$2',[ctx.workspaceId,'UT-7'])).rows[0];assert.equal(knife.unit_label,'knives');assert.equal((await db.query('SELECT sum(on_hand)::int n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,16);
 const before=require('../../src/domain/catalog-identity').detailsVersion(knife);
 const edit={name:'Curved safety knife',baseCode:'UT-7',unitLabel:'knives',description:'Reviewed',expectedDetailsVersion:before};
 await catalog.updateItem(db,ctx,knife.id,edit);await assert.rejects(catalog.updateItem(db,ctx,knife.id,{...edit,name:'Stale tab overwrite'}),/changed after you opened/);
 let update=await imports.analyse(db,ctx,{text:'SKU,Product name,Qty,Selling price,Unit\nUT-7,Updated curved knife,7,5.25,knives\nNEW-4,Fresh clamp,3,2.25,clamps',defaultLocationId:room.id,allowModel:false});update=await imports.revise(db,ctx,update.id,{expectedHash:update.integrityHash,importMode:'set'});await imports.approve(db,ctx,update.id,update.integrityHash);const run=await imports.execute(db,ctx,update.id);assert.equal(run.itemsCreated,1);assert.equal(run.itemsUpdated,1);assert.equal((await imports.report(db,ctx.workspaceId,update.id)).itemsUpdated,1);
 const foreign=await imports.analyse(db,ctx,{text:'SKU,Product name,Qty,Unit price (₪)\nIL-4,Ceramic bowl,0,₪8.50',allowModel:false});assert.equal(foreign.fieldMappings.sellingPrice,3);const bad=(await imports.rowsFor(db,ctx.workspaceId,foreign.id))[0];assert.equal(bad.status,'INVALID');assert.equal(bad.problems.filter(p=>p.code==='cost_currency_mismatch').length,1);assert.match(bad.problems.find(p=>p.code==='cost_currency_mismatch').message,/ILS.*USD/);
 const request={fromLocationId:room.id,toLocationId:other.id,lines:[{skuId:knife.sku_id,quantity:2}],idempotencyKey:randomUUID()};const held=await transfers.request(db,ctx,request);assert((await transfers.request(db,ctx,request)).replayed);
 assert.equal((await transfers.sourceAvailable(db,ctx.workspaceId,knife.sku_id,room.id)).available,5);
 await assert.rejects(transfers.request(db,ctx,{...request,idempotencyKey:randomUUID(),lines:[{skuId:knife.sku_id,quantity:6}]}),/5 available/);
 assert.equal((await db.query('SELECT count(*)::int n FROM inventory_transfers WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
 await transfers.cancel(db,ctx,held.id,{idempotencyKey:randomUUID()});assert.equal((await transfers.sourceAvailable(db,ctx.workspaceId,knife.sku_id,room.id)).available,7);
});

test('two worker claimers serialize imports per inventory while other inventories proceed and manual catalog writes fail clearly',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),imports=require('../../src/imports/postgres-service'),jobs=require('../../src/operations/postgres-job-queue'),catalog=require('../../src/domain/postgres-catalog-service');
 const owner=await auth.createBusiness(db,{name:'Owner',businessName:'Concurrent stock',email:randomUUID()+'@example.test',password:'Test!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Depot',kind:'warehouse'});
 const first=await imports.analyse(db,ctx,{text:'SKU,Product,Qty,Location\nQ-7,First widget,3,Depot',allowModel:false}),second=await imports.analyse(db,ctx,{text:'SKU,Product,Qty,Location\nQ-9,Second widget,4,Depot',allowModel:false});
 for(const plan of [first,second]){await imports.approve(db,ctx,plan.id,plan.integrityHash);await imports.queueExecution(db,ctx,plan.id,plan.integrityHash);}
 const claimed=await Promise.all([jobs.claim(db,{owner:'worker-a',kinds:['import.execute-approved']}),jobs.claim(db,{owner:'worker-b',kinds:['import.execute-approved']})]);assert.equal(claimed.filter(Boolean).length,1);
 const active=claimed.find(Boolean);assert.equal(await jobs.claim(db,{owner:'worker-c',kinds:['import.execute-approved']}),null);
 const progress=await require('../../src/imports/postgres-progress').get(db,ctx.workspaceId,active.payload.planId===first.id?second.id:first.id);assert.equal(progress.state,'QUEUED');assert.match(progress.stageLabel,/running import in this inventory/);
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const executor=imports.execute(db,ctx,active.payload.planId,{beforeRow:async()=>{entered();await gate;}});
 await ready;try{await assert.rejects(catalog.createItem(db,ctx,{name:'Manual item while importing',baseCode:'MANUAL-4',trackingMode:'quantity'}),e=>e.code==='validation_error'&&e.details.reason==='catalog_busy');}finally{release();}
 assert((await executor).verified);await jobs.complete(db,active.id,active.leaseToken,{verified:true});
 const next=await jobs.claim(db,{owner:'worker-d',kinds:['import.execute-approved']});assert(next);assert((await imports.execute(db,ctx,next.payload.planId)).verified);await jobs.complete(db,next.id,next.leaseToken,{verified:true});
 const manual=await catalog.createItem(db,ctx,{name:'Manual item after importing',baseCode:'MANUAL-4',trackingMode:'quantity'});assert(manual.itemId);
 assert.equal((await db.query('SELECT sum(on_hand)::int n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,7);
 const another=await auth.createBusiness(db,{name:'Other',businessName:'Other inventory',email:randomUUID()+'@example.test',password:'Test!'+randomUUID()});
 await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind:'import.execute-approved',payload:{},idempotencyKey:randomUUID()});await jobs.enqueue(db,{workspaceId:another.workspaceId,kind:'import.execute-approved',payload:{},idempotencyKey:randomUUID()});
 assert.equal((await Promise.all([jobs.claim(db,{owner:'x',kinds:['import.execute-approved']}),jobs.claim(db,{owner:'y',kinds:['import.execute-approved']})])).filter(Boolean).length,2);
});
