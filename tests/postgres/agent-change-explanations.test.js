'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const changes=require('../../src/reports/agent-change-explanations');
const reportRuns=require('../../src/reports/agent-report-runs');

// Job 157: why sales, gross profit, cost of goods or stock value changed, with
// every cause worked out from posted records and adding up to the change.
const setup=t=>require('../helpers/agent-month-sales-fixture').setup(t,{job:157,kind:changes.KIND});
const amounts=c=>Object.fromEntries(c.drivers.map(d=>[d.key,Number(d.amount)]));

test('Changes in sales, gross profit, cost of goods and stock value break into causes that add up, with their records',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,month,prior}=f;

  // Why did gross profit drop? Volume, mix, price, cost, discounts and returns, adding up exactly.
  let r=await changes.explain(db,ctx,{measure:'margin',month});
  let usd=r.currencies[0];
  assert.deepEqual([usd.currency,Number(usd.previous),Number(usd.current),Number(usd.change)],['USD',9200,8600,-600]);
  assert.deepEqual(amounts(usd),{volume:-3450,mix:3650,price:1600,discounts:-600,cost:-800,returns:-1000,other:0});
  assert.match(usd.sentence,/^Gross profit fell \$6\.00 \(6\.52%\)/);
  const cause=key=>usd.drivers.find(d=>d.key===key);
  assert(cause('volume').records.some(x=>x.label.includes(f.c.code)&&x.text==='6 → 0 units'));
  assert(cause('mix').records.some(x=>x.label.includes(f.b.code)&&/Sold only in/.test(x.text)));
  assert.match(cause('price').records[0].text,/\$10\.00 → \$12\.00 a unit/);
  assert.match(cause('cost').records[0].text,/\$2\.00 → \$3\.00 a unit/);
  const behind=cause('cost').sources[0].records;
  assert(behind.some(x=>/Received .* at \$4\.00 a unit/.test(x.label)&&x.href.startsWith('/accounting/entries/')));
  assert(behind.some(x=>x.href==='/autopilot/reviews/supplier-price-increases?filter='+encodeURIComponent(f.a.code)));
  assert.match(cause('discounts').records[0].text,/\$6\.00 off/);
  assert(cause('returns').records.some(x=>x.href==='/accounting/entries/'+f.refund.entry.id));
  // Stockouts: the Clamps were out of stock all month.
  assert.equal(usd.stockouts.length,1);assert.match(usd.stockouts[0].label,new RegExp(f.c.code));
  assert.equal(usd.stockouts[0].days,Number(reportRuns.monthEnd(month).slice(8)));
  // Below gross profit: the write-off is known; fees are missing until fee terms exist, never zero.
  assert.deepEqual(usd.below.lines.map(l=>[l.key,Number(l.amount)]),[['writeoffs',-300],['counts',0]]);
  assert.equal(usd.below.afterChange,null);assert.match(usd.below.notes.join(' '),/No fee terms or checked costs for Direct, Web shop/);
  const margin=require('../../src/reports/agent-net-margin');
  await margin.saveFeeRule(db,ctx,{revision:0,currency:'USD',channel:'Web shop',percent:'10',fixed:'0.30',sourceReference:'Channel fee page'});
  await margin.saveFeeRule(db,ctx,{revision:0,currency:'USD',channel:'Direct',percent:'0',fixed:'0',sourceReference:'No fees on direct sales'});
  r=await changes.explain(db,ctx,{measure:'margin',month});usd=r.currencies[0];
  assert.deepEqual(usd.below.lines.map(l=>[l.key,Number(l.amount)]),[['writeoffs',-300],['counts',0],['fees',-430]]);
  assert.equal(Number(usd.below.afterChange),-1330);

  // Sales and cost of goods use the same records.
  usd=(await changes.explain(db,ctx,{measure:'sales',month})).currencies[0];
  assert.deepEqual([Number(usd.change),amounts(usd)],[200,{volume:-4425,mix:4625,price:1600,discounts:-600,returns:-1000,other:0}]);
  usd=(await changes.explain(db,ctx,{measure:'cost_of_goods',month})).currencies[0];
  assert.deepEqual([Number(usd.change),amounts(usd)],[800,{volume:-975,mix:975,cost:800,returns:0,other:0}]);
  // Stock value follows the month-end roll-forward.
  usd=(await changes.explain(db,ctx,{measure:'stock',month})).currencies[0];
  assert.deepEqual([Number(usd.previous),Number(usd.current)],[2000,4800]);
  assert.deepEqual(amounts(usd),{receipts:6500,cogs:-3400,adjustments:0,writeoffs:-300,transfers:0,other:0,booksOnly:0});

  // By channel and for one channel, customer or item.
  r=await changes.explain(db,ctx,{measure:'margin',month,by:'channel'});
  assert.deepEqual(r.currencies[0].breakdown.map(g=>[g.label,Number(g.change)]),[['Web shop',3000],['Direct',-2600],['Not tied to a sales channel',-1000]]);
  usd=(await changes.explain(db,ctx,{measure:'margin',month,by:'channel',subject:'web shop'})).currencies[0];
  assert.deepEqual([Number(usd.change),amounts(usd).volume],[3000,3000]);
  usd=(await changes.explain(db,ctx,{measure:'margin',month,by:'item',subject:f.a.code})).currencies[0];
  assert.deepEqual([Number(usd.change),amounts(usd)],[-2400,{volume:-1600,mix:0,price:1600,discounts:-600,cost:-800,returns:-1000,other:0}]);
  usd=(await changes.explain(db,ctx,{measure:'margin',month,by:'customer',subject:'Web buyer'})).currencies[0];
  assert.equal(Number(usd.change),3000);
  r=await changes.explain(db,ctx,{measure:'margin',month,compare:reportRuns.addMonths(prior,-1)});
  assert.equal(Number(r.currencies[0].previous),0,'A month with no sales compares as zero');

  // Missing or wrong facts stop and say so.
  await assert.rejects(changes.explain(db,ctx,{measure:'margin',month,by:'customer',subject:'Nobody'}),/No customer named Nobody/);
  await assert.rejects(changes.explain(db,ctx,{measure:'margin',month,compare:month}),/earlier month/);
  await assert.rejects(changes.explain(db,ctx,{measure:'margin',month:f.today.slice(0,7)}),/completed calendar month/);
  await assert.rejects(changes.explain(db,ctx,{measure:'stock',month,by:'channel'}),/item or location/);
  await assert.rejects(changes.explain(db,ctx,{measure:'happiness',month}),/Choose what changed/);
  assert.match((await changes.explain(db,ctx,{measure:'margin',month,compare:'2001-01'})).problem,/accounting records start/);

  // Ask answers on its own, with the page and the records.
  // Ask reads the question's plain words the same way every time.
  const ask=require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review');
  const answer=await ask.prepare(null,db,ctx,'Why did margin drop?',{agentJob:'margin-change',search:'Why did gross profit drop in '+reportRuns.monthName(month)+'?'});
  assert.match(answer.summary,/^Gross profit fell \$6\.00/);
  assert(answer.sources[0].href.startsWith(changes.href+'?filter='));
  assert(answer.sources.some(s=>s.href==='/accounting/entries/'+f.refund.entry.id));
  const clamp=(await db.query("SELECT s.code||' · '||i.name AS l FROM skus s JOIN items i ON i.id=s.item_id WHERE s.id=$1",[f.c.skuId])).rows[0].l;
  assert(answer.rows.some(row=>row.Cause==='Out of stock: '+clamp));
  assert(await ask.verify(null,db,ctx,answer));
  const shop=await ask.prepare(null,db,ctx,'Why did web shop profit rise?',{agentJob:'margin-change',search:'profit '+month+' vs '+prior+' for Web shop'});
  assert.match(shop.summary,/^Gross profit for Web shop rose \$30\.00/);
  await assert.rejects(ask.prepare(null,db,ctx,'Why?',{agentJob:'margin-change',search:'margin for Nobody at all'}),/No item, customer, channel or warehouse named Nobody at all/);
  // A shared link with the same words opens the same explanation.
  assert.match((await f.browser.get(answer.sources[0].href).expect(200)).text,/Gross profit fell \$6\.00/);
  const reviews=require('../../src/autopilot/job-reviews');

  // Every plan: Starter refused; Growth, Pro and Custom answer alone, on the page and in Ask.
  for(const tier of ['starter','growth','pro','enterprise']){
    await f.subscribe(tier);
    if(tier==='starter'){
      await f.browser.get(changes.href).expect(402);
      await assert.rejects(ask.prepare(null,db,ctx,'Why?',{agentJob:'margin-change',search:'sales'}),e=>e.code==='entitlement_required');
      await assert.rejects(reviews.run(db,ctx,'margin-change',{filter:month}),e=>e.code==='entitlement_required');
      assert.deepEqual(await changes.schedule(db,f.ws),{queued:0});
      assert.deepEqual(await changes.run(db,f.ws,{}),{skipped:'plan'});
      continue;
    }
    const review=await reviews.run(db,ctx,'margin-change',{filter:month});
    assert.equal(review.mode,'alone');assert.equal(review.rows[0].Change,'-$6.00');
    const page=await f.browser.get(changes.href).query({measure:'margin',month,by:'channel'}).expect(200);
    for(const text of ['Why it changed','Gross profit fell $6.00','More or fewer units sold','A different mix of items','Selling prices per unit','Cost per unit',
      'Discounts given','Customer returns and refunds','Stock written off','Channel fees','Sales probably missed while out of stock','Web shop'])assert(page.text.includes(text),tier+' '+text);
  }
});

test('The monthly check flags big changes with their causes, respects pause, watch and shadow, and replays without writing',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws,month}=f;
  const books=async()=>(await db.query('SELECT (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int j,(SELECT sum(on_hand) FROM balances WHERE workspace_id=$1)::int s',[ws])).rows[0];
  const before=await books();
  // Shadow mode: the month is checked and nothing is flagged.
  assert.deepEqual(await changes.schedule(db,ws),{queued:1});
  let result=await f.handler({workspaceId:ws,payload:{month}},db);
  assert.equal(result.outcome,'WATCHED');assert.equal((await f.flags()).length,0);
  assert.deepEqual((await f.runs())[0].result.wouldFlag.map(x=>x.key),['change:cogs:USD','change:stock:USD']);
  await f.older();
  // Pause holds it; Watch only and Ask me first only watch.
  await f.pilot('paused=1');
  assert.deepEqual(await f.handler({workspaceId:ws,payload:{month}},db),{held:'paused'});
  await f.pilot('paused=0');
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,157,{mode:'watch',revision:0});
  assert.match((await f.handler({workspaceId:ws,payload:{month}},db)).reason,/Watch only/);
  await assert.rejects(changes.checkNow(db,ctx,{month}),/Watch only/);
  await modes.save(db,ctx,157,{mode:'routine',revision:1});
  // Routine: big changes (20% or more) open flags in Needs you, with their causes.
  result=await f.handler({workspaceId:ws,payload:{month}},db);
  assert.equal(result.outcome,'PRODUCED');assert.equal(result.opened.length,2);
  const open=await f.flags("status='OPEN'");
  assert.deepEqual(open.map(x=>[x.flag_key,Number(x.amount_minor)]),[['change:cogs:USD',800],['change:stock:USD',2800]]);
  const needs=await f.needs();
  assert.equal(needs.length,2);
  const cogs=needs.find(n=>/Cost of goods sold rose 30\.77%/.test(n.title));
  assert(cogs);assert.match(cogs.happened,/Biggest causes:/);assert(cogs.href.startsWith(changes.href+'?measure=cogs'));
  assert.equal(await f.audits('StockChief checked the month for big changes'),3);
  // A replay writes nothing; the month is not queued again once checked.
  assert.equal((await f.handler({workspaceId:ws,payload:{month}},db)).replayed,true);
  assert.equal(await f.audits('StockChief checked the month for big changes'),3);
  assert.deepEqual(await changes.schedule(db,ws),{queued:0});
  // Seen flags leave Needs you.
  await reportRuns.dismiss(db,ctx,open[0].id);
  assert.equal((await f.needs()).length,1);
  // Ask me first: the owner checks by hand.
  await modes.save(db,ctx,157,{mode:'ask',revision:2});
  const checked=await changes.checkNow(db,ctx,{month});
  assert.equal(checked.outcome,'PRODUCED');assert.equal(checked.updated.length,2);
  assert.equal(await f.audits('Checked the month for big changes'),1);
  assert.deepEqual(await books(),before,'Explaining and checking never posts or moves anything');
});

test('The change explanation page fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t),{db,ws,month}=f;
  await f.older();await changes.run(db,ws,{month});
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+changes.href+'?'+new URLSearchParams({measure:'margin',month,by:'item'}));
    const text=await page.locator('main').innerText();
    assert.match(text,/Gross profit fell \$6\.00/);assert.match(text,/Cost per unit/);assert.match(text,/Cost of goods sold rose 30\.77%/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/change-explanation-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});
