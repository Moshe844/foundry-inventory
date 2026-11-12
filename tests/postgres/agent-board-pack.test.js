'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const pack=require('../../src/reports/agent-board-pack');
const reportRuns=require('../../src/reports/agent-report-runs');

// Job 159 (Custom): a board or investor pack with charts, from recorded numbers only.
async function setup(t){
  const f=await require('../helpers/agent-month-sales-fixture').setup(t,{job:159,kind:pack.KIND}),{db,ctx}=f;
  // The Brackets left over sell today, so an item sold last month is out of stock now.
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'web-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.b.skuId,quantity:3,unitPriceMinor:2000}]});
  await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  await f.workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],quantity:3,locationId:f.location.id}]});
  const binary=req=>req.buffer(true).parse((res,done)=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>done(null,Buffer.concat(chunks)));});
  const pdfText=async body=>{const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=pdfjs.getDocument({data:new Uint8Array(body)}),doc=await loading.promise;const pages=[];
    for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);pages.push({text:(await page.getTextContent()).items.map(x=>x.str).join(' '),paths:(await page.getOperatorList()).fnArray.filter(op=>op===pdfjs.OPS.constructPath).length});}
    await loading.destroy();return pages;};
  return {...f,binary,pdfText};
}

test('The board pack charts six months, writes its commentary from the records and is built on the owner\'s day on Custom only',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws,month,prior}=f;
  const days=Number(reportRuns.monthEnd(month).slice(8));

  // The figures: sales, gross profit, stock value, days of supply and turns per month.
  const built=await pack.figures(db,ws,month);
  const usd=built.currencies[0];
  assert.deepEqual(built.currencies.map(c=>c.currency),['USD']);
  assert.deepEqual(usd.points.map(p=>p.month),[reportRuns.addMonths(prior,-1),prior,month],'Months before the books began are left out');
  const last=usd.points[2],before=usd.points[1];
  assert.deepEqual([before.revenue,before.cost,before.gross,before.stock],[11800,2600,9200,2000]);
  assert.deepEqual([last.revenue,last.cost,last.gross,last.margin,last.stock],[12000,3400,8600,71.7,4800]);
  assert.equal(last.days,Math.round(4800*days/3400));
  assert.equal(last.turns,Math.round(3400/3400*365/days*10)/10);
  assert.deepEqual(usd.top.map(i=>[i.code,i.revenue,i.gross]),[[f.a.code,8000,5600],[f.b.code,4000,3000]]);
  const problems=Object.fromEntries(usd.problems.map(p=>[p.key,p]));
  assert.equal(problems.writeoffs.amount,300);
  assert.deepEqual(problems.stockouts.names,[f.b.code]);
  assert(problems.overdue.count>=1&&problems.overdue.amount>0,'Unpaid invoices due by the month end are listed');
  assert.equal(problems.books,undefined,'Books and stock records agree');
  // The commentary uses only those numbers.
  assert.equal(usd.commentary[0],'Sales were $120.00 in '+reportRuns.monthName(month)+', up 1.7% on '+reportRuns.monthName(prior)+'.');
  assert.match(usd.commentary[1],/^Gross profit was \$86\.00, a 71\.7% margin \(78% in /);
  assert.match(usd.commentary[2],/^Stock was worth \$48\.00 at the month end, about \d+ days of supply/);
  assert.match(usd.commentary[3],new RegExp('^Best item: '+f.a.code+' · Anchor bolt, with \\$56\\.00 of gross profit\\.'));
  assert.match(usd.commentary[4],/stock written off \$3\.00; .*1 item sold and now out of stock/);

  // Starter, Growth and Pro are refused everywhere.
  const reviews=require('../../src/autopilot/job-reviews');
  for(const tier of ['starter','growth','pro']){
    await f.subscribe(tier);
    await f.browser.get(pack.href).expect(402);
    await f.browser.get(pack.href+'/download').query({filter:month}).expect(402);
    await assert.rejects(reviews.run(db,ctx,'board-pack',{filter:month}),e=>e.code==='entitlement_required');
    await assert.rejects(pack.keep(db,ctx,{month}),e=>e.code==='entitlement_required');
    await assert.rejects(pack.configure(db,ctx,{revision:0,dayOfMonth:'1'}),e=>e.code==='entitlement_required');
    assert.deepEqual(await pack.schedule(db,ws),{queued:0});
    assert.deepEqual(await pack.run(db,ws,{}),{skipped:'plan'});
  }

  // Custom: the page, the live PDF with its charts, and Ask.
  await f.subscribe('enterprise');
  const page=await f.browser.get(pack.href).query({month}).expect(200);
  for(const text of ['Download board pack with charts','Sales were $120.00','Best items','Problems to watch','Stock written off','Build it each month'])assert(page.text.includes(text),text);
  const live=await f.binary(f.browser.get(pack.href+'/download').query({filter:month})).expect(200).expect('Content-Type',/application\/pdf/);
  const pages=await f.pdfText(live.body);
  assert.equal(pages.length,2);
  for(const figure of ['$120.00','$34.00','$86.00','$48.00','71.7%'])assert(pages[0].text.includes(figure),figure);
  assert(pages[0].text.includes('Cash tied up in stock'));assert(pages[0].paths>10,'Page one carries the bar charts');
  assert(pages[1].text.includes('Anchor bolt'));assert(pages[1].text.includes('Stock written off: $3.00'));
  for(const chart of ['Days of supply at month end','Stock turns a year'])assert(pages[1].text.includes(chart),chart);
  assert(pages[1].paths>=4,'Page two charts stock health');
  const asked=await require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review').prepare(null,db,ctx,'Board numbers?',{agentJob:'board-pack',search:month});
  assert.equal(asked.rows.find(r=>r.Month===month)['Stock value'],'$48.00');assert.match(asked.summary,/^Sales were \$120\.00/);

  // On demand: keep a copy; it raises nothing in Needs you.
  const keptRun=await pack.keep(db,ctx,{month});
  assert.equal(keptRun.outcome,'PRODUCED');assert.equal(await f.audits('Built and kept the board pack'),1);
  assert.equal((await pack.keep(db,ctx,{month})).replayed,true,'The same figures keep one copy');
  const copy=await f.binary(f.browser.get(pack.href+'/packs/'+keptRun.runId)).expect(200);
  assert((await f.pdfText(copy.body))[0].text.includes('$120.00'));
  assert.equal((await f.needs()).length,0);

  // The owner's schedule: a saved rule, built through the worker on the chosen day.
  await assert.rejects(pack.configure(db,ctx,{revision:0,dayOfMonth:'31'}),/1 to 28/);
  await pack.configure(db,ctx,{revision:0,dayOfMonth:'1'});
  assert.equal(await f.audits('Scheduled the monthly board pack'),1);
  assert.deepEqual(await pack.schedule(db,ws),{queued:1});
  // The first 14 days: built, nothing in Needs you.
  let result=await f.handler({workspaceId:ws,payload:{month}},db);
  assert.equal(result.outcome,'WATCHED');assert.equal((await f.needs()).length,0);
  await f.older();
  await f.pilot('paused=1');
  assert.deepEqual(await f.handler({workspaceId:ws,payload:{month}},db),{held:'paused'});
  await f.pilot('paused=0');
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,159,{mode:'watch',revision:0});
  assert.match((await f.handler({workspaceId:ws,payload:{month}},db)).reason,/Watch only/);
  await modes.save(db,ctx,159,{mode:'routine',revision:1});
  result=await f.handler({workspaceId:ws,payload:{month}},db);
  assert.equal(result.outcome,'PRODUCED');assert.equal(result.opened.length,1);
  const needs=await f.needs();
  assert.equal(needs.length,1);assert.equal(needs[0].title,'Your board pack for '+reportRuns.monthName(month)+' is ready');
  assert.equal(await f.audits('StockChief built the board pack'),3);
  assert.equal((await f.handler({workspaceId:ws,payload:{month}},db)).replayed,true);
  assert.deepEqual(await pack.schedule(db,ws),{queued:0},'Built for this month');
  // Downloading the built pack clears its notice.
  const built_=(await f.runs()).find(r=>r.outcome==='PRODUCED'&&r.authorization_kind==='AUTOMATIC');
  await f.binary(f.browser.get(pack.href+'/packs/'+built_.id)).expect(200);
  assert.equal((await f.needs()).length,0);assert.equal(await f.audits('Downloaded the board pack'),1);
  await f.browser.get(pack.href+'/packs/no-such-pack').expect(404);
  // Stopping the schedule stops the worker.
  const rule=(await db.query('SELECT revision FROM stockchief_runtime.agent_board_pack_schedules WHERE workspace_id=$1',[ws])).rows[0];
  await pack.configure(db,ctx,{revision:rule.revision,stop:'yes'});
  assert.deepEqual(await pack.run(db,ws,{}),{skipped:'not_scheduled'});
});

test('The board pack page fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t),{month}=f;
  await f.subscribe('enterprise');
  const live=await f.binary(f.browser.get(pack.href+'/download').query({filter:month})).expect(200);
  require('node:fs').mkdirSync('output',{recursive:true});require('node:fs').writeFileSync('output/board-pack.pdf',live.body);
  const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+pack.href+'?month='+month);
    const text=await page.locator('main').innerText();
    assert.match(text,/Board or investor pack/);assert.match(text,/Sales were \$120\.00/);assert.match(text,/Problems to watch/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/board-pack-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});
