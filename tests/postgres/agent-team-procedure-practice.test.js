'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 178: procedures come from how the team really works. Picking and
// customer returns join receiving, dispatch and counting, and the steps come
// from the scans, put-aways and return dispositions staff recorded. The owner
// can edit the staff text. Growth drafts for approval; on Pro and Custom an
// authorized procedure is kept current and, when the owner allows it,
// published to staff on its own, stopping to ask when the owner edited the
// staff text. Going back to an earlier version is the undo.
test('procedures follow recorded practice, are editable, and publish on their own only where the plan and owner allow',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
 const service=require('../../src/autopilot/team-procedures'),waves=require('../../src/operations/postgres-fulfillment-waves'),putaway=require('../../src/warehouse/agent-putaway');
 const returns=require('../../src/operations/postgres-returns'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
 const sku=f.item.skuIds[0];
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query("UPDATE skus SET barcode='SOP-PRODUCT' WHERE workspace_id=$1 AND id=$2",[ws,sku]);
 await db.query("UPDATE locations SET barcode='SOP-DOCK' WHERE workspace_id=$1 AND id=$2",[ws,f.location.id]);
 const shelf=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shelf B-01',kind:'bin',parentLocationId:f.location.id,barcode:'SOP-B01'});
 const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);
 const publications=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_team_procedure_publications WHERE workspace_id=$1 AND procedure_id=$2 ORDER BY approved_at,id',[ws,id])).rows;
 // A wave picked by scanning the bin and product; quantity 2 with a shortage when asked.
 const pickWave=async({short=false}={})=>{
  const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:short?2:1,unitPriceMinor:1000}]});
  await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
  const {waveId}=await waves.create(db,ctx,{strategy:'WAVE',orderIds:[o.salesOrderId],idempotencyKey:randomUUID()});
  const line=(await db.query('SELECT l.id,loc.barcode FROM fulfillment_wave_lines l JOIN locations loc ON loc.id=l.location_id WHERE l.workspace_id=$1 AND l.wave_id=$2',[ws,waveId])).rows[0];
  await waves.scan(db,ctx,waveId,{clientScanId:randomUUID(),locationBarcode:line.barcode,itemBarcode:'SOP-PRODUCT',quantity:1});
  if(short)await waves.reportShortage(db,ctx,waveId,line.id,0,'Bin empty');
  return waveId;
 };
 const picking={kind:'picking',locationId:f.location.id,lookbackDays:'30'};

 // Starter: refused.
 await subscribe('starter');
 await assert.rejects(service.preview(db,ctx,picking),e=>e.code==='entitlement_required');
 await browser.get('/autopilot/team-procedures').expect(200);

 // Growth: a picking procedure written from two scanned waves.
 await subscribe('growth');
 await assert.rejects(service.preview(db,ctx,picking),/No complete verified examples/,'Nothing is invented without recorded work.');
 await pickWave();await pickWave();
 let draft=await service.preview(db,ctx,picking);
 assert.equal(draft.examples.length,2);
 assert.deepEqual(draft.document.steps,['Open the pick wave for Dispatch and start it.','Follow the pick list in walking order, one zone at a time.',
  'Scan the bin label before taking anything from it.','Scan the product label for each item you pick.']);
 assert.deepEqual(draft.document.notes,[]);
 const saved=await service.save(db,ctx,{...picking,revision:0,confirmed:'yes',sourceFingerprint:draft.sourceFingerprint}),id=saved.procedureId;
 let page=await service.page(db,ctx,id);
 await assert.rejects(service.configure(db,ctx,id,{revision:1,refreshDays:'1',confirmed:'yes',publish:'yes',sourceFingerprint:draft.sourceFingerprint}),e=>e.code==='entitlement_required');
 // The owner edits the staff text before publishing it.
 const edits={versionId:page.latest.id,documentHash:page.latest.document_hash,expectedPublicationId:'',confirmed:'yes',requestKey:randomUUID(),
  title:'Picking at Dispatch',steps:page.latest.document.steps.join('\r\n')+'\r\nPut the empty tote back on the rack.',outcome:page.latest.document.outcome};
 await assert.rejects(service.publish(db,ctx,id,{...edits,requestKey:randomUUID(),steps:''}),/1 to 40 steps/);
 const first=await service.publish(db,ctx,id,edits);
 const staff=(await service.published(db,ctx,id)).publication.approved_document;
 assert.equal(staff.title,'Picking at Dispatch');assert.equal(staff.steps.at(-1),'Put the empty tote back on the rack.');
 assert.equal((await publications(id))[0].edited,true);
 assert.equal((await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Team procedure approved for staff' AND reference=$2",[ws,first.id])).rows[0].after_state.edited,true);

 // Receiving: the put-away recorded after one of the two receipts is part of the practice.
 const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:2,unitCost:1}]});
 await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 const received=await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'SOP-DELIVERY',lines:[{lineId:po.lineIds[0],quantity:2,locationId:f.location.id}]});
 const receiptLine=(await db.query('SELECT id FROM purchase_order_receipt_lines WHERE workspace_id=$1 AND receipt_id=$2',[ws,received.receiptId])).rows[0].id;
 const sheet=await putaway.prepare(db,ctx,receiptLine,shelf.id);
 await putaway.confirm(db,ctx,sheet.id,{requestKey:randomUUID(),method:'tap',confirmed:'yes'});
 const receiving=await service.preview(db,ctx,{kind:'receiving',locationId:f.location.id,lookbackDays:'30'});
 assert.equal(receiving.examples.length,2);
 assert.ok(receiving.document.steps.includes('Put the goods away in the bin on the put-away sheet and confirm each one. (In 1 of 2 recorded examples.)'),JSON.stringify(receiving.document.steps));
 assert.equal(receiving.document.steps.at(-1).startsWith('Put the goods away'),true,'The put-away came after the receipt was confirmed.');

 // Customer returns: received into Dispatch, inspected and restocked.
 const sale=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:1000}]});
 await f.workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
 await f.workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:sale.lineIds[0],locationId:f.location.id,quantity:1}],shipment:{handover:'COLLECTED'}});
 await assert.rejects(service.preview(db,ctx,{kind:'returns',locationId:f.location.id,lookbackDays:'30'}),/No complete verified examples/);
 const {customerReturnId}=await returns.requestCustomerReturn(db,ctx,{salesOrderId:sale.salesOrderId,quarantineLocationId:f.location.id,resolution:'NO_REFUND',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:sale.lineIds[0],quantity:1}]});
 await returns.authorizeCustomerReturn(db,ctx,customerReturnId,{idempotencyKey:randomUUID()});
 const returnLine=(await returns.getCustomerReturn(db,ws,customerReturnId)).lines[0].id;
 await returns.receiveCustomerReturn(db,ctx,customerReturnId,{idempotencyKey:randomUUID(),lines:[{lineId:returnLine,quantity:1}]});
 await returns.inspectCustomerReturn(db,ctx,customerReturnId,{idempotencyKey:randomUUID(),lines:[{lineId:returnLine,restock:1,restockLocationId:f.location.id}]});
 const returned=await service.preview(db,ctx,{kind:'returns',locationId:f.location.id,lookbackDays:'30'});
 assert.deepEqual(returned.document.steps,['Check the return against the original order and authorize it.','Receive the returned items into Dispatch and enter the quantity that arrived.',
  'Inspect each item and record what happens to it.','Put items that can be sold again back into stock.']);
 assert.equal(returned.document.title,'Receive and inspect customer returns at Dispatch');

 // Pro: the owner lets updates reach staff on their own. The staff text was
 // edited, so the first change in practice stops and asks.
 await subscribe('pro');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 page=await service.page(db,ctx,id);
 await service.configure(db,ctx,id,{revision:page.procedure.revision,refreshDays:'1',confirmed:'yes',publish:'yes',sourceFingerprint:page.freshFingerprint});
 assert.equal((await service.page(db,ctx,id)).procedure.auto_publish,true);
 await pickWave({short:true});
 let run=await service.onProcedure(db,ws,id);
 assert.equal(run.publishHeld,true);
 page=await service.page(db,ctx,id);
 assert.equal(page.current.id,first.id,'The edited staff text stays.');
 assert.match(page.problem,/You edited the staff version/);
 assert.ok(page.latest.document.notes.includes('Sometimes (1 of 3 recorded examples): If a bin is short, report the shortage with the quantity you found.'));
 assert.match((await service.inbox(db,ws,ctx.actorId))[0].title,/Review private procedure updates: Pick customer orders at Dispatch/);
 // The owner publishes the new draft as written; later changes then publish on their own.
 const second=await service.publish(db,ctx,id,{versionId:page.latest.id,documentHash:page.latest.document_hash,expectedPublicationId:first.id,confirmed:'yes',requestKey:randomUUID()});
 assert.equal((await service.page(db,ctx,id)).problem,null);
 await pickWave({short:true});await pickWave({short:true});
 run=await service.onProcedure(db,ws,id);
 assert.ok(run.publicationId,JSON.stringify(run));
 const auto=(await publications(id)).at(-1);
 assert.deepEqual([auto.id,auto.automatic,auto.edited],[run.publicationId,true,false]);
 assert.ok((await service.published(db,ctx,id)).publication.approved_document.steps.some(s=>s.startsWith('If a bin is short')),'Shortages are now in most examples, so they became a step.');
 assert.equal(await audits('Team procedure published to staff by StockChief'),1);
 assert.equal((await service.onProcedure(db,ws,id)).replayed,true,'A replay publishes nothing.');
 assert.equal(await audits('Team procedure published to staff by StockChief'),1);

 // Undo: the owner goes back to the version they published; publishing on its own stops.
 await service.restore(db,ctx,id,{publicationId:second.id,expectedPublicationId:auto.id});
 assert.equal((await service.published(db,ctx,id)).publication.id,second.id);
 assert.equal((await service.page(db,ctx,id)).procedure.auto_publish,false);
 assert.equal(await audits('Team procedure restored to an earlier staff version'),1);
 assert.equal((await service.restore(db,ctx,id,{publicationId:second.id,expectedPublicationId:second.id})).replayed,true);

 // Pause, Ask me first and the first 14 days hold automatic updates.
 page=await service.page(db,ctx,id);
 await service.configure(db,ctx,id,{revision:page.procedure.revision,refreshDays:'1',confirmed:'yes',publish:'yes',sourceFingerprint:page.freshFingerprint});
 await pickWave();
 await autopilot.pause(db,ctx,{role:'owner'},'Holiday');assert.equal((await service.onProcedure(db,ws,id)).held,true);await autopilot.resume(db,ctx,{role:'owner'});
 await modes.save(db,ctx,178,{mode:'ask',revision:0});assert.equal((await service.onProcedure(db,ws,id)).held,true);await modes.save(db,ctx,178,{mode:'inherit',revision:1});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await service.onProcedure(db,ws,id)).held,true);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 assert.equal(await audits('Team procedure published to staff by StockChief'),1);
 // Growth cannot publish on its own; Custom can.
 await subscribe('growth');assert.equal((await service.onProcedure(db,ws,id)).held,true);
 await subscribe('enterprise');run=await service.onProcedure(db,ws,id);
 assert.ok(run.publicationId,'Custom publishes the changed practice on its own.');assert.equal(await audits('Team procedure published to staff by StockChief'),2);

 // Staff limited to Dispatch see the published procedure in their list.
 const email=randomUUID()+'@example.test',home=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Picker',businessName:'Picker home',email,password:f.password}),picker=randomUUID();
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,'Dock picker','staff',NULL,$4::jsonb,now()::text)",[picker,ws,home.accountId,JSON.stringify([f.location.id])]);
 assert.deepEqual((await service.staffList(db,{workspaceId:ws,actorId:picker})).rows.map(r=>r.id),[id]);
 const elsewhere=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Other warehouse',kind:'warehouse'});
 await db.query('UPDATE users SET warehouse_location_ids=$2::jsonb WHERE id=$1',[picker,JSON.stringify([elsewhere.id])]);
 assert.deepEqual((await service.staffList(db,{workspaceId:ws,actorId:picker})).rows,[]);
 await db.query('UPDATE users SET warehouse_location_ids=$2::jsonb WHERE id=$1',[picker,JSON.stringify([f.location.id])]);

 // The owner's procedure page and the staff list read well on a desktop and at 390 px.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 const signIn=async(tab,who)=>{await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(who);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);};
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
  await signIn(tab,f.email);await tab.goto(base+'/autopilot/team-procedures/'+id);
  assert(await tab.getByRole('heading',{name:'Current owner-approved staff version'}).isVisible());
  await tab.getByText('Edit the text staff will see').click();
  assert.match(await tab.locator('[name=steps]').inputValue(),/Scan the bin label/);
  assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
  await tab.screenshot({path:require('node:path').join(folder,'team-procedure-'+name+'.png'),fullPage:true});
  await tab.close();
 }
 const mobile=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});mobile.setDefaultTimeout(15000);
 await signIn(mobile,email);await mobile.goto(base+'/inventories');
 await mobile.request.post(base+'/inventories/switch',{form:{_csrf:await mobile.locator('[name=_csrf]').first().inputValue(),workspaceId:ws}});
 await mobile.goto(base+'/team-procedures');
 await mobile.getByRole('link',{name:'Picking at Dispatch'}).or(mobile.getByRole('link',{name:'Pick customer orders at Dispatch'})).first().click();
 assert.match(await mobile.locator('main').innerText(),/Scan the bin label/);
 assert(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await mobile.screenshot({path:require('node:path').join(folder,'team-procedure-staff-phone.png'),fullPage:true});
});
