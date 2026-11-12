'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const roi=require('../../src/reports/agent-roi-report');
const reportRuns=require('../../src/reports/agent-report-runs');

// Job 161: the monthly ROI report. Hours saved come from finished agent work
// times the owner's timings or the standard minutes; money caught comes only
// from records; both are compared with the plan price, currency by currency.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx}=f,ws=ctx.workspaceId,w=f.workflows;
  const time=require('../../src/lib/business-time'),zone='America/New_York';
  await db.query('UPDATE workspaces SET time_zone=$2,created_at=(now()-interval \'70 days\')::text WHERE id=$1',[ws,zone]);
  const today=await time.today(db,ws),month=reportRuns.lastCompleted(today);
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,reportRuns.addMonths(month,-1)+'-01']);
  await f.subscribe('starter');
  const at=(day,hour=12)=>time.wall(month+'-'+String(day).padStart(2,'0'),hour,0,zone).toISOString();
  const date=day=>month+'-'+String(day).padStart(2,'0');
  const skuId=f.item.skuIds[0],po=(await db.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 ORDER BY created_at LIMIT 1',[ws])).rows[0];
  const line=(await db.query('SELECT * FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',[ws,po.id])).rows[0];
  const receiptLine=(await db.query('SELECT id FROM purchase_order_receipt_lines WHERE workspace_id=$1 LIMIT 1',[ws])).rows[0];

  // Hours: two staff purchase requests approved in the month (the owner timed
  // eight minutes by hand and two to check) and one before it; three supplier
  // link responses with no timing, so they use the standard three minutes.
  for(const [day,inMonth] of [[4,true],[9,true],[null,false]]){
    const draft=await w.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:1,unitCost:1}]});
    await db.query(`INSERT INTO stockchief_runtime.purchase_requests(id,workspace_id,requested_by,request_key,sku_id,location_id,quantity,reason,status,decided_by,purchase_order_id,decided_at)
      VALUES($1,$2,$3,$1,$4,$5,1,'Tape is low','APPROVED',$3,$6,$7)`,[randomUUID(),ws,ctx.actorId,skuId,f.location.id,draft.purchaseOrderId,inMonth?at(day):reportRuns.addMonths(month,-1)+'-15T12:00:00Z']);
  }
  await require('../../src/autopilot/time-saved').sample(db,ctx,{activity:'staff-request',manualMinutes:'8',reviewMinutes:'2',requestKey:randomUUID()});
  const token=randomUUID();
  await db.query(`INSERT INTO stockchief_runtime.supplier_order_links(token_hash,workspace_id,purchase_order_id,recipient,expires_at) VALUES($1,$2,$3,'parts@example.test',now()+interval '30 days')`,[token,ws,po.id]);
  for(const [kind,day] of [['confirm',3],['date',5],['ship-notice',7]])await db.query(`INSERT INTO stockchief_runtime.supplier_link_submissions(id,workspace_id,token_hash,kind,fingerprint,created_at)
    VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),ws,token,kind,randomUUID(),at(day)]);

  // Money: a posted supplier bill and credits against it, each linked to what it settled.
  const bill=await w.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:po.id,supplierInvoiceNumber:'INV-'+randomUUID().slice(0,8),issueDate:date(2),
    dueDate:date(28),currency:'USD',lines:[{purchaseOrderLineId:line.id,quantity:40,unitCostMinor:100}],documentTotalMinor:4000,idempotencyKey:randomUUID()});
  assert.equal(bill.status,'OPEN',JSON.stringify(bill));
  const credit=(amountMinor,number,day=15)=>db.transaction(async c=>{const row=(await c.query('SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ws,bill.billId])).rows[0];
    return require('../../src/accounting/postgres-supplier-credits').applySourceCredit(c,ctx,row,{amountMinor,taxMinor:0,creditNumber:number,creditDate:date(day),postingDate:date(day),originalBillId:row.id,sourceHash:randomUUID(),sourceKey:'roi-test:'+randomUUID(),reason:'Fixture'});});
  const rebate=await credit(100,'CN-REBATE'),claim=await credit(200,'CN-CLAIM'),dispute=await credit(150,'CN-DISPUTE'),note=await credit(75,'CN-NOTE');
  await credit(500,'CN-OWNER');// recorded by the owner with nothing behind it: not counted
  const program=randomUUID(),rebateClaim=randomUUID();
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_benefit_programs(id,workspace_id,supplier_id,title,source_reference,currency,starts_on,ends_on,scope,terms,authorized_by)
    VALUES($1,$2,'fixture-supplier','Rebate','Letter','USD',$3,$3,'{}','{}',$4)`,[program,ws,date(1),ctx.actorId]);
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_benefit_claims(id,workspace_id,program_id,request_key,source_fingerprint,source_snapshot,amount_minor,external_reference,submitted_on,recorded_by)
    VALUES($1,$2,$3,$1,'x','{}',100,'REB-1',$4,$5)`,[rebateClaim,ws,program,date(2),ctx.actorId]);
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_benefit_claim_credits(credit_id,claim_id,workspace_id,amount_minor,automatic,linked_by) VALUES($1,$2,$3,100,true,$4)`,[rebate.supplierCreditId,rebateClaim,ws,ctx.actorId]);
  const damage=randomUUID(),supplierClaim=randomUUID();
  await db.query(`INSERT INTO stockchief_runtime.agent_receipt_damage_reports(id,workspace_id,receipt_line_id,quantity,note,removal_key,reported_by) VALUES($1,$2,$3,1,'Crushed box',$1,$4)`,[damage,ws,receiptLine.id,ctx.actorId]);
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_claims(id,workspace_id,damage_report_id,reference,prepared_by,snapshot,source_fingerprint) VALUES($1,$2,$3,'CLM-1',$4,'{"currency":"USD"}','x')`,[supplierClaim,ws,damage,ctx.actorId]);
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_claim_settlements(id,workspace_id,claim_id,credit_id,linked_by) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),ws,supplierClaim,claim.supplierCreditId,ctx.actorId]);
  await db.query(`INSERT INTO stockchief_runtime.agent_invoice_dispute_work(id,workspace_id,result) VALUES($1,$2,$3)`,[randomUUID(),ws,JSON.stringify({status:'RESOLVED',resolution:'CREDIT',supplierCreditId:dispute.supplierCreditId})]);
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_credit_applications(credit_id,workspace_id,source_hash,source_number,approval_fingerprint,tax_minor,evidence) VALUES($1,$2,'x','CN-NOTE',$3,0,'{}')`,[note.supplierCreditId,ws,randomUUID()]);
  // A disputed invoice billed above the agreed price, replaced by the supplier's corrected one.
  const rawBill=async({status,total,currency='USD',number,detail={},created})=>{const id=randomUUID();await db.query(`INSERT INTO accounting_supplier_bills(id,workspace_id,bill_number,supplier_id,supplier_invoice_number,issue_date,status,currency,subtotal_minor,total_minor,balance_minor,source_key,exception_detail,created_at,updated_at)
    VALUES($1,$2,$1,'fixture-supplier',$3,$4,$5,$6,$7,$7,$7,$1,$8,$9,$9)`,[id,ws,number,date(10),status,currency,total,JSON.stringify(detail),created]);return id;};
  const disputed=await rawBill({status:'VOID',total:1200,number:'INV-HIGH',detail:{differences:[{kind:'price_outside_approved_cost',line:1}]},created:at(10)});
  const corrected=await rawBill({status:'OPEN',total:1000,number:'INV-HIGH-C',created:at(14)});
  await db.query(`INSERT INTO stockchief_runtime.agent_invoice_dispute_work(id,workspace_id,bill_id,replacement_bill_id,result) VALUES($1,$2,$3,$4,'{"status":"RESOLVED"}')`,[randomUUID(),ws,disputed,corrected]);
  // The same euro invoice arriving twice: stopped once, counted once.
  const euro=await rawBill({status:'OPEN',total:2000,currency:'EUR',number:'EU-1',created:at(11)});
  for(const day of [12,13]){const upload=randomUUID();
    await db.query(`INSERT INTO stockchief_runtime.agent_supplier_invoice_uploads(id,workspace_id,owner_id,supplier_id,purchase_order_id,filename,content,content_hash) VALUES($1,$2,$3,'fixture-supplier',$4,'eu.pdf','x',$1)`,[upload,ws,ctx.actorId,po.id]);
    await db.query(`INSERT INTO stockchief_runtime.agent_supplier_invoice_intakes(id,workspace_id,source_upload_id,source_hash,source_text_hash,supplier_id,purchase_order_id,invoice_number,status,duplicate_bill_id,created_at)
      VALUES($1,$2,$3,'h','t','fixture-supplier',$4,'EU-1','DUPLICATE',$5,$6)`,[randomUUID(),ws,upload,po.id,euro,at(day)]);}
  // Freight saved by a combined order that was placed.
  const combined=await w.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:2,unitCost:1}]});
  await w.approvePurchaseOrder(db,ctx,combined.purchaseOrderId,{idempotencyKey:randomUUID()});await w.placePurchaseOrder(db,ctx,combined.purchaseOrderId,{idempotencyKey:randomUUID()});
  await db.query(`UPDATE purchase_orders SET ordered_at=$3,source_detail=$4 WHERE workspace_id=$1 AND id=$2`,[ws,combined.purchaseOrderId,at(16),
    JSON.stringify({sourcePurchaseOrderIds:['a','b'],freightConsolidation:{currency:'USD',beforeMinor:1200,afterMinor:800,savedMinor:400}})]);
  // A stock-out avoided at West: two left when StockChief's order of five
  // arrived, then four sold at $3 before the next delivery.
  const west=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'West',kind:'warehouse',address:'9 West St, Albany, NY 12207'});
  const receive=async(units,day,agent)=>{const key=randomUUID(),order=await w.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:west.id,idempotencyKey:key,lines:[{skuId,quantityUnits:units,unitCost:1}]});
    await w.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:key+'-a'});await w.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:key+'-p'});
    await w.receivePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:key+'-r',receivedAt:at(day),lines:[{lineId:order.lineIds[0],quantity:units,locationId:west.id}]});
    if(agent)await db.query(`INSERT INTO work_items(id,workspace_id,category,source,approval_requirement,execution_status,verification_status,purchase_order_id,idempotency_key,created_at,completed_at)
      VALUES($1,$2,'replenishment_plan','postgres_autopilot','REQUIRED','COMPLETED','VERIFIED',$3,$1,$4,$4)`,[randomUUID(),ws,order.purchaseOrderId,at(day)]);
    return order;};
  await receive(2,3,false);const agentOrder=await receive(5,10,true);
  const sale=await w.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:west.id,idempotencyKey:randomUUID(),lines:[{skuId,quantity:4,unitPriceMinor:300}]});
  await w.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
  await w.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),fulfilledAt:at(12),lines:[{lineId:sale.lineIds[0],quantity:4,locationId:west.id}]});

  const handler=require('../../src/operations/postgres-runtime-handlers').create()[roi.KIND];
  const worker=async()=>{const queued=await roi.schedule(db,ws);const job=(await db.query('SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1',[ws,roi.KIND])).rows[0];
    return {queued,result:await handler({workspaceId:ws,payload:job?.payload||{}},db)};};
  const runs=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_report_runs WHERE workspace_id=$1 AND job_id=161 ORDER BY created_at,id',[ws])).rows;
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('agent-report'));
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const emails=async()=>(await db.query("SELECT id FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='system.email-send' AND idempotency_key LIKE 'roi-report-email:%'",[ws])).rows;
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const older=()=>db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  return {...f,ws,today,month,zone,handler,worker,runs,needs,audits,emails,pilot,older,agentOrder,west};
}

test('Hours come from finished work and the owner\'s minutes, money only from records, and the report reaches every plan on its own',{timeout:900000},async t=>{
  const priorKey=process.env.RESEND_API_KEY,priorFrom=process.env.FOUNDRY_FROM_EMAIL;
  process.env.RESEND_API_KEY='re_test_fixture';process.env.FOUNDRY_FROM_EMAIL='StockChief <reports@example.test>';
  t.after(()=>{if(priorKey===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=priorKey;
    if(priorFrom===undefined)delete process.env.FOUNDRY_FROM_EMAIL;else process.env.FOUNDRY_FROM_EMAIL=priorFrom;});
  const f=await setup(t),{db,ctx,ws,month}=f;
  const journals=async()=>Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ws])).rows[0].n);
  const before=await journals();

  const r=await roi.compute(db,ws,{month});
  assert.deepEqual(r.tasks.map(x=>[x.key,x.count,x.basis,x.minutesEach,x.minutes]),[['supplier-response',3,'standard',3,9],['staff-request',2,'timed',6,12]]);
  assert.deepEqual([r.measuredHours,r.estimatedHours,r.hours],[0.2,0.2,0.4]);
  const kinds=c=>Object.fromEntries(r.totals.find(x=>x.currency===c).kinds.map(k=>[k.kind,k.amount]));
  assert.deepEqual(kinds('USD'),{claim:200,dispute:150,'credit-note':75,rebate:100,'price-increase':200,freight:400,stockout:600});
  assert.deepEqual(kinds('EUR'),{duplicate:2000},'The second copy of the same invoice is not counted again');
  const usd=r.totals.find(x=>x.currency==='USD'),eur=r.totals.find(x=>x.currency==='EUR');
  assert.deepEqual([usd.amount,usd.comparable,usd.timesPlan,eur.comparable,eur.timesPlan],[1725,true,0.09,false,null]);
  assert.deepEqual(r.plan,{plan:'Starter',currency:'USD',monthly:19900,annual:false});
  assert.equal(r.pricePerHour,Math.round(19900*60/21));
  assert.deepEqual(r.stockouts.map(s=>[s.code.startsWith('PARCEL'),s.location,s.before,s.sold,s.units,s.amount]),[[true,'West',2,4,2,600]]);
  assert(!r.items.some(i=>/CN-OWNER/.test(i.record)),'A credit with nothing behind it is not counted');
  assert.match(roi.headline(r),/saving about 0\.4 hours \(0\.2 from your own timings, 0\.2 from standard estimates\)/);
  assert.match(roi.headline(r),/caught \$17\.25 against your \$199\.00 plan price \(0\.09 times the price\)/);
  assert.match(roi.headline(r),/€20\.00, not compared with the plan price/);
  assert.equal(Object.keys(roi.STANDARD_MINUTES).sort().join(),[...require('../../src/autopilot/time-saved').activities.keys()].sort().join(),'Every task has a stated standard');

  // Every plan reads it on its own, in Ask and on the page.
  const reviews=require('../../src/autopilot/job-reviews');
  for(const tier of ['starter','growth','pro','enterprise']){
    await f.subscribe(tier);
    const review=await reviews.run(db,ctx,'roi-report',{filter:month});
    assert.equal(review.mode,'alone',tier);
    assert(review.rows.some(row=>row.Part==='$ caught'&&row.What==='Stock-outs avoided'&&row.Value==='$6.00'),tier);
    assert(review.rows.some(row=>row.Part==='Hours saved'&&/Standard estimate: 3 min/.test(row.Basis)),tier);
    const page=await f.browser.get(roi.href).query({month}).expect(200);
    for(const text of ['Monthly ROI report','$17.25','€20.00','Stock-outs avoided','Standard estimate','Download Excel'])assert(page.text.includes(text),tier+' '+text);
  }
  await assert.rejects(roi.page(db,ctx,{month:f.today.slice(0,7)}),/completed calendar month/);
  const asked=await require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review').prepare(null,db,ctx,'What did StockChief save me last month?',{agentJob:'roi-report',search:month});
  assert(asked.rows.some(row=>row.What==='Rebates credited'&&row.Value==='$1.00'));

  // Files.
  const binary=req=>req.buffer(true).parse((res,done)=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>done(null,Buffer.concat(chunks)));});
  const xlsx=require('xlsx'),book=xlsx.read((await binary(f.browser.get(roi.href+'/download').query({month,format:'xlsx'})).expect(200)).body,{type:'buffer'});
  const caught=xlsx.utils.sheet_to_json(book.Sheets['Money caught']);
  assert.equal(caught.filter(row=>row.Currency==='USD').reduce((n,row)=>n+row.Amount,0),17.25);
  assert.equal(xlsx.utils.sheet_to_json(book.Sheets['Hours saved']).find(row=>row.Task.startsWith('Create a purchase order')).Hours,0.2);
  const pdf=await binary(f.browser.get(roi.href+'/download').query({month,format:'pdf'})).expect(200).expect('Content-Type',/application\/pdf/);
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=pdfjs.getDocument({data:new Uint8Array(pdf.body)}),doc=await loading.promise;
  const text=(await (await doc.getPage(1)).getTextContent()).items.map(i=>i.str).join(' ');
  for(const figure of ['$17.25','€20.00','Stock-outs avoided'])assert(text.includes(figure),figure);
  await loading.destroy();

  // Starter makes it alone too. The first 14 days only watch: no notice, no email.
  await f.subscribe('starter');
  await db.query(`INSERT INTO notification_email_settings(workspace_id,enabled,minimum_severity,recipients,created_at,updated_at) VALUES($1,1,'important','[]',now()::text,now()::text)`,[ws]);
  let made=await f.worker();
  assert.deepEqual(made.queued,{queued:1});
  assert.equal(made.result.outcome,'WATCHED');assert.match(made.result.reason,/first 14 days/);
  assert.equal((await f.needs()).length,0);assert.equal((await f.emails()).length,0);

  // After shadow mode: made, told in Needs you, emailed once.
  await f.older();
  made=await f.worker();
  assert.equal(made.result.outcome,'PRODUCED');assert.equal(made.result.opened.length,1);assert.equal(made.result.emailed,1);
  const needs=await f.needs();
  assert.equal(needs.length,1);assert.match(needs[0].title,new RegExp('Your ROI report for '+reportRuns.monthName(month)+' is ready'));
  assert.match(needs[0].happened,/caught \$17\.25/);assert.equal(needs[0].href,roi.href+'?month='+month);
  const messages=[],mail=require('../../src/operations/postgres-runtime-handlers').create(undefined,{emailSender:async message=>{messages.push(message);return {provider:'test',externalId:'roi-'+messages.length};}});
  const delivered=await require('../../src/operations/postgres-job-queue').processOne(db,mail,{owner:'roi-email-test',kinds:['system.email-send']});
  assert.equal(delivered.status,'COMPLETED',JSON.stringify(delivered.lastError));
  assert.equal(messages.length,1);assert.equal(messages[0].to,f.email.toLowerCase());assert.match(messages[0].subject,/ROI report for/);
  assert.match(messages[0].text,/Stock-outs avoided: \$6\.00/);assert.match(messages[0].text,/standard estimate/);
  assert.equal(await f.audits('StockChief made the monthly ROI report'),2);assert.equal(await f.audits('Emailed the monthly ROI report'),1);
  // A replay of the same facts writes and sends nothing more; the schedule stops.
  const replay=await f.handler({workspaceId:ws,payload:{month}},db);
  assert.equal(replay.replayed,true);assert.equal(replay.emailed,0);assert.equal((await f.runs()).length,2);assert.equal((await f.emails()).length,1);
  assert.deepEqual(await roi.schedule(db,ws),{queued:0});

  // Pause holds it; Watch only and Ask me first make it without telling.
  await f.pilot('paused=1');
  assert.deepEqual(await f.handler({workspaceId:ws,payload:{month}},db),{held:'paused'});
  await f.pilot('paused=0');
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,161,{mode:'watch',revision:0});
  assert.match((await f.handler({workspaceId:ws,payload:{month}},db)).reason,/Watch only/);
  await assert.rejects(roi.checkNow(db,ctx,{month}),/Watch only/);
  await modes.save(db,ctx,161,{mode:'ask',revision:1});
  assert.equal((await f.handler({workspaceId:ws,payload:{month}},db)).outcome,'WATCHED');
  const kept=await roi.checkNow(db,ctx,{month});
  assert.equal(kept.outcome,'PRODUCED');assert.equal(kept.emailed,0,'A report made by hand is not emailed');
  assert.equal(await f.audits('Made the monthly ROI report'),1);
  await modes.save(db,ctx,161,{mode:'inherit',revision:2});
  // Seen notices stay quiet.
  const open=(await db.query("SELECT id FROM stockchief_runtime.agent_report_flags WHERE workspace_id=$1 AND job_id=161 AND status='OPEN'",[ws])).rows;
  await reportRuns.dismiss(db,ctx,open[0].id);
  assert.equal((await f.needs()).length,0);
  // Nothing was posted by the report.
  assert.equal(await journals(),before);
});

test('The ROI report fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t),{db,ws,month}=f;
  await f.older();
  await roi.run(db,ws,{month});
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+roi.href+'?month='+month);
    const text=await page.locator('main').innerText();
    assert.match(text,/Monthly ROI report/);assert.match(text,/Stock-outs avoided/);assert.match(text,/Your ROI report for/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/roi-report-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});
