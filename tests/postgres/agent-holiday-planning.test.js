'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const inv=require('../../src/domain/postgres-inventory-engine'),catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce');

// Job 147: one holiday for several suppliers; Pro and Custom prepare the
// purchase draft on their own inside the owner's limit.
async function holiday(t){
 const f=await require('../helpers/agent-supplier-shutdown-fixture').fixture(t),{db,ctx}=f;
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('shenzhen-supplier',$1,'Shenzhen parts','active','USD',now()::text,now()::text)",[ctx.workspaceId]);
 async function product(code,supplierId,terms){
  const sku=(await catalog.createItem(db,ctx,{name:'Holiday '+code,baseCode:code,trackingMode:'quantity'})).skuIds[0];
  await inv.receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:4,idempotencyKey:randomUUID()});
  for(let i=0;i<2;i++)await inv.issue(db,ctx,{skuId:sku,locationId:f.location.id,quantity:2,reasonCode:'sold',idempotencyKey:randomUUID()});
  await commerce.linkSupplierItem(db,ctx,{supplierId,skuId:sku,purchaseUnit:'pack',unitsPerPurchaseUnit:6,lastUnitCost:2,minimumOrderQuantity:1,orderMultiple:1,isPreferred:true,...terms});
  return sku;
 }
 const lantern=await product('LANTERN-'+randomUUID().slice(0,6),'shenzhen-supplier');
 const untermed=await product('NOTERMS-'+randomUUID().slice(0,6),'fixture-supplier');
 await db.query('UPDATE supplier_items SET last_unit_cost=NULL WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,untermed]);
 const names={supplierName:'Fixture parts\nShenzhen parts',locationName:f.location.name,skuCodes:''};
 const holidayInput={...names,reference:'Chinese New Year '+randomUUID().slice(0,8),lastOrderDate:f.input.lastOrderDate,closedFrom:f.input.closedFrom,closedThrough:f.input.closedThrough,nextArrivalDate:f.input.nextArrivalDate,extraCoverDays:'0'};
 const count=async(sql,args=[ctx.workspaceId])=>(await db.query(sql,args)).rows[0].n;
 const purchases=()=>count('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1');
 const queue=require('../../src/operations/postgres-job-queue'),handler=require('../../src/operations/postgres-runtime-handlers').create()[f.service.jobKind];
 const work=owner=>queue.processOne(db,{[f.service.jobKind]:handler},{owner});
 const audits=action=>count('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action]);
 return {...f,lantern,untermed,holidayInput,purchases,work,audits,count};
}

test('one holiday plans every supplier closing; Growth suggests, Pro and Custom prepare each purchase draft alone within the owner’s limit, with undo',{timeout:600000},async t=>{
 const f=await holiday(t),{db,ctx,service}=f;
 await f.subscribe('starter');await assert.rejects(service.preview(db,ctx,f.holidayInput),e=>e.code==='entitlement_required');
 // Growth: one suggestion per supplier; products needing terms are listed, not guessed.
 await f.subscribe('growth');
 const suggestion=await service.preview(db,ctx,f.holidayInput);
 assert.deepEqual(suggestion.drafts.map(d=>[d.supplier.name,d.scope.skuIds,d.calculated.totalMinor]),[['Fixture parts',[f.skuId],2400],['Shenzhen parts',[f.lantern],1200]]);
 assert.deepEqual(suggestion.notes.map(n=>[n.supplier,n.reason]),[['Fixture parts','Record its supplier pack, minimum, order multiple and cost first.']]);
 const plans=JSON.stringify(suggestion.drafts.map(d=>({supplierId:d.scope.supplierId,skuIds:d.scope.skuIds,sourceFingerprint:d.sourceFingerprint})));
 const common={locationId:f.location.id,reference:f.holidayInput.reference,lastOrderDate:f.input.lastOrderDate,closedFrom:f.input.closedFrom,closedThrough:f.input.closedThrough,nextArrivalDate:f.input.nextArrivalDate,extraCoverDays:'0',confirmed:'yes',plans};
 await assert.rejects(service.saveAll(db,ctx,common),e=>e.code==='entitlement_required');
 assert.equal(await f.count('SELECT count(*)::int n FROM stockchief_runtime.agent_supplier_shutdowns WHERE workspace_id=$1'),0);
 // Missing facts stop and ask.
 await assert.rejects(service.preview(db,ctx,{...f.holidayInput,supplierName:'Fixture parts\nNobody Ltd'}),/Nobody Ltd must match one active record/);
 await assert.rejects(service.preview(db,ctx,{...f.holidayInput,supplierName:'Shenzhen parts',skuCodes:'NO-SUCH'}),/Match each entered SKU/);

 // Pro: save both plans at once.
 await f.subscribe('pro');
 const saved=await service.saveAll(db,ctx,common);assert.equal(saved.length,2);
 assert.deepEqual((await service.saveAll(db,ctx,common)).map(s=>s.replayed),[true,true]);
 const fixturePlan=saved[0],page=async()=>service.page(db,ctx,fixturePlan.shutdownId);
 const enable=async(revision,maximumAmount)=>service.configure(db,ctx,fixturePlan.shutdownId,{revision,refreshDays:'1',maximumAmount,confirmed:'yes',sourceFingerprint:(await page()).fresh.sourceFingerprint});
 // Over the owner's limit: it waits in Needs you and no order is made.
 const before=await f.purchases();
 await enable(1,'23.99');
 let done=await f.work('shutdown-over-limit');assert.equal(done.status,'COMPLETED',JSON.stringify(done));assert.equal(done.result.held,true);assert.match(done.result.reason,/over your limit/);
 assert.equal(await f.purchases(),before);
 const needs=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 assert.ok(needs.some(n=>n.sourceId==='supplier-shutdown:'+fixturePlan.shutdownId&&/over your limit/.test(n.why)));
 // Within the limit: the worker prepares the one draft alone, logged, then stops.
 await enable(2,'24.00');
 done=await f.work('shutdown-within-limit');assert.equal(done.status,'COMPLETED',JSON.stringify(done));assert(done.result.purchaseOrderId);
 const po=(await db.query('SELECT p.status,l.quantity_units,l.quantity_purchase_units FROM purchase_orders p JOIN purchase_order_lines l ON l.purchase_order_id=p.id WHERE p.id=$1',[done.result.purchaseOrderId])).rows[0];
 assert.deepEqual([po.status,Number(po.quantity_units),Number(po.quantity_purchase_units)],['DRAFT',24,2]);
 assert.equal(await f.audits('Shutdown purchase draft prepared within the owner’s limit'),1);
 let shown=await page();assert.equal(shown.project.enabled,false);assert.equal(shown.draft.automatic,true);assert.equal(shown.draft.status,'DRAFT');
 // Replays add nothing.
 assert.equal((await service.onProject(db,ctx.workspaceId,fixturePlan.shutdownId)).stopped,true);
 assert.ok(!(await f.work('shutdown-replay')),'No job is left to replay');
 assert.equal(await f.purchases(),before+1);assert.equal(await f.balance(),0);
 // A second draft for the same shutdown needs the first one cancelled.
 await assert.rejects(enable(shown.project.revision,'24.00'),/already has its purchase draft/);
 // Undo cancels the unchanged draft, once.
 const undone=await service.undo(db,ctx,shown.draft.plan_id);assert.equal(undone.replayed,false);
 assert.equal((await service.undo(db,ctx,shown.draft.plan_id)).replayed,true);
 assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[done.result.purchaseOrderId])).rows[0].status,'CANCELLED');
 assert.equal(await f.audits('Shutdown purchase draft undone'),1);
 const history=await require('../../src/autopilot/agent-work-digest').report(db,ctx,{filter:f.recordedDay});
 assert.ok(history.rows.some(r=>r.link==='/autopilot/supplier-shutdowns/'+fixturePlan.shutdownId&&r.Status==='Undone'));

 // Custom does the same for the second supplier, without training.
 await f.subscribe('enterprise');
 const second=saved[1],secondFacts=suggestion.drafts[1];
 await service.configure(db,ctx,second.shutdownId,{revision:1,refreshDays:'1',maximumAmount:'12.00',confirmed:'yes',sourceFingerprint:secondFacts.sourceFingerprint});
 done=await f.work('shutdown-custom');assert.equal(done.status,'COMPLETED',JSON.stringify(done));assert(done.result.purchaseOrderId);
 assert.equal((await db.query('SELECT status,supplier_id FROM purchase_orders WHERE id=$1',[done.result.purchaseOrderId])).rows[0].supplier_id,'shenzhen-supplier');
 // A plan with no limit stays planning-only: no draft.
 await enable(shown.project.revision,'');
 done=await f.work('shutdown-plan-only');assert.equal(done.status,'COMPLETED',JSON.stringify(done));assert.equal(done.result.purchaseOrderId,undefined);
 assert.equal((await page()).project.enabled,true);
});

test('shutdown drafts wait for Ask me first, Watch only, a pause, shadow mode, a passed order date and a downgrade',{timeout:600000},async t=>{
 const f=await holiday(t),{db,ctx,service}=f,modes=require('../../src/autopilot/job-modes'),autonomy=require('../../src/autopilot/postgres-service');
 const p=await f.preview(),saved=await f.save(),before=await f.purchases();
 await service.configure(db,ctx,saved.shutdownId,{revision:1,refreshDays:'1',maximumAmount:'100.00',confirmed:'yes',sourceFingerprint:p.sourceFingerprint});
 const run=()=>service.onProject(db,ctx.workspaceId,saved.shutdownId);
 await modes.save(db,ctx,147,{mode:'ask',revision:0});assert.match((await run()).reason,/Ask me first/);
 // Ask me first: the owner prepares the reviewed draft herself.
 const manual=await service.purchase(db,ctx,saved.id,{confirmed:'yes',sourceFingerprint:p.sourceFingerprint});
 assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[manual.purchaseOrderId])).rows[0].status,'DRAFT');
 assert.equal(await f.audits('Reviewed shutdown purchase draft prepared'),1);
 await modes.save(db,ctx,147,{mode:'watch',revision:1});assert.match((await run()).reason,/Watch only/);
 await modes.save(db,ctx,147,{mode:'inherit',revision:2});
 await autonomy.pause(db,ctx,{role:'owner'},'Holiday check');assert.match((await run()).reason,/paused/i);await autonomy.resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.match((await run()).reason,/14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await f.subscribe('growth');assert.equal((await run()).held,true);await f.subscribe('pro');
 assert.equal(await f.purchases(),before+1,'Only the owner’s own reviewed draft was made');
 // The last order date has passed: it asks for a new arrangement instead of ordering.
 const dates=require('../../src/accounting/customer-money'),late={...f.input,reference:'Late notice '+randomUUID(),lastOrderDate:dates.addDays(f.today,-1)};
 const lateFacts=await f.source.facts(db,ctx,late);assert.match(lateFacts.warnings.map(w=>w.reason).join(' '),/last order date has passed/);
 const lateSaved=await service.save(db,ctx,{...late,confirmed:'yes',sourceFingerprint:lateFacts.sourceFingerprint});
 await service.configure(db,ctx,saved.shutdownId,{revision:(await service.page(db,ctx,saved.shutdownId)).project.revision,stop:'yes'});
 await service.configure(db,ctx,lateSaved.shutdownId,{revision:1,refreshDays:'1',maximumAmount:'100.00',confirmed:'yes',sourceFingerprint:lateFacts.sourceFingerprint});
 const held=await service.onProject(db,ctx.workspaceId,lateSaved.shutdownId);assert.equal(held.held,true);assert.match(held.reason,/last order date has passed/);
 assert.equal(await f.purchases(),before+1);
});

test('phone and desktop: one holiday for two suppliers is reviewed and saved together, and an agent draft can be undone',{timeout:600000},async t=>{
 const f=await holiday(t),{db,ctx}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port,flat=tab=>tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
 for(const [i,viewport] of [{width:390,height:844},{width:1440,height:900}].entries()){
  const tab=await browser.newPage({viewport,...(viewport.width<500?{isMobile:true,hasTouch:true}:{})});tab.setDefaultTimeout(12000);
  await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await tab.goto(origin+'/autopilot/supplier-shutdowns');
  const reference=f.holidayInput.reference+' '+i;
  await tab.locator('[name=supplierName]').fill('Fixture parts\nShenzhen parts');await tab.locator('[name=locationName]').fill(f.location.name);await tab.locator('[name=reference]').fill(reference);
  for(const key of ['lastOrderDate','closedFrom','closedThrough','nextArrivalDate','extraCoverDays'])await tab.locator('[name='+key+']').fill(f.holidayInput[key]);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Review shutdown stock suggestion',exact:true}).click()]);
  const text=await tab.locator('main').innerText();assert.match(text,/Shenzhen parts/);assert.match(text,/\$12\.00/);assert.match(text,/\$24\.00/);assert.match(text,/Not planned/);
  assert.ok(await flat(tab),'No sideways scrolling at '+viewport.width+' px');
  await tab.locator('form[action="/autopilot/supplier-shutdowns"] [name=confirmed]').check();
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Save reviewed private shutdown plans',exact:true}).click()]);
  assert.equal(new URL(tab.url()).pathname,'/autopilot/supplier-shutdowns');
  const ids=(await db.query('SELECT id FROM stockchief_runtime.agent_supplier_shutdowns WHERE workspace_id=$1 AND reference=$2 ORDER BY supplier_id',[ctx.workspaceId,reference])).rows.map(r=>r.id);
  assert.equal(ids.length,2);
  if(i===0){
   // The owner sets a limit on the phone; the worker prepares the draft; the owner undoes it.
   await tab.goto(origin+'/autopilot/supplier-shutdowns/'+ids[0]);
   const settings=tab.locator('form[action$="/settings"]').filter({has:tab.getByRole('button',{name:'Enable private shutdown planning',exact:true})});
   await settings.locator('[name=refreshDays]').fill('1');await settings.locator('[name=maximumAmount]').fill('24.00');await settings.locator('[name=confirmed]').check();
   await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Enable private shutdown planning',exact:true}).click()]);
   assert.equal((await f.work('phone-holiday')).status,'COMPLETED');
   await tab.reload();assert.match(await tab.locator('main').innerText(),/StockChief prepared/);assert.ok(await flat(tab));
   await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Undo: cancel this purchase draft',exact:true}).click()]);
   assert.match(await tab.locator('main').innerText(),/Status: cancelled/);assert.ok(await flat(tab),'No sideways scrolling at '+viewport.width+' px');
  }
  await tab.close();
 }
});

test('a database migrated only to 479 keeps shutdown planning and Needs you working without the purchase limit',{timeout:600000},async t=>{
 const f=await require('../helpers/agent-supplier-shutdown-fixture').fixture(t,{through:'479-workflow-check-duplicates.sql'}),{db,ctx,service}=f;
 assert.equal(await require('../../src/db/schema-installed').has(db,'stockchief_runtime.agent_supplier_shutdowns','maximum_minor'),false);
 const p=await f.preview(),saved=await f.save(),count=async()=>(await db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before=await count();
 await assert.rejects(service.configure(db,ctx,saved.shutdownId,{revision:1,refreshDays:'1',maximumAmount:'24.00',confirmed:'yes',sourceFingerprint:p.sourceFingerprint}),/being updated/);
 await service.configure(db,ctx,saved.shutdownId,{revision:1,refreshDays:'1',maximumAmount:'',confirmed:'yes',sourceFingerprint:p.sourceFingerprint});
 const run=await service.onProject(db,ctx.workspaceId,saved.shutdownId);assert.ok(run.id);assert.equal(run.purchaseOrderId,undefined);assert.equal(await count(),before);
 assert.ok(Array.isArray(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)));
 assert.equal((await service.page(db,ctx,saved.shutdownId)).project.enabled,true);
});
