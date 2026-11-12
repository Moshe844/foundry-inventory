'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 170 is excluded on Starter and alone on Growth, Pro and Custom. The
// worker's routine check raises an alert when a cost rises by the owner's
// percentage (the saved purchase cost, the cost when received with freight and
// duty, a supplier's new price) and when gross margin falls under the owner's
// percentage for an item, a category or a sales channel; it clears them when
// that stops being true. Alerts show in the app and Needs you in every mode;
// emailing them waits for shadow, pause, Watch only and Ask me first.
test('cost and margin alerts open, clear and reach email on their own on Growth, Pro and Custom',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx,browser,subscribe,workflows,location}=f,ws=ctx.workspaceId;
  const pricing=require('../../src/pricing/postgres-service'),alerts=require('../../src/autopilot/agent-alerts'),cost=require('../../src/autopilot/cost-alerts');
  const reviews=require('../../src/autopilot/job-reviews'),needs=require('../../src/projections/postgres-service'),watches=require('../../src/autopilot/activity-watches');
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),mail=require('../../src/connections/postgres-outbound-mail');
  const worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  const check=()=>db.transaction(c=>worker({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const open=async()=>(await db.query(`SELECT kind FROM stockchief_runtime.agent_operational_notices
    WHERE workspace_id=$1 AND job_id=170 AND NOT resolved ORDER BY kind,reference`,[ws])).rows.map(r=>r.kind);
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].count);
  const audits=action=>count('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);
  const rows=async()=>(await reviews.run(db,ctx,cost.key,{scheduled:true})).rows;
  const notice=async()=>(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-170');
  const settings=async body=>{const page=await browser.get(cost.path).expect(200);
    await browser.post('/autopilot/alert-settings/170').type('form').send({_csrf:f.csrf(page.text),revision:(await watches.settings(db,ws,170)).revision,...body}).expect(303);};

  // Recorded costs. The fixture received ten units at $1.00.
  await db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,'Tools','{}',now()::text,now()::text)`,[ws,f.item.itemId||f.item.id]);
  await pricing.setPrice(db,ctx,{skuId:sku,currency:'USD',amountMinor:250});
  for(const amountMinor of [104,130])await pricing.setPurchaseCost(db,ctx,{skuId:sku,currency:'USD',amountMinor});
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:2,unitCost:1.2}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const receipt=await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:2,locationId:location.id}]});

  // Starter: excluded, with the plan lock.
  await subscribe('starter');
  await check();
  assert.deepEqual(await open(),[]);
  await browser.get(cost.path).expect(402);
  await assert.rejects(reviews.run(db,ctx,cost.key,{scheduled:true}),e=>e.code==='entitlement_required');
  await assert.rejects(watches.save(db,ctx,170,{marginPct:45,revision:0}),e=>e.code==='entitlement_required');
  await assert.rejects(alerts.configure(db,ctx,170,{mailbox:''}),e=>e.code==='entitlement_required');

  // Freight added to the new receipt (landed cost) and a supplier's higher
  // price list need Pro for the freight; the alerts themselves run on Growth.
  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const landed=require('../../src/accounting/postgres-landed-costs');
  const bill=await workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',supplierInvoiceNumber:'FREIGHT-'+randomUUID(),currency:'USD',idempotencyKey:randomUUID(),
    lines:[{description:'Inbound freight',quantity:1,unitCostMinor:60}]});
  const fee=(await db.query('SELECT id FROM accounting_supplier_bill_lines WHERE workspace_id=$1 AND bill_id=$2',[ws,bill.billId||bill.id])).rows[0].id;
  const draft=await landed.createDraft(db,ctx,{purchaseOrderId:po.purchaseOrderId,receiptIds:[receipt.receiptId],charges:[{sourceBillLineId:fee,amountMinor:60,category:'freight'}],method:'quantity',requestKey:randomUUID()});
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{skuId:sku,supplierId:'fixture-supplier',supplierSku:'VENDOR-A',purchaseUnit:'case',unitsPerPurchaseUnit:6,lastUnitCost:'1.00'});
  const lists=require('../../src/purchasing/agent-supplier-price-lists');
  const list=await lists.upload(db,ctx,{buffer:Buffer.from('Supplier SKU,Pack price,Currency,Pack size\nVENDOR-A,12.00,USD,6\n'),filename:'prices.csv',supplierId:'fixture-supplier'});
  await lists.run({workspaceId:ws,payload:{sourceId:list.id}},db);

  // Growth, Pro and Custom alert on their own. With no owner settings any
  // cost rise alerts: the purchase cost rose 25%, the received cost 20%.
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    await check();
    assert.deepEqual(await open(),['Purchase cost increased','Received cost increased','Supplier price increased'],tier);
    const shown=await notice();
    assert.equal(shown.title,'Costs went up or margins fell');assert.equal(shown.happened,'3 cost or margin alerts.');
    assert.match((await browser.get('/needs-you').expect(200)).text,/Costs went up or margins fell/);
    const page=await browser.get(cost.path).expect(200);
    assert.match(page.text,/Received cost increased/);assert.match(page.text,/How you get these alerts/);assert.match(page.text,/Alert when a cost goes up by at least/);
  }
  let found=await rows();
  const received=found.find(r=>r.Alert==='Received cost increased');
  assert.deepEqual([received.Cost,received['Previous cost'],received['Gross margin %']],['$1.20','$1.00','']);assert.match(received.Details,/^Up 20% · Receipt on PO-/);
  const supplier=found.find(r=>r.Alert==='Supplier price increased');
  assert.deepEqual([supplier['Applies to'],supplier.Cost],[code,'$2.00']);
  assert.ok(['$1.00','$1.20'].includes(supplier['Previous cost'])&&Number(/^Up ([\d.]+)%/.exec(supplier.Details)[1])>60,'Compared with the trusted earlier price.');
  assert.match(supplier.Details,/Price list prices\.csv from Fixture parts/);
  assert.equal(await audits('Alerts updated'),1,'The first check raised the alerts once, whatever the plan.');

  // Replays change nothing.
  await check();await check();
  assert.equal(await audits('Alerts updated'),1);
  assert.equal(await count('SELECT count(*) FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND job_id=170'),3);

  // The freight lands on the receipt: $1.20 plus $0.30 a unit is up 50%.
  await subscribe('pro');
  await landed.apply(db,ctx,(await landed.build(db,ctx,{id:draft.id})).payload);
  await check();
  found=await rows();
  const landedRow=found.find(r=>r.Alert==='Received cost increased');
  assert.equal(landedRow.Cost,'$1.50');assert.match(landedRow.Details,/^Up 50% · Receipt on .+, with freight and duty$/);
  // One unit sold at $1.30 through a direct order.
  const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:130}]});
  await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:1}]});

  // The owner's thresholds: a rise of 30% or more, a gross margin of 45%.
  // The item sells at $2.50 and its newest cost is $1.50: 40% gross margin.
  // The one sale at $1.30 made a low margin for its category and channel.
  await assert.rejects(watches.save(db,ctx,170,{costRisePct:'0',revision:0}),e=>e.code==='validation_error');
  await assert.rejects(watches.save(db,ctx,170,{marginPct:'101',revision:0}),e=>e.code==='validation_error');
  await settings({costRisePct:'30',marginPct:'45'});
  assert.equal(await audits('Alert settings saved'),1);
  assert.deepEqual(await open(),['Below your gross margin','Category below your gross margin','Channel below your gross margin','Received cost increased','Supplier price increased'],
    'Saving checks again at once; the 25% purchase cost rise clears.');
  found=await rows();
  const item=found.find(r=>r.Alert==='Below your gross margin');
  assert.deepEqual([item.Cost,Number(item['Gross margin %'])],['$1.50',40]);assert.match(item.Details,/^Sells at \$2\.50 · your minimum 45% · Receipt on /);
  const category=found.find(r=>r.Alert==='Category below your gross margin'),channel=found.find(r=>r.Alert==='Channel below your gross margin');
  assert.equal(category['Applies to'],'Tools');assert.equal(channel['Applies to'],'Direct');
  assert.match(category.Details,/^\$1\.30 net sales, \$1\.\d\d cost of goods, last 30 days · your minimum 45%$/);assert.ok(Number(category['Gross margin %'])>0&&Number(category['Gross margin %'])<45);
  assert.equal((await reviews.run(db,ctx,cost.key,{filter:'Tools'})).rows.length,1);

  // A cost in another currency is never compared with a dollar cost or price.
  await pricing.setPurchaseCost(db,ctx,{skuId:sku,currency:'EUR',amountMinor:500});
  await check();
  assert.deepEqual(await open(),['Category below your gross margin','Channel below your gross margin','Received cost increased','Supplier price increased']);

  // Email: one message to the owner from the chosen mailbox.
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  await alerts.configure(db,ctx,170,{mailbox:connector});
  await check();
  const batches=async()=>(await db.query(`SELECT DISTINCT email_communication_id AS id FROM stockchief_runtime.agent_alert_deliveries
    WHERE workspace_id=$1 AND job_id=170 AND email_communication_id IS NOT NULL ORDER BY 1`,[ws])).rows.map(r=>r.id);
  let emails=await batches();
  assert.equal(emails.length,1);assert.equal(await audits('Alert email queued'),1);
  const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  await mail.executeSendEffect(db,ws,await effect(emails[0]),{provider});
  assert.equal(sent.length,1);assert.equal(sent[0].recipient,f.email);assert.equal(sent[0].subject,'4 cost and margin alerts');
  assert.match(sent[0].body,/gross margins, before fees and shipping/);
  assert.match(sent[0].body,/- Received cost increased: .+ from \$1\.00 to \$1\.50 \(up 50%\)\. Receipt on .+, with freight and duty\./);
  assert.match(sent[0].body,/- Category below your gross margin: Tools made .+% gross margin on \$1\.30 of net sales in the last 30 days\. Your minimum is 45%\./);
  assert.match(sent[0].body,/- Supplier price increased: .+ from \$1\.[02]0 to \$2\.00 \(up .+%\)\. Price list prices\.csv from Fixture parts\./);
  await check();assert.equal(await audits('Alert email queued'),1,'Replays never email again.');

  // Pause, Watch only and Ask me first hold the email, never the alert;
  // the first 14 days hold it too.
  const raise=async amountMinor=>{await pricing.setPurchaseCost(db,ctx,{skuId:sku,currency:'EUR',amountMinor});await check();return alerts.panel(db,ctx,170);};
  await autopilot.pause(db,ctx,{role:'owner'},'Stock count');
  let panel=await raise(800);
  assert.ok((await open()).includes('Purchase cost increased'));assert.equal(panel.waiting,1);assert.match(panel.note,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});await check();
  assert.equal((await alerts.panel(db,ctx,170)).waiting,0,'The waiting alert is emailed once StockChief may act again.');
  await modes.save(db,ctx,170,{mode:'watch',revision:0});
  panel=await raise(1200);assert.match(panel.note,/Watch only/);assert.equal(panel.canSendNow,false);
  await assert.rejects(alerts.sendNow(db,ctx,170),/Watch only/);
  await modes.save(db,ctx,170,{mode:'ask',revision:1});
  panel=await raise(1800);assert.match(panel.note,/Ask me first/);assert.equal(panel.canSendNow,true);
  await alerts.sendNow(db,ctx,170);assert.equal((await alerts.panel(db,ctx,170)).waiting,0);
  await modes.save(db,ctx,170,{mode:'inherit',revision:2});
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  panel=await raise(2700);assert.match(panel.note,/first 14 days/);assert.equal(panel.canSendNow,false);
  assert.ok((await open()).includes('Purchase cost increased'),'Shadow mode still shows the alert.');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  // Higher thresholds clear every alert.
  await settings({costRisePct:'150',marginPct:'10'});
  assert.deepEqual(await open(),[]);
  assert.equal(await notice(),undefined);
  assert.equal((await alerts.panel(db,ctx,170)).waiting,0);
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===170).allowed,['inherit','watch','ask','routine']);

  // Downgrading to Starter hides the alerts and stops email.
  await settings({costRisePct:'',marginPct:'45'});
  assert.ok((await open()).length>0);
  await subscribe('starter');
  assert.equal(await notice(),undefined);
  await browser.get(cost.path).expect(402);

  // The page reads well on a desktop and on a 390 px phone.
  await subscribe('growth');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+cost.path);
    assert(await tab.getByRole('heading',{name:'Cost and margin alerts',exact:true}).isVisible());
    assert(await tab.getByRole('heading',{name:'How you get these alerts'}).isVisible());
    assert(await tab.getByLabel('Alert when a cost goes up by at least (%)').isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'cost-alerts-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});

// Code on the routine check runs on databases migrated only part of the way.
test('the routine check and Needs you keep working before migration 473',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:2,through:'462-agent-carrier-claim-follow-through.sql'}),{db,ctx,subscribe}=f;
  await subscribe('pro');
  await require('../../src/pricing/postgres-service').setPurchaseCost(db,ctx,{skuId:f.item.skuIds[0],currency:'USD',amountMinor:300});
  await db.transaction(c=>require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate({id:randomUUID(),workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  assert.ok(Array.isArray(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)));
  const page=await require('../../src/autopilot/job-reviews').run(db,ctx,'cost-alerts',{});
  assert.match(page.summary,/being upgraded/);
});
