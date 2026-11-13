'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 180: the daily team summary is alone on Growth, Pro and Custom and
// excluded on Starter. The worker writes it once per business day from the
// records: who did what (counts, picks, receipts, put-aways, adjustments by
// person), what is late (staff tasks, customer orders, purchase orders) and
// the exceptions. It shows on its page and in Needs you, and reaches email
// through the shared alert delivery, which waits during the first 14 days,
// pause and Ask me first (where the owner can send it from the page).
test('the daily team summary says who did what and what is late, and reaches the app, Needs you and email on its own',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
 const summary=require('../../src/autopilot/team-summary'),alerts=require('../../src/autopilot/agent-alerts'),notices=require('../../src/autopilot/operational-notices');
 const reviews=require('../../src/autopilot/job-reviews'),needs=require('../../src/projections/postgres-service'),modes=require('../../src/autopilot/job-modes');
 const autopilot=require('../../src/autopilot/postgres-service'),mail=require('../../src/connections/postgres-outbound-mail');
 const waves=require('../../src/operations/postgres-fulfillment-waves'),putaway=require('../../src/warehouse/agent-putaway'),counts=require('../../src/operations/agent-count-tasks');
 const tasks=require('../../src/operations/agent-staff-tasks'),inventory=require('../../src/domain/postgres-inventory-engine');
 const worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
 const evaluate=()=>db.transaction(c=>worker({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
 const time=require('../../src/lib/business-time'),{addDays}=require('../../src/accounting/customer-money');
 const today=await time.today(db,ws),tomorrow=new Date(Date.now()+86400000),sku=f.item.skuIds[0];
 const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query("UPDATE skus SET barcode='SUM-PRODUCT' WHERE workspace_id=$1 AND id=$2",[ws,sku]);
 await db.query("UPDATE locations SET barcode='SUM-DOCK' WHERE workspace_id=$1 AND id=$2",[ws,f.location.id]);
 const shelf=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shelf C-01',kind:'bin',parentLocationId:f.location.id,barcode:'SUM-C01'});
 const home=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Ana',businessName:'Ana home',email:randomUUID()+'@example.test',password:f.password}),anaId=randomUUID(),ana={workspaceId:ws,actorId:anaId};
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,'Ana floor','staff',NULL,NULL,now()::text)",[anaId,ws,home.accountId]);
 const purchase=async(expectedDate=null)=>{
  const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,expectedDate,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:2,unitCost:1}]});
  await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});return po;
 };
 const sheet=async()=>{const po=await purchase();const r=await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:2,locationId:f.location.id}]});
  return (await putaway.prepare(db,ctx,(await db.query('SELECT id FROM purchase_order_receipt_lines WHERE workspace_id=$1 AND receipt_id=$2',[ws,r.receiptId])).rows[0].id,shelf.id)).id;};
 const order=async(quantity,neededBy=null)=>{const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,neededBy,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity,unitPriceMinor:900}]});
  await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});return o;};

 // Starter is excluded: no summary and the page is locked.
 await subscribe('starter');
 assert.deepEqual(await summary.deliver(db,ws),{skipped:'plan'});
 await browser.get(summary.path).expect(402);

 // Growth. A day of team work: Ana picks two waves (one short), puts away a
 // receipt and counts a shelf that differs; the owner receives and adjusts.
 await subscribe('growth');
 const wave=async(quantity,short)=>{const o=await order(quantity);const {waveId}=await waves.create(db,ctx,{strategy:'WAVE',orderIds:[o.salesOrderId],idempotencyKey:randomUUID()});
  const line=(await db.query('SELECT id FROM fulfillment_wave_lines WHERE workspace_id=$1 AND wave_id=$2',[ws,waveId])).rows[0];
  await waves.scan(db,ana,waveId,{clientScanId:randomUUID(),locationBarcode:'SUM-DOCK',itemBarcode:'SUM-PRODUCT',quantity:1});
  if(short)await waves.reportShortage(db,ana,waveId,line.id,0,'Bin empty');};
 await wave(1,false);await wave(2,true);
 await putaway.confirm(db,ana,await sheet(),{requestKey:randomUUID(),method:'tap',confirmed:'yes'});
 const countId=await counts.assign(db,ctx,{locationId:shelf.id,counterId:anaId,requestKey:randomUUID()});
 for(const l of (await db.query('SELECT location_id,sku_id,before_quantity FROM warehouse_count_campaign_lines WHERE workspace_id=$1 AND campaign_id=$2',[ws,countId])).rows)
  await counts.record(db,ana,countId,{locationId:l.location_id,skuId:l.sku_id,quantity:String(Number(l.before_quantity)-1)});
 await inventory.adjust(db,ctx,{skuId:sku,locationId:f.location.id,countedQuantity:15,reasonCode:'cycle_count',idempotencyKey:randomUUID()});
 // Late: a put-away task for Ana past its time, a customer order and a purchase order past their dates.
 const lateSheet=await sheet();
 const lateTask=await tasks.assign(db,ctx,{kind:'putaway',sourceId:lateSheet,assigneeId:anaId,dueHours:'1',requestKey:randomUUID()});
 await db.query("UPDATE stockchief_runtime.agent_staff_tasks SET due_at=now()-interval '2 hours' WHERE id=$1",[lateTask.id]);
 const lateOrder=await order(1,addDays(today,-1)),latePo=await purchase(addDays(today,-2));

 // The worker writes yesterday's summary once; a replay adds nothing.
 await evaluate();await evaluate();
 assert.equal(await audits('Daily team summary prepared'),1);
 assert.equal((await db.query('SELECT report_date::text AS d FROM stockchief_runtime.agent_team_summaries WHERE workspace_id=$1',[ws])).rows[0].d,addDays(today,-1));
 // Today's work is summarized when today has ended.
 const written=await summary.deliver(db,ws,{now:tomorrow});
 assert.equal(written.day,today);
 assert.equal((await summary.deliver(db,ws,{now:tomorrow})).replayed,true);
 assert.equal(await audits('Daily team summary prepared'),2);
 const rows=(await reviews.run(db,ctx,summary.key,{filter:today})).rows,find=(who,what)=>rows.find(r=>r['Team member']===who&&r.Activity===what)?.Count;
 assert.equal(find('Ana floor','Pick lines scanned'),2);
 assert.equal(find('Ana floor','Put-aways confirmed'),1);
 assert.equal(find('Ana floor','Shelf positions counted'),1);
 assert.equal(find('Ana floor','Shortages reported while picking'),1);
 assert.equal(find('Ana floor','Counts that differ from the records'),1);
 assert.equal(find('Ana floor','Late staff tasks'),1);
 assert.ok(find('Owner','Stock receipts')>=2);
 assert.equal(find('Owner','Count adjustments'),1);
 assert.equal(find('Inventory','Late customer orders'),1);
 assert.equal(find('Inventory','Late purchase orders'),1);
 assert.ok(find('Inventory','Overdue orders, shipments and invoices')>=2);
 const text=await summary.lines(db,ws,[{reference:today}]);
 assert.equal(text[0],'Team summary for '+today+'.');
 assert.ok(text.some(l=>/^Ana floor: .*2 pick lines scanned/.test(l)&&/1 put-away confirmed/.test(l)&&/Exceptions: .*shortages reported while picking: 1/.test(l)),text.join('\n'));
 assert.ok(text.includes('Late now: 1 staff task, 1 customer order, 1 purchase order.'),text.join('\n'));
 assert.ok(text.some(l=>l.startsWith('Late task: Put away 2 × Parcel item to Shelf C-01 (Ana floor)')));
 assert.equal(lateOrder.orderNumber.length>0&&latePo.poNumber.length>0,true);

 // It reaches Needs you and the page, for the latest day.
 await notices.refresh(db,ws);
 const item=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-180');
 assert.deepEqual([item.title,item.href],['Your daily team summary',summary.path+'?filter='+today]);
 const pageHtml=(await browser.get(summary.path).expect(200)).text;
 assert.match(pageHtml,/How you get these alerts/);assert.match(pageHtml,/Pick lines scanned/);

 // Email from the owner's mailbox: held during the first 14 days, then sent on its own.
 const connector=randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
  VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
 await browser.post('/autopilot/alerts/180').type('form').send({_csrf:f.csrf(pageHtml),mailbox:connector,revision:'0'}).expect(303);
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
 await notices.refresh(db,ws);
 let panel=await alerts.panel(db,ctx,180);
 assert.equal(panel.waiting,1);assert.match(panel.note,/first 14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await notices.refresh(db,ws);
 assert.equal((await alerts.panel(db,ctx,180)).waiting,0);
 const latest=async()=>(await db.query('SELECT * FROM customer_communications WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[ws])).rows[0];
 const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
 const delivered=[],provider={send:async({message})=>{delivered.push(message);return {externalMessageId:'accepted-'+message.id};}};
 await mail.executeSendEffect(db,ws,await effect((await latest()).id),{provider});
 assert.equal(delivered[0].recipient,f.email);assert.equal(delivered[0].subject,'Team summary for '+today);
 assert.match(delivered[0].body,/What your team did, and what is late\./);assert.match(delivered[0].body,/- Ana floor: /);assert.match(delivered[0].body,/- Late now: 1 staff task/);

 // A new day while paused, then under Ask me first: the email waits, and the
 // owner can send it from the page.
 let ahead=1;const nextDay=async()=>{ahead++;assert.equal((await summary.deliver(db,ws,{now:new Date(Date.now()+ahead*86400000)})).day,addDays(today,ahead-1));};
 await nextDay();await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');await notices.refresh(db,ws);
 panel=await alerts.panel(db,ctx,180);assert.equal(panel.waiting,1);assert.match(panel.note,/paused/);
 await autopilot.resume(db,ctx,{role:'owner'});
 await modes.save(db,ctx,180,{mode:'ask',revision:0});await notices.refresh(db,ws);
 panel=await alerts.panel(db,ctx,180);assert.match(panel.note,/Ask me first/);assert.equal(panel.canSendNow,true);
 await browser.post('/autopilot/alerts/180/send').type('form').send({_csrf:f.csrf((await browser.get(summary.path).expect(200)).text)}).expect(303);
 assert.equal(await audits('Alert email queued'),2);
 assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===180).allowed,['inherit','watch','ask','routine']);
 await modes.save(db,ctx,180,{mode:'inherit',revision:1});

 // Pro and Custom write it on their own too; Starter loses it.
 for(const tier of ['pro','enterprise']){await subscribe(tier);await nextDay();await browser.get(summary.path).expect(200);
  assert.ok((await reviews.run(db,ctx,summary.key,{filter:today})).rows.some(r=>r.Activity==='Pick lines scanned'),tier);}
 await subscribe('starter');
 await browser.get(summary.path).expect(402);
 assert.equal((await needs.needs(db,ws,ctx.actorId)).some(n=>n.sourceId==='agent-notice-180'),false);
 await subscribe('pro');

 // The page reads well on a desktop and on a 390 px phone.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
  await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await tab.goto(base+summary.path);
  assert(await tab.getByRole('heading',{name:'Daily team summary: who did what and what is late',exact:true}).isVisible());
  assert(await tab.getByRole('heading',{name:'How you get these alerts'}).isVisible());
  assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
  await tab.screenshot({path:require('node:path').join(folder,'team-summary-'+name+'.png'),fullPage:true});
  await tab.close();
 }
});
