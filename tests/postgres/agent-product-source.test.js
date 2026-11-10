'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/product-source-fixture');
test('exact measurement migration preserves earlier catalog, parcel and inventory records',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{through:'327-supplier-economic-comparison.sql'});
 const {db,ctx}=f,sku=f.item.skuIds[0];
 await db.query('UPDATE skus SET weight_grams=125,length_mm=250,width_mm=127,height_mm=40 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,sku]);
 const parcel=await f.parcel();
 const checksums=async()=>(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
 const recorded=async()=>(await db.query('SELECT weight_grams::text,length_mm::text,width_mm::text,height_mm::text FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,sku])).rows[0];
 const before=await checksums(),product=await recorded(),packages=await f.shipping.packagesFor(db,ctx.workspaceId,parcel.shipmentId),onHand=await f.balance();
 const migrate=require('../../src/db/migrate-postgres').migratePostgres;
 assert.deepEqual(await migrate(db,{through:'328-native-supplier-measurement-precision.sql'}),['328-native-supplier-measurement-precision.sql']);
 assert.deepEqual((await checksums()).filter(row=>row.name!=='328-native-supplier-measurement-precision.sql'),before);
 assert.deepEqual(await recorded(),product);assert.deepEqual(await f.shipping.packagesFor(db,ctx.workspaceId,parcel.shipmentId),packages);
 assert.equal(await f.balance(),onHand);assert.deepEqual(await migrate(db,{through:'328-native-supplier-measurement-precision.sql'}),[]);
});
test('Growth reads more than ten full sourced facts, saves native product evidence after exact approval and enriches missing fields with one document receipt',{timeout:240000},async t=>{
 const f=await fixture(t);await f.subscribe('growth');
 const facts=[f.fact('manufacturer','Acme Tooling'),f.fact('composition','Aluminium'),f.fact('mass','12.5','g',{perUnit:'unit'}),f.fact('length','25','cm'),f.fact('width','5','in'),f.fact('height','0.25','mm'),f.fact('barcode','012345678905'),...['hazards','ppe','first_aid','fire','spill','handling','storage','disposal','transport','exposure','stability','toxicology','ecology','revision','origin','voltage','power'].map((kind,i)=>f.fact(kind,'Source fact '+i))];f.setFacts(facts);
 const r=await f.start({enrich:'yes'}),p=await f.process(r.id);assert.equal(p.job.status,'COMPLETED',JSON.stringify(p.job.lastError));assert.equal(p.view.record.status,'READY');assert.equal(p.view.record.raw_facts.length,facts.length);assert.equal(p.view.record.credits_used,100);assert.equal(p.view.record.documents_used,1);assert.equal((await f.service.forItem(f.db,f.ctx,f.item.itemId)).length,0);
 await f.db.query("UPDATE stockchief_runtime.agent_product_source_readings SET content=content||'changed'::bytea WHERE id=$1",[r.id]);await assert.rejects(f.approve(r.id),/integrity/);await f.db.query('UPDATE stockchief_runtime.agent_product_source_readings SET content=$2 WHERE id=$1',[r.id,f.source()]);
 const saved=await f.approve(r.id);assert.equal(saved.savedFacts,facts.length);assert.equal(saved.nativeFields,5);assert.equal((await f.approve(r.id)).replayed,true);
 const actual=(await f.db.query('SELECT barcode,weight_grams,length_mm,width_mm,height_mm FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0];assert.deepEqual(actual,{barcode:'012345678905',weight_grams:'12.5',length_mm:'250',width_mm:'127',height_mm:'0.25'});
 const order=await f.workflows.createSalesOrder(f.db,f.ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',
   fulfillmentLocationId:f.location.id,idempotencyKey:'exact-product-weight-order',lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:1200}]});
 await f.workflows.confirmSalesOrder(f.db,f.ctx,order.salesOrderId,{idempotencyKey:'exact-product-weight-confirm'});
 const shipment=await f.shipping.prepare(f.db,f.ctx,order.salesOrderId,{idempotencyKey:'exact-product-weight-prepare',
   lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:3}]});
 const estimated=(await f.shipping.packagesFor(f.db,f.ctx.workspaceId,shipment.shipmentId))[0];
 assert.equal(estimated.weightGrams,'37.5');assert.equal(estimated.estimated,true);
 await f.shipping.setPackages(f.db,f.ctx,shipment.shipmentId,[{weightGrams:'37.625',lengthMm:'250.25',widthMm:'127.25',heightMm:'20.5'}]);
 const measured=(await f.shipping.packagesFor(f.db,f.ctx.workspaceId,shipment.shipmentId))[0];
 assert.deepEqual([measured.weightGrams,measured.lengthMm,measured.widthMm,measured.heightMm,measured.estimated],['37.625','250.25','127.25','20.5',false]);
 const page=await f.browser.get('/inventory/'+f.item.itemId).expect(200);assert.match(page.text,/Source-backed product facts/);assert.match(page.text,/Acme Tooling/);assert.match(await f.service.csv(f.db,f.ctx,r.id),/012345678905/);assert.equal(await f.balance(),20);
 const repeat=await f.start({enrich:'yes'});assert.equal(repeat.replayed,true);assert.equal(f.calls(),2);
 const usage=(await f.db.query("SELECT meter,sum(units)::int AS n FROM commercial_usage_events WHERE workspace_id=$1 AND status='COMMITTED' GROUP BY meter",[f.ctx.workspaceId])).rows;assert.equal(usage.find(e=>e.meter==='agent_documents').n,1);assert.equal(usage.find(e=>e.meter==='ai_work_credits').n,100);
});
test('Pro and funded Custom save proven exact facts without training while conflicting, packaging and uncertain values stay held',{timeout:240000},async t=>{
 const f=await fixture(t);f.setFacts([f.fact('manufacturer','Verified maker'),f.fact('mass','1','kg'),f.fact('mass','2','kg'),f.fact('length','2','in'),f.fact('width','300','mm',{basis:'carton'}),f.fact('barcode','012345678906'),f.fact('handling','Unclear hand-written gloves','',{uncertain:true})]);
 const r=await f.start({automatic:'yes',enrich:'yes'}),p=await f.process(r.id);assert.equal(p.job.status,'COMPLETED',JSON.stringify(p.job.lastError));assert.equal(p.view.record.status,'SAVED');assert(p.view.view.rows.filter(r=>r.problem).length>=3);
 const actual=(await f.db.query('SELECT weight_grams,length_mm,width_mm,barcode FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0];assert.deepEqual(actual,{weight_grams:null,length_mm:'50.8',width_mm:null,barcode:null});assert.equal((await f.service.forItem(f.db,f.ctx,f.item.itemId)).some(r=>r.fact.kind==='handling'),false);
 const held=p.view.view.rows.find(r=>r.kind==='handling');await f.approve(r.id,{confirmedFacts:[held.id]});assert((await f.service.forItem(f.db,f.ctx,f.item.itemId)).some(r=>r.fact.kind==='handling'));
 await f.subscribe('enterprise');await f.db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('source-custom-credits',$1,'ai_work_credits',10000,'Synthetic agreed Custom source-reading allowance')",[f.owner.accountId]);f.setFacts([f.fact('storage','Keep dry')]);const custom=await f.start({automatic:'yes',filename:'Custom source.txt'});assert.equal((await f.process(custom.id)).view.record.status,'SAVED');
});
test('provider failure refunds the complete new reading, while source/identity/downgrade/disabled checks stop queued work before a new call',{timeout:240000},async t=>{
 const f=await fixture(t);f.setFacts([f.fact('composition','Cotton')]);f.failAt(2);const r=await f.start(),p=await f.process(r.id);assert.equal(p.job.status,'DEAD');assert.equal(p.view.record.status,'FAILED');
 const events=async()=>(await f.db.query("SELECT status FROM commercial_usage_events WHERE workspace_id=$1 AND meter IN('agent_documents','ai_work_credits')",[f.ctx.workspaceId])).rows;assert((await events()).every(e=>e.status==='REVERSED'));assert.equal((await f.service.forItem(f.db,f.ctx,f.item.itemId)).length,0);assert(Number((await f.db.query('SELECT sum(amount_minor) AS n FROM commercial_cost_events WHERE workspace_id=$1',[f.ctx.workspaceId])).rows[0].n)>0);
 f.failAt(null);const retry=await f.start();await f.subscribe('starter');const before=f.calls();const processed=await require('../../src/operations/postgres-job-queue').processOne(f.db,{[f.service.kind]:require('../../src/operations/postgres-runtime-handlers').create(undefined,{productSourceProvider:f.provider})[f.service.kind]},{owner:'downgraded-source-worker'});assert.equal(processed.status,'PAUSED');assert.equal(f.calls(),before);assert((await events()).every(e=>e.status==='REVERSED'));await assert.rejects(f.start(),/Growth/);
});
