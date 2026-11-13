'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 177: StockChief gives staff tasks (pick this wave, put away this
// receipt, inspect this delivery, move this stock, count this shelf) and
// checks them off only against the work's own record. Starter is refused,
// Growth drafts for approval, Pro and Custom hand work out on their own inside
// the owner's limits. Pause, Watch only and the first 14 days hand out
// nothing new; Ask me first drafts. Late tasks are flagged once.
test('staff tasks follow each plan, reach the right phone and are checked off against the real records',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
 const tasks=require('../../src/operations/agent-staff-tasks'),autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
 const putaway=require('../../src/warehouse/agent-putaway'),waves=require('../../src/operations/postgres-fulfillment-waves'),counts=require('../../src/operations/agent-count-tasks');
 const corrections=require('../../src/warehouse/agent-bin-corrections'),quality=require('../../src/operations/agent-quality-holds');
 const needs=require('../../src/projections/postgres-service'),places=require('../../src/domain/postgres-location-service');
 const sku=f.item.skuIds[0],page=tasks.path;
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query("UPDATE skus SET barcode='TASK-PRODUCT' WHERE workspace_id=$1 AND id=$2",[ws,sku]);
 await db.query("UPDATE locations SET barcode='TASK-DOCK' WHERE workspace_id=$1 AND id=$2",[ws,f.location.id]);
 const shelf=await places.createLocation(db,ctx,{name:'Shelf A-01',kind:'bin',parentLocationId:f.location.id,barcode:'TASK-A01'});
 const spare=await places.createLocation(db,ctx,{name:'Shelf A-02',kind:'bin',parentLocationId:f.location.id,barcode:'TASK-A02'});
 // Ana works anywhere; Ben is limited to Dispatch and its shelves.
 const member=async(name,locations)=>{
  const email=randomUUID()+'@example.test',home=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name,businessName:name+' home',email,password:f.password}),id=randomUUID();
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,$4,'staff',NULL,$5::jsonb,now()::text)",
   [id,ws,home.accountId,name,locations?JSON.stringify(locations):null]);
  return {workspaceId:ws,actorId:id,email};
 };
 const ana=await member('Ana floor',null),ben=await member('Ben dock',[f.location.id]);
 // Native work: a put-away sheet for a fresh receipt, and a pick wave for a confirmed order.
 const receipt=async()=>{
  const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:2,unitCost:1}]});
  await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const r=await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:2,locationId:f.location.id}]});
  const line=(await db.query('SELECT id FROM purchase_order_receipt_lines WHERE workspace_id=$1 AND receipt_id=$2',[ws,r.receiptId])).rows[0].id;
  return (await putaway.prepare(db,ctx,line,shelf.id)).id;
 };
 const wave=async()=>{
  const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:1000}]});
  await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
  return {id:(await waves.create(db,ctx,{strategy:'WAVE',orderIds:[o.salesOrderId],idempotencyKey:randomUUID()})).waveId,order:o.orderNumber};
 };
 const pick=async(person,id)=>{for(const l of (await db.query(`SELECT l.planned_quantity,loc.barcode FROM fulfillment_wave_lines l JOIN locations loc ON loc.id=l.location_id WHERE l.workspace_id=$1 AND l.wave_id=$2`,[ws,id])).rows)
  assert.equal((await waves.scan(db,person,id,{clientScanId:randomUUID(),locationBarcode:l.barcode,itemBarcode:'TASK-PRODUCT',quantity:l.planned_quantity})).status,'ACCEPTED');};
 const shelve=(person,id)=>putaway.confirm(db,person,id,{requestKey:randomUUID(),method:'tap',confirmed:'yes'});
 const task=async(kind,source)=>(await db.query(`SELECT t.*,u.name FROM stockchief_runtime.agent_staff_tasks t JOIN users u ON u.id=t.assignee_id
   WHERE t.workspace_id=$1 AND t.kind=$2 AND t.source_id=$3 ORDER BY t.created_at DESC LIMIT 1`,[ws,kind,source])).rows[0];
 const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);
 const inbox=async person=>(await needs.needs(db,ws,person.actorId)).filter(n=>/^staff-task/.test(n.sourceId||''));
 const check=()=>tasks.run(db,ws);
 const form=async()=>f.csrf((await browser.get(page).expect(200)).text);

 // Older terms see the plan card; Starter is refused with the plan lock.
 assert.match((await browser.get(page).expect(200)).text,/data-agent-plan-locked/);
 await subscribe('starter');
 await browser.get(page).expect(402);
 await assert.rejects(tasks.saveRule(db,ctx,{kinds:['pick'],dueHours:'4',maxOpen:'1'}),/Growth/);
 assert.deepEqual(await check(),{skipped:'plan'});

 // Growth: StockChief drafts each assignment within the owner's limits.
 await subscribe('growth');
 await browser.post(page+'/limits').type('form').send({_csrf:await form(),revision:'0',kinds:['pick','putaway','inspect','move'],dueHours:'4',maxOpen:'1'}).expect(303);
 const first=await wave(),shelfA=await receipt(),shelfB=await receipt();
 let result=await check();
 assert.deepEqual([result.drafted,result.assigned,result.unstaffed],[2,0,1]);
 assert.equal((await task('pick',first.id)).name,'Ana floor','Only unrestricted staff can open a pick wave.');
 assert.equal((await task('putaway',shelfA)).name,'Ben dock','Ana is at the limit of one open task, so the put-away goes to Ben.');
 assert.equal(await task('putaway',shelfB),undefined,'Everyone is at the limit.');
 assert.equal((await task('pick',first.id)).title,'Pick order '+first.order+' (wave 1)');
 assert.match((await db.query('SELECT last_issue FROM stockchief_runtime.agent_staff_task_rules WHERE workspace_id=$1',[ws])).rows[0].last_issue,/no team member who can do it/);
 assert.deepEqual(await inbox(ana),[],'A draft does not reach the phone.');
 assert.equal((await inbox(ctx)).find(n=>n.sourceId==='staff-tasks-drafts').title,'Approve staff tasks');
 await check();assert.equal(await audits('Staff task assignments drafted'),1,'A replay drafts nothing new.');
 await browser.post(page+'/approve').type('form').send({_csrf:await form(),all:'yes'}).expect(303);
 assert.deepEqual([(await task('pick',first.id)).status,(await task('putaway',shelfA)).status],['ASSIGNED','ASSIGNED']);
 assert.equal((await task('pick',first.id)).approved_by,ctx.actorId);
 assert.deepEqual((await inbox(ana)).map(n=>[n.title,n.href,n.actionLabel]),[['Pick order '+first.order+' (wave 1)','/warehouse/waves/'+first.id,'Open task']]);
 assert.deepEqual((await inbox(ben)).map(n=>n.href),['/warehouse/putaway/'+shelfA]);

 // Checked off only when the wave is scanned and the put-away confirmed.
 await check();assert.equal((await task('pick',first.id)).status,'ASSIGNED');
 await pick(ana,first.id);await shelve(ben,shelfA);
 result=await check();
 assert.equal(result.done,2);
 const picked=await task('pick',first.id),shelved=await task('putaway',shelfA);
 assert.deepEqual([picked.status,picked.done_by,picked.evidence.picked,picked.evidence.lines,picked.evidence.checked],['DONE',ana.actorId,1,1,'every line scanned']);
 assert.deepEqual([shelved.status,shelved.done_by,shelved.evidence.putAway,shelved.evidence.checked],['DONE',ben.actorId,'2','put-away confirmed']);
 assert.equal((await task('putaway',shelfB)).name,'Ana floor','Free again, Ana gets the waiting put-away as a draft.');
 assert.equal(await audits('Staff task done'),2);

 // Undo: the owner declines the draft, and StockChief does not offer it again.
 await tasks.withdraw(db,ctx,(await task('putaway',shelfB)).id);
 await check();
 assert.equal((await task('putaway',shelfB)).status,'CANCELLED');
 // The owner can still give it to someone; a replayed form changes nothing.
 const key=randomUUID(),assignment={kind:'putaway',sourceId:shelfB,assigneeId:ben.actorId,dueHours:'2',requestKey:key};
 await browser.post(page).type('form').send({_csrf:await form(),...assignment}).expect(303);
 assert.equal((await tasks.assign(db,ctx,assignment)).replayed,true);
 await assert.rejects(tasks.assign(db,ctx,{...assignment,requestKey:randomUUID(),assigneeId:ana.actorId}),/already has a task/);
 const leftover=await wave();
 await assert.rejects(tasks.assign(db,ctx,{kind:'pick',sourceId:leftover.id,assigneeId:ben.actorId,requestKey:randomUUID()}),/can do this work/);
 const manual=await task('putaway',shelfB);
 assert.deepEqual([manual.status,manual.name,manual.automatic],['ASSIGNED','Ben dock',false]);

 // Late work is flagged once, to the owner and on the person's phone.
 await db.query("UPDATE stockchief_runtime.agent_staff_tasks SET due_at=now()-interval '1 hour' WHERE id=$1",[manual.id]);
 await check();await check();
 assert.equal(await audits('Staff task late'),1);
 assert.equal((await inbox(ctx)).find(n=>n.sourceId==='staff-tasks-late').happened,'1 task is past the time it was due.');
 assert.match((await inbox(ben))[0].title,/^Late: Put away 2 × Parcel item to Shelf A-01$/);
 await shelve(ben,shelfB);await check();
 assert.equal((await task('putaway',shelfB)).status,'DONE');
 assert.equal((await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Staff task done' AND reference=$2",[ws,manual.id])).rows[0].after_state.late,true);

 // The wave left waiting above was drafted for Ana while she was free.
 assert.equal((await task('pick',leftover.id)).status,'DRAFT');

 // Pro: StockChief hands work out on its own. The owner allows two open tasks each.
 await subscribe('pro');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await tasks.saveRule(db,ctx,{revision:'1',kinds:['pick','putaway','inspect','move'],dueHours:'4',maxOpen:'2'});
 await assert.rejects(tasks.saveRule(db,ctx,{revision:'1',kinds:['pick'],dueHours:'4',maxOpen:'2'}),/changed/);
 await assert.rejects(tasks.saveRule(db,ctx,{revision:'2',kinds:['pick'],dueHours:'400',maxOpen:'2'}),/1 to 168 hours/);
 const second=await wave();
 result=await check();
 assert.equal(result.assigned,1,JSON.stringify(result));
 const own=await task('pick',second.id);
 assert.equal(own.automatic,true);assert.equal(own.status,'ASSIGNED');
 assert.equal(await audits('Staff tasks handed out'),1);
 // Ask me first drafts instead; Watch only and pause hand out nothing.
 await modes.save(db,ctx,177,{mode:'ask',revision:0});
 const third=await receipt();await check();
 assert.equal((await task('putaway',third)).status,'DRAFT');
 await modes.save(db,ctx,177,{mode:'watch',revision:1});
 const fourth=await receipt();result=await check();
 assert.match(result.held,/Watch only/);assert.equal(await task('putaway',fourth),undefined);
 assert.match((await browser.get(page).expect(200)).text,/Watch only/);
 await modes.save(db,ctx,177,{mode:'inherit',revision:2});
 await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');
 await pick(ana,second.id);
 result=await check();
 assert.match(result.held,/paused/);assert.equal(await task('putaway',fourth),undefined);
 assert.equal((await task('pick',second.id)).status,'DONE','Finished work is still checked off during a pause.');
 await autopilot.resume(db,ctx,{role:'owner'});
 // The first 14 days only watch.
 await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
 result=await check();assert.match(result.held,/first 14 days/);assert.equal(await task('putaway',fourth),undefined);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await tasks.saveRule(db,ctx,{revision:'2',kinds:['pick','putaway','inspect','move'],dueHours:'8',maxOpen:'10'});
 await check();
 assert.equal((await task('putaway',fourth)).automatic,true);

 // Moving stock: the move counts once the person scans it.
 const moveId=(await corrections.open(db,ctx,{requestKey:randomUUID(),productCode:'TASK-PRODUCT',fromCode:'TASK-A01',toCode:'TASK-A02',quantity:1,reason:'wrong-putaway'})).id;
 await check();
 const move=await task('move',moveId),mover=[ana,ben].find(p=>p.actorId===move.assignee_id);
 assert.equal(move.status,'ASSIGNED');
 const correction=await corrections.get(db,ctx,moveId);
 await corrections.scan(db,mover,moveId,{productCode:'TASK-PRODUCT',fromCode:'TASK-A01',toCode:'TASK-A02',quantity:1,confirmed:'yes',expectedFingerprint:correction.fingerprint});
 await check();
 assert.deepEqual([(await task('move',moveId)).status,(await task('move',moveId)).evidence.result],['DONE','SCANNED']);

 // Counting a shelf: a count assignment becomes a task for its counter.
 const countId=await counts.assign(db,ctx,{locationId:shelf.id,counterId:ben.actorId,requestKey:randomUUID()});
 await check();
 const counting=await task('count',countId);
 assert.deepEqual([counting.status,counting.name,counting.approved_by],['ASSIGNED','Ben dock',ctx.actorId]);
 for(const l of (await db.query('SELECT location_id,sku_id,before_quantity FROM warehouse_count_campaign_lines WHERE workspace_id=$1 AND campaign_id=$2',[ws,countId])).rows)
  await counts.record(db,ben,countId,{locationId:l.location_id,skuId:l.sku_id,quantity:String(l.before_quantity)});
 await check();
 const counted=await task('count',countId);
 assert.deepEqual([counted.status,counted.evidence.counted,counted.evidence.checked],['DONE',counted.evidence.positions,'count saved']);

 // Inspecting a delivery held for QC: only someone who books in deliveries gets it.
 await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,last_unit_cost,minimum_order_quantity,order_multiple,created_at,updated_at)
  VALUES($1,$2,'fixture-supplier',$3,1,1,1,now()::text,now()::text) ON CONFLICT(workspace_id,supplier_id,sku_id) DO NOTHING`,[randomUUID(),ws,sku]);
 await quality.save(db,ctx,{supplierId:'fixture-supplier',skuId:sku,locationId:f.location.id,checklist:['Check packaging'],maxUnits:10,confirmed:'yes',mode:'automatic'});
 const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:3,unitCost:1}]});
 await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:3,locationId:f.location.id}]});
 const hold=(await db.query("SELECT id,revision FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND status='HELD'",[ws])).rows[0];
 await check();
 const inspection=await task('inspect',hold.id);
 assert.equal(inspection.name,'Ana floor','Ben is limited to some warehouses and cannot open the delivery check page.');
 await quality.inspect(db,ana,hold.id,{revision:hold.revision,decision:'PASS',physicallyChecked:'yes',checks:['0']});
 await check();
 assert.deepEqual([(await task('inspect',hold.id)).status,(await task('inspect',hold.id)).evidence.result],['DONE','PASSED']);

 // The review behind Ask lists the tasks with their state.
 const review=await require('../../src/autopilot/job-reviews').run(db,ctx,'staff-tasks');
 assert.ok(review.rows.some(r=>r.Status==='Done: 1 of 1 lines scanned'));
 // Custom keeps the same authority; a downgrade to Starter stops everything.
 await subscribe('enterprise');assert.equal((await browser.get(page).expect(200)).status,200);
 await subscribe('starter');assert.deepEqual(await inbox(ben),[]);assert.deepEqual(await check(),{skipped:'plan'});
 await subscribe('pro');

 // The owner's page and Ben's phone list read well on a desktop and at 390 px.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 const signIn=async(tab,email)=>{await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(email);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);};
 await receipt();await check();
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
  await signIn(tab,f.email);await tab.goto(base+page);
  assert(await tab.getByRole('heading',{name:'Staff tasks',exact:true}).isVisible());
  assert(await tab.getByRole('heading',{name:'Open tasks'}).isVisible());
  assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
  await tab.screenshot({path:require('node:path').join(folder,'staff-tasks-'+name+'.png'),fullPage:true});
  await tab.close();
 }
 const phone=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});phone.setDefaultTimeout(15000);
 await signIn(phone,ben.email);await phone.goto(base+'/inventories');
 await phone.request.post(base+'/inventories/switch',{form:{_csrf:await phone.locator('[name=_csrf]').first().inputValue(),workspaceId:ws}});
 await phone.goto(base+page);
 assert(await phone.getByRole('heading',{name:'My tasks'}).isVisible());
 assert.match(await phone.locator('main').innerText(),/Put away 2 × Parcel item to Shelf A-01/);
 assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'the phone list must not scroll sideways');
 await phone.screenshot({path:require('node:path').join(folder,'staff-tasks-my-phone.png'),fullPage:true});
 await phone.goto(base+'/warehouse/stock');
 assert.match(await phone.locator('main').innerText(),/My tasks/);
});
