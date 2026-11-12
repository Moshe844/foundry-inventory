'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const monthEnd=require('../../src/reports/agent-month-end-stock');
const reportRuns=require('../../src/reports/agent-report-runs');

// Job 158: month-end stock value and cost of goods, per location, rolled
// forward from the stock value records and checked against the books.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,ws=ctx.workspaceId;
  const time=require('../../src/lib/business-time'),locations=require('../../src/domain/postgres-location-service');
  const stock=require('../../src/domain/postgres-inventory-engine'),removal=require('../../src/accounting/postgres-stock-removal');
  const exact=require('../../src/domain/exact-quantity'),ledger=require('../../src/accounting/postgres-ledger'),w=f.workflows;
  const zone='America/New_York';
  await db.query('UPDATE workspaces SET time_zone=$2 WHERE id=$1',[ws,zone]);
  const today=await time.today(db,ws),month=reportRuns.lastCompleted(today),prior=reportRuns.addMonths(month,-1);
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,reportRuns.addMonths(prior,-1)+'-01']);
  await f.subscribe('growth');
  const at=(m,day,hour=12)=>time.wall(m+'-'+String(day).padStart(2,'0'),hour,0,zone).toISOString();
  const skuId=f.item.skuIds[0];
  const shelf=await locations.createLocation(db,ctx,{name:'Dispatch shelf',kind:'bin',parentLocationId:f.location.id});
  const west=await locations.createLocation(db,ctx,{name:'West',kind:'warehouse',address:'9 West St, Albany, NY 12207'});
  const receive=async(location,units,unitCost,when)=>{
    const key=randomUUID(),po=await w.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:key,lines:[{skuId,quantityUnits:units,unitCost}]});
    await w.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-a'});await w.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-p'});
    await w.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-r',reference:'Receipt '+key.slice(0,6),receivedAt:when,lines:[{lineId:po.lineIds[0],quantity:units,locationId:location.id}]});
  };
  // The month before: ten units at $2 on the Dispatch shelf.
  await receive(shelf,10,2,at(prior,10));
  // The month: five units at $3 at West, a sale of three from the shelf, one
  // damaged unit written off, a count that finds one more at West, two units
  // moved from the shelf to West, and a hand posting that is only in the books.
  await receive(west,5,3,at(month,5));
  const sale=await w.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:shelf.id,idempotencyKey:'sale-'+randomUUID(),lines:[{skuId,quantity:3,unitPriceMinor:1200}]});
  await w.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
  await w.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),fulfilledAt:at(month,8),lines:[{lineId:sale.lineIds[0],quantity:3,locationId:shelf.id}]});
  await removal.issue(db,ctx,{skuId,locationId:shelf.id,quantity:1,reasonCode:'damaged',occurredAt:at(month,10),idempotencyKey:randomUUID()});
  await require('../../src/accounting/postgres-physical-count').apply(db,ctx,{skuId,locationId:west.id,countedQuantity:6,unitCostMinor:300,currency:'USD',reasonCode:'cycle_count',
    occurredAt:at(month,12),postingDate:month+'-12',idempotencyKey:randomUUID()});
  await db.transaction(async c=>{
    const moved=await stock.transferInTransaction(c,ctx,{skuId,sourceLocationId:shelf.id,destinationLocationId:west.id,quantity:2,occurredAt:at(month,15),idempotencyKey:randomUUID()});
    await removal.followTransferValueInTransaction(c,ctx,{skuId,sourceLocationId:shelf.id,outMovementId:moved.outMovementId,inMovementId:moved.inMovementId,
      sourceBefore:exact.add(moved.sourceAfter,moved.quantity),sourceType:'inventory_transfer'});
  });
  const handPosting=await ledger.post(db,ctx,{postingDate:month+'-20',sourceKey:'hand-'+randomUUID(),description:'Stock bought with cash, not received in StockChief',
    lines:[{accountKey:'INVENTORY_ASSET',debitMinor:1000},{accountKey:'CASH',creditMinor:1000}]});
  const flags=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_report_flags WHERE workspace_id=$1 AND job_id=158 AND ${where} ORDER BY created_at`,[ws])).rows;
  const runs=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_report_runs WHERE workspace_id=$1 AND job_id=158 ORDER BY created_at,id',[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('agent-report'));
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const books=async()=>(await db.query(`SELECT (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int journals,
    (SELECT count(*) FROM accounting_periods WHERE workspace_id=$1 AND status<>'OPEN')::int closed,(SELECT sum(on_hand) FROM balances WHERE workspace_id=$1)::int stock`,[ws])).rows[0];
  const worker=async()=>{
    const queued=await monthEnd.schedule(db,ws);
    const job=(await db.query('SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1',[ws,monthEnd.KIND])).rows[0];
    const handler=require('../../src/operations/postgres-runtime-handlers').create()[monthEnd.KIND];
    return {queued,result:await handler({workspaceId:ws,payload:job?.payload||{}},db)};
  };
  const older=()=>db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  return {...f,ws,today,month,prior,shelf,west,skuId,handPosting,ledger,flags,runs,audits,needs,pilot,books,worker,older};
}

test('Each location rolls forward from the stock records, the totals are checked against the books, and the worker flags the difference',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws,month}=f;
  const usd=v=>Math.round(v*100);

  // The report for the month that just ended. Later activity (the fixture's
  // receipt today) is left out; bins roll up into their warehouse.
  let report=await monthEnd.compute(db,ws,{month});
  assert.equal(report.problem,undefined);
  const c=report.currencies.find(x=>x.currency==='USD');
  const row=name=>c.locations.find(l=>l.name===name);
  const figures=p=>[p.opening,p.receipts,p.cogs,p.adjustments,p.writeoffs,p.transfers,p.other,p.closing].map(Number);
  assert.deepEqual(figures(row('Dispatch')),[usd(20),0,usd(-6),0,usd(-2),usd(-4),0,usd(8)]);
  assert.deepEqual(figures(row('West')),[0,usd(15),0,usd(3),0,usd(4),0,usd(22)]);
  assert.deepEqual(figures(c.totals),[usd(20),usd(15),usd(-6),usd(3),usd(-2),0,0,usd(30)]);
  assert.deepEqual([c.books.opening,c.books.closing,c.difference.opening,c.difference.closing].map(Number),[usd(20),usd(40),0,usd(10)]);
  assert.deepEqual([c.cogs.books,c.cogs.fromStock,c.cogs.notFromStock].map(Number),[usd(6),usd(6),0]);
  assert.deepEqual(c.booksOnly.map(e=>[e.id,Number(e.amount)]),[[f.handPosting.entry.id,usd(10)]]);
  assert.equal(c.recordsOnly.count,0,'A move between locations needs no posting; nothing else is only in the records');

  // Bad input stops and says so; months before the books began are explained.
  await assert.rejects(monthEnd.page(db,ctx,{month:f.today.slice(0,7)}),/completed calendar month/);
  await assert.rejects(monthEnd.page(db,ctx,{month:'2026-13'}),/YYYY-MM/);
  assert.match((await monthEnd.compute(db,ws,{month:'2001-01'})).problem,/start on/);

  // Starter is refused everywhere with the plan lock.
  const reviews=require('../../src/autopilot/job-reviews');
  await f.subscribe('starter');
  await assert.rejects(reviews.run(db,ctx,'month-end-stock',{filter:month}),e=>e.code==='entitlement_required');
  await f.browser.get(monthEnd.href).expect(402);
  await f.browser.get(monthEnd.href+'/download').query({month,format:'xlsx'}).expect(402);
  assert.deepEqual(await monthEnd.schedule(db,ws),{queued:0});
  assert.deepEqual(await monthEnd.run(db,ws,{}),{skipped:'plan'});

  for(const tier of ['growth','pro','enterprise']){
    await f.subscribe(tier);
    const review=await reviews.run(db,ctx,'month-end-stock',{filter:month});
    assert.equal(review.mode,'alone',tier);
    const all=review.rows.find(r=>r.Location==='All locations');
    assert.deepEqual([all['Opening value'],all['Closing value'],all['Stock on books at month end'],all['Difference to books'],all['Cost of goods sold']],['$20.00','$30.00','$40.00','$10.00','$6.00']);
    const page=await f.browser.get(monthEnd.href).query({month}).expect(200);
    for(const text of ['Dispatch','West','$22.00','$40.00','Only in your books','Download Excel','never closes a month'])assert(page.text.includes(text),tier+' '+text);
    const binary=req=>req.buffer(true).parse((res,done)=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>done(null,Buffer.concat(chunks)));});
    const excel=await binary(f.browser.get(monthEnd.href+'/download').query({month,format:'xlsx'})).expect(200);
    const xlsx=require('xlsx'),book=xlsx.read(excel.body,{type:'buffer'});
    const sheet=xlsx.utils.sheet_to_json(book.Sheets['Stock value']);
    assert.deepEqual(sheet.find(r=>r.Location==='West'),{Currency:'USD',Location:'West','Opening value':0,Received:15,'Cost of goods sold':0,'Counts and adjustments':3,'Written off':0,Transfers:4,'Production and other':0,'Closing value':22});
    assert.equal(xlsx.utils.sheet_to_json(book.Sheets['Books check'])[0]['Difference at month end'],10);
    assert.equal(xlsx.utils.sheet_to_json(book.Sheets['Only in the books'])[0]['Change to Inventory'],10);
    const pdf=await binary(f.browser.get(monthEnd.href+'/download').query({month,format:'pdf'})).expect(200).expect('Content-Type',/application\/pdf/);
    const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=pdfjs.getDocument({data:new Uint8Array(pdf.body)}),doc=await loading.promise;
    const text=(await (await doc.getPage(1)).getTextContent()).items.map(i=>i.str).join(' ');
    for(const figure of ['$22.00','$8.00','$40.00','$10.00'])assert(text.includes(figure),figure);
    await loading.destroy();
  }
  // Ask reads the same figures, with a link back to the report.
  const asked=await require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review').prepare(null,db,ctx,'What was my stock worth at the end of last month?',{agentJob:'month-end-stock',search:month});
  assert.equal(asked.rows.find(r=>r.Location==='West')['Closing value'],'$22.00');
  assert(asked.sources.some(s=>s.href.startsWith(monthEnd.href)));

  // The first 14 days only watch: the report is made, nothing is flagged.
  const before=await f.books();
  await f.subscribe('growth');
  let made=await f.worker();
  assert.deepEqual(made.queued,{queued:1});
  assert.equal(made.result.outcome,'WATCHED');assert.match(made.result.reason,/first 14 days/);
  assert.equal((await f.flags()).length,0);assert.equal((await f.needs()).length,0);
  assert.equal((await f.runs())[0].result.wouldFlag.length,1);

  // After shadow mode it flags the difference in Needs you, once.
  await f.older();
  made=await f.worker();
  assert.deepEqual(made.queued,{queued:0},'Already queued today; tomorrow it is queued again because the month was only watched');
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[monthEnd.KIND];
  assert.equal(made.result.outcome,'PRODUCED');assert.equal(made.result.opened.length,1);
  let open=await f.flags("status='OPEN'");
  assert.deepEqual(open.map(x=>[x.flag_key,x.currency,Number(x.amount_minor),x.period]),[['difference:USD','USD',usd(10),month]]);
  let needs=await f.needs();
  assert.equal(needs.length,1);assert.match(needs[0].title,/Stock value in your books differs/);assert.match(needs[0].happened,/\$40\.00 of stock and your stock records \$30\.00/);
  assert.equal(needs[0].href,monthEnd.href+'?month='+month);
  assert.equal(await f.audits('StockChief made the month-end stock report'),2);
  // A replay of the same facts writes nothing.
  const replay=await handler({workspaceId:ws,payload:{month}},db);
  assert.equal(replay.replayed,true);assert.equal((await f.runs()).length,2);assert.equal(await f.audits('StockChief made the month-end stock report'),2);

  // Pause holds the worker; Watch only and Ask me first only watch.
  await f.pilot('paused=1');
  assert.deepEqual(await handler({workspaceId:ws,payload:{month}},db),{held:'paused'});
  await f.pilot('paused=0');
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,158,{mode:'watch',revision:0});
  const watched=await handler({workspaceId:ws,payload:{month}},db);
  assert.equal(watched.outcome,'WATCHED');assert.match(watched.reason,/Watch only/);
  assert.equal((await f.flags("status='OPEN'")).length,1,'Watching leaves the open flag alone');
  await assert.rejects(monthEnd.checkNow(db,ctx,{month}),/Watch only/);
  await modes.save(db,ctx,158,{mode:'ask',revision:1});
  assert.equal((await handler({workspaceId:ws,payload:{month}},db)).outcome,'WATCHED');
  // With Ask me first the owner checks by hand.
  const checked=await monthEnd.checkNow(db,ctx,{month});
  assert.equal(checked.outcome,'PRODUCED');assert.deepEqual(checked.updated.length,1);
  assert.equal(await f.audits('Made the month-end stock report'),1);
  await modes.save(db,ctx,158,{mode:'routine',revision:2});

  // Seen flags stay quiet; fixing the books clears the flag on the next check.
  await reportRuns.dismiss(db,ctx,open[0].id);
  assert.equal((await f.needs()).length,0);
  await f.ledger.post(db,ctx,{postingDate:month+'-28',sourceKey:'hand-fix-'+randomUUID(),description:'Correct the cash stock purchase',
    lines:[{accountKey:'CASH',debitMinor:1000},{accountKey:'INVENTORY_ASSET',creditMinor:1000}]});
  const fixed=await handler({workspaceId:ws,payload:{month}},db);
  assert.equal(fixed.cleared.length,1);
  assert.match((await f.flags("status='CLEARED'"))[0].cleared_reason,/no longer finds it/);
  assert.equal(Number((await monthEnd.compute(db,ws,{month})).currencies[0].difference.closing),0);
  assert.deepEqual(await monthEnd.schedule(db,ws),{queued:0},'Nothing left to check again');

  // Each month keeps its own flag: an earlier hand posting leaves both months different from the books.
  await f.ledger.post(db,ctx,{postingDate:f.prior+'-25',sourceKey:'hand-prior-'+randomUUID(),description:'Earlier stock bought with cash',
    lines:[{accountKey:'INVENTORY_ASSET',debitMinor:500},{accountKey:'CASH',creditMinor:500}]});
  await handler({workspaceId:ws,payload:{month:f.prior}},db);await handler({workspaceId:ws,payload:{month}},db);
  assert.deepEqual((await f.flags("status='OPEN'")).map(x=>[x.period,x.flag_key,Number(x.amount_minor)]).sort(),[[f.prior,'difference:USD',usd(5)],[month,'difference:USD',usd(5)]].sort());
  assert.equal((await f.needs()).length,2);

  // Nothing posted, moved or closed by any of this.
  const after=await f.books();
  assert.deepEqual([after.journals,after.closed,after.stock],[before.journals+2,0,before.stock],'Only the owner\'s own entries were posted');
});

test('The month-end stock report fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t),{db,ws,month}=f;
  await f.older();
  await monthEnd.run(db,ws,{month});
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+monthEnd.href+'?month='+month);
    const text=await page.locator('main').innerText();
    assert.match(text,/Month-end stock value and cost of goods/);assert.match(text,/West/);assert.match(text,/Only in your books/);
    assert.match(text,/Stock value in your books differs/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/month-end-stock-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});
