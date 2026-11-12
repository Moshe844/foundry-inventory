'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 197 is excluded on Starter, drafts on Growth and runs alone on Pro and
// Custom. A report is built only from recorded data: lot traceability,
// recalls, expiry write-offs, stock adjustments, stocktake sign-off and
// quality checks. It freezes what it found and downloads as Excel or PDF.
// Growth drafts for a person to finalize; Pro and Custom produce reports on
// the owner's schedule, unless a fact is missing or StockChief may not act.
test('compliance reports are drafted on Growth, produced on a schedule on Pro and Custom, and stop when facts are missing',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4}),{db,ctx,browser,subscribe,location,workflows,csrf}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const inventory=require('../../src/domain/postgres-inventory-engine'),removal=require('../../src/accounting/postgres-stock-removal');
  const reports=require('../../src/reports/agent-compliance-reports'),controls=require('../../src/autopilot/lot-controls');
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),needs=require('../../src/projections/postgres-service');
  const XLSX=require('xlsx');
  const today=await require('../../src/lib/business-time').today(db,ws),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const audits=action=>db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action]).then(r=>r.rows[0].n);
  const binary=(res,cb)=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>cb(null,Buffer.concat(chunks)));};
  const fixtureSku=f.item.skuIds[0];

  // Records in the period: a batch received, sold, recalled and an expired
  // batch written off; a count correction, a damaged write-off and an
  // approved count.
  const BOLT=(await catalog.createItem(db,ctx,{name:'Bolt pack',baseCode:'BOLT',trackingMode:'quantity',purchaseCost:'1'})).skuIds[0];
  await receipt.receive(db,ctx,{skuId:BOLT,locationId:location.id,quantity:4,unitCost:'1',idempotencyKey:randomUUID()});
  const VAX=(await catalog.createItem(db,ctx,{name:'Vaccine kit',baseCode:'VAX',trackingMode:'lot',purchaseCost:'3'})).skuIds[0];
  await receipt.receive(db,ctx,{skuId:VAX,locationId:location.id,lotCode:'V-GOOD',expiresAt:day(100),lotReceivedAt:day(-5),quantity:5,idempotencyKey:randomUUID()});
  await receipt.receive(db,ctx,{skuId:VAX,locationId:location.id,lotCode:'V-OLD',expiresAt:day(-2),lotReceivedAt:day(-30),quantity:1,idempotencyKey:randomUUID()});
  const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,idempotencyKey:randomUUID(),
    lines:[{skuId:VAX,quantity:2,unitPriceMinor:900}]});
  await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
  await workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:sale.lineIds[0],locationId:location.id,quantity:2}]});
  await removal.issue(db,ctx,{skuId:VAX,locationId:location.id,quantity:1,lotCode:'V-OLD',reasonCode:'expired',notes:'Past date on shelf',idempotencyKey:randomUUID()});
  await removal.issue(db,ctx,{skuId:BOLT,locationId:location.id,quantity:1,reasonCode:'damaged',notes:'Crushed carton',idempotencyKey:randomUUID()});
  const counts=require('../../src/operations/postgres-count-reviews'),count=await counts.prepare(db,ctx,{locationId:location.id,lines:[{skuId:BOLT,quantity:'2'}]});
  await counts.approve(db,ctx,count.id,(await counts.get(db,ctx,count.id)).integrity_hash);
  const span={from:day(-1),to:today};

  // No plan, then Starter: the job is locked.
  assert.equal((await reports.run({workspaceId:ws,payload:{}},db)).skipped,true);
  await subscribe('starter');
  assert.match((await browser.get(reports.path).expect(200)).text,/data-agent-plan-locked/);
  await assert.rejects(reports.prepare(db,ctx,{...span,requestKey:randomUUID()}),e=>e.code==='entitlement_required');
  assert.deepEqual(await reports.inbox(db,ws),[]);

  // Growth, in its first 14 days: a recall, then a draft for a person to finalize.
  await subscribe('growth');
  await controls.recall(db,ctx,{sku:'VAX',lot:'V-GOOD',action:'hold',revision:0,reason:'Supplier cold-chain failure'});
  await assert.rejects(reports.prepare(db,ctx,{from:today,to:day(-1),requestKey:randomUUID()}),/end date comes before/);
  await assert.rejects(reports.prepare(db,ctx,{from:day(-400),to:today,requestKey:randomUUID()}),/up to one year/);
  await assert.rejects(reports.prepare(db,ctx,{from:'2026-02-30',to:today,requestKey:randomUUID()}),/start and an end date/);
  const list=await browser.get(reports.path).expect(200);
  const made=await browser.post(reports.path).type('form').send({_csrf:csrf(list.text),requestKey:'growth-report',...span}).expect(303);
  const id=made.headers.location.split('/').at(-1);
  let r=await reports.load(db,ctx,id);
  assert.equal(r.status,'DRAFT');assert.equal(r.reason,'A person finalizes each report on this plan.');assert.equal(r.gaps,0);
  const sectionRows=key=>r.content.sections.find(s=>s.key===key).rows;
  const details=key=>sectionRows(key).map(x=>x.Detail);
  assert.deepEqual(r.content.sections.map(s=>s.label),['Lot traceability','Recalls','Expiry write-offs','Stock adjustments','Stocktake sign-off','Quality checks']);
  assert.deepEqual(details('traceability').sort(),['Received','Received','Shipped to Receiver','Taken out: expired'].sort());
  assert.equal(sectionRows('traceability').find(x=>x.Detail==='Shipped to Receiver').Reference,sale.orderNumber);
  assert.deepEqual(details('recalls'),['Recall placed: Supplier cold-chain failure','Received by Receiver (sale)']);
  assert.equal(sectionRows('recalls')[0].Person,'Owner');
  assert.match(details('expiry')[0],/^Written off \(expired\), expired on .*\. Past date on shelf$/);
  assert(details('adjustments').some(d=>/^Counted 2, expected 3. Reason: /.test(d)),details('adjustments').join(' | '));
  assert(details('adjustments').includes('Taken out. Reason: damaged. Crushed carton'));
  assert.deepEqual(details('stocktake'),['Count approved: 1 line']);
  assert.equal(r.content.sections.find(s=>s.key==='quality').note,'StockChief keeps no temperature log. Quality checks come from delivery inspections.');
  assert.equal(await audits('Compliance report drafted'),1);
  // Replaying the same request returns the same report.
  assert.equal((await reports.prepare(db,ctx,{...span,requestKey:'growth-report'})).replayed,true);
  assert.match((await browser.get('/autopilot/reviews/recall-audit').expect(200)).text,/href="\/autopilot\/compliance-reports"/);
  const [notice]=await reports.inbox(db,ws);assert.equal(notice.href,reports.path+'/'+id);
  assert((await needs.needs(db,ws,ctx.actorId)).some(n=>n.sourceId==='compliance-reports'));

  // The draft downloads as Excel and PDF, marked as a draft.
  const sheet=await browser.get(reports.path+'/'+id+'/download?format=xlsx').buffer(true).parse(binary).expect(200);
  assert.match(sheet.headers['content-disposition'],/-draft\.xlsx/);
  const book=XLSX.read(sheet.body);
  assert.deepEqual(book.SheetNames,['Summary','Lot traceability','Recalls','Expiry write-offs','Stock adjustments','Stocktake sign-off','Quality checks']);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Recalls)[0].Detail,'Recall placed: Supplier cold-chain failure');
  const printed=await browser.get(reports.path+'/'+id+'/download?format=pdf').buffer(true).parse(binary).expect(200);
  assert.equal(printed.headers['content-type'],'application/pdf');assert.equal(printed.body.subarray(0,4).toString(),'%PDF');
  await assert.rejects(reports.download(db,ctx,id,'csv'),/Excel or PDF/);

  // A later record does not change the frozen report; finalizing needs the reviewed version.
  await inventory.issue(db,ctx,{skuId:BOLT,locationId:location.id,quantity:1,reasonCode:'damaged',idempotencyKey:randomUUID()});
  assert.equal((await reports.load(db,ctx,id)).content_hash,r.content_hash);
  await assert.rejects(reports.finalize(db,ctx,id,{confirmed:'yes',hash:'old'}),/Review this report/);
  const page=await browser.get(reports.path+'/'+id).expect(200);
  assert.match(page.text,/Supplier cold-chain failure/);assert.match(page.text,/Finalize the report/);
  await browser.post(reports.path+'/'+id+'/finalize').type('form').send({_csrf:csrf(page.text),hash:r.content_hash,confirmed:'yes'}).expect(303);
  r=await reports.load(db,ctx,id);
  assert.equal(r.status,'FINAL');assert.equal(r.finalized_by,ctx.actorId);assert.equal(await audits('Compliance report finalized'),1);
  assert.equal((await reports.finalize(db,ctx,id,{confirmed:'yes',hash:r.content_hash})).replayed,true);
  await assert.rejects(reports.discard(db,ctx,id,{confirmed:'yes'}),/kept as it is/);
  assert.deepEqual(await reports.inbox(db,ws),[]);

  // Growth schedules still give drafts.
  await reports.configure(db,ctx,{frequency:'monthly'});
  assert.equal(await audits('Compliance report schedule saved'),1);
  const scheduled=await reports.run({workspaceId:ws,payload:{day:today}},db);
  r=await reports.load(db,ctx,scheduled.id);
  assert.deepEqual([r.status,r.scheduled,r.automatic,r.reason],['DRAFT',true,false,'A person finalizes each report on this plan.']);
  assert.deepEqual([r.period_start,r.period_end],[reports.lastPeriod('MONTHLY',today).start,reports.lastPeriod('MONTHLY',today).end]);
  assert.equal((await reports.run({workspaceId:ws,payload:{day:today}},db)).replayed,true);
  await reports.discard(db,ctx,scheduled.id,{confirmed:'yes'});
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===197).allowed,['inherit','watch','ask']);

  // Pro: weekly reports are produced alone, except when StockChief may not act.
  await subscribe('pro');
  await reports.configure(db,ctx,{frequency:'WEEKLY'});
  const weekly=async n=>reports.load(db,ctx,(await reports.run({workspaceId:ws,payload:{day:day(n)}},db)).id);
  r=await weekly(0);
  assert.equal(r.status,'DRAFT');assert.match(r.reason,/watching during the first 14 days/);assert.equal(r.would_finalize,true);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  r=await weekly(-7);assert.equal(r.reason,'Handle routine work is off for this inventory.');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await autopilot.pause(db,ctx,{role:'owner'},'Year end');
  r=await weekly(-14);assert.match(r.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await modes.save(db,ctx,197,{mode:'ask',revision:0});
  r=await weekly(-21);assert.match(r.reason,/Ask me first/);
  await modes.save(db,ctx,197,{mode:'inherit',revision:1});
  r=await weekly(-28);
  assert.deepEqual([r.status,r.automatic,r.scheduled,r.finalized_by],['FINAL',true,true,null]);
  assert.equal(await audits('Compliance report produced on its own'),1);
  assert.equal((await reports.run({workspaceId:ws,payload:{day:day(-28)}},db)).replayed,true);
  assert.equal(await audits('Compliance report produced on its own'),1);

  // Pro, by hand: final at once, unless a stock removal has no reason.
  const quick=await reports.prepare(db,ctx,{...span,requestKey:randomUUID()});
  assert.equal(quick.status,'FINAL');
  await inventory.issue(db,ctx,{skuId:VAX,locationId:location.id,quantity:1,lotCode:'V-GOOD',reasonCode:'damaged',idempotencyKey:randomUUID()});
  await inventory.issue(db,ctx,{skuId:BOLT,locationId:location.id,quantity:1,idempotencyKey:randomUUID()});
  const asked=await reports.prepare(db,ctx,{...span,requestKey:randomUUID()});
  r=await reports.load(db,ctx,asked.id);
  assert.equal(r.status,'DRAFT');assert.equal(r.gaps,1);assert.match(r.content.gaps[0],/1 stock removal has no recorded reason/);
  assert(r.content.sections.find(s=>s.key==='adjustments').rows.some(x=>x.Detail==='Taken out with no recorded reason'));
  assert.match((await browser.get(reports.path+'/'+asked.id).expect(200)).text,/no recorded reason/);

  // Quality checks appear once a delivery inspection is recorded.
  const quality=require('../../src/operations/agent-quality-holds');
  await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,last_unit_cost,minimum_order_quantity,order_multiple,created_at,updated_at)
    VALUES($1,$2,'fixture-supplier',$3,1,1,1,now()::text,now()::text) ON CONFLICT(workspace_id,supplier_id,sku_id) DO NOTHING`,[randomUUID(),ws,fixtureSku]);
  await quality.save(db,ctx,{supplierName:'Fixture parts',checklist:['Check seals','Count cartons'],maxUnits:20,confirmed:'yes'});
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:fixtureSku,quantityUnits:2,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const got=await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:2,locationId:location.id}]});
  // A suggested hold is put on by the owner, then inspected.
  const holdId=got.qualityHoldIds?.[0]||got.qualitySuggestionIds[0];
  if(!got.qualityHoldIds?.length)await quality.decide(db,ctx,holdId,{revision:1,decision:'hold'});
  await quality.inspect(db,ctx,holdId,{revision:got.qualityHoldIds?.length?1:2,decision:'PASS',physicallyChecked:'yes',checks:['0','1']});

  // Custom produces its schedule alone too.
  await subscribe('enterprise');
  r=await weekly(-35);assert.equal(r.status,'FINAL');assert.equal(r.automatic,true);
  const withQuality=await reports.load(db,ctx,(await reports.prepare(db,ctx,{...span,requestKey:randomUUID()})).id);
  assert.match(withQuality.content.sections.find(s=>s.key==='quality').rows[0].Detail,/^Inspection passed/);
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===197).allowed,['inherit','watch','ask','routine']);
  await reports.configure(db,ctx,{stop:'yes'});
  assert.equal((await reports.run({workspaceId:ws,payload:{day:day(-42)}},db)).skipped,true);
  const stranger=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Another inventory',
    email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
  await assert.rejects(reports.load(db,{workspaceId:stranger.workspaceId,actorId:stranger.userId},id),/not in this inventory/);
  await assert.rejects(reports.page(db,{workspaceId:ws,actorId:stranger.userId}),/owner/);

  // The pages read well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(done=>server.close(done));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+reports.path);
    assert(await tab.getByRole('heading',{name:'Compliance reports',exact:true}).isVisible());
    assert(await tab.getByRole('button',{name:'Prepare a report'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' list must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'compliance-reports-'+name+'.png'),fullPage:true});
    await tab.goto(base+reports.path+'/'+asked.id);
    assert(await tab.getByRole('button',{name:'Finalize the report'}).isVisible());
    assert(await tab.getByRole('link',{name:'Download Excel'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' report must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'compliance-report-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
