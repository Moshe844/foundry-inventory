'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const health=require('../../src/forecasting/agent-stock-health');
const reportRuns=require('../../src/reports/agent-report-runs');

// Job 162: turns, GMROI and days of supply per item and location, kept current
// by the worker on Growth and up, with the worst items flagged in Needs you.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx}=f,ws=ctx.workspaceId,w=f.workflows;
  const time=require('../../src/lib/business-time'),days=require('../../src/accounting/customer-money');
  const today=await time.today(db,ws),ago=n=>days.addDays(today,-n),at=n=>ago(n)+'T16:00:00.000Z';
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,ago(120)]);
  const locations=require('../../src/domain/postgres-location-service');
  const west=await locations.createLocation(db,ctx,{name:'West',kind:'warehouse',address:'9 West St, Albany, NY 12207'});
  const shelf=await locations.createLocation(db,ctx,{name:'West shelf',kind:'bin',parentLocationId:west.id});
  const slow=f.item.skuIds[0],slowCode=(await db.query('SELECT code FROM skus WHERE id=$1',[slow])).rows[0].code;
  const other=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Fast item',baseCode:'FAST-'+randomUUID().slice(0,6),trackingMode:'quantity'});
  const fast=other.skuIds[0],fastCode=(await db.query('SELECT code FROM skus WHERE id=$1',[fast])).rows[0].code;
  const receive=async(skuId,location,units,unitCost,n)=>{const key=randomUUID(),po=await w.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:key,lines:[{skuId,quantityUnits:units,unitCost}]});
    await w.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-a'});await w.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-p'});
    await w.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-r',receivedAt:at(n),lines:[{lineId:po.lineIds[0],quantity:units,locationId:location.id}]});};
  const sell=async(skuId,location,quantity,price,n)=>{const sale=await w.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId,quantity,unitPriceMinor:price}]});
    await w.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
    await w.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),...(n?{fulfilledAt:at(n)}:{}),lines:[{lineId:sale.lineIds[0],quantity,locationId:location.id}]});};
  // Slow: twenty units at $5 on the West shelf sixty days ago, two sold at $6 thirty days ago.
  await receive(slow,shelf,20,5,60);await sell(slow,shelf,2,600,30);
  // Fast: ten units at $1 at Dispatch sixty days ago, eight sold at $3 twenty days ago.
  await receive(fast,f.location,10,1,60);await sell(fast,f.location,8,300,20);
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[health.KIND];
  const worker=async()=>{const queued=await health.schedule(db,ws);return {queued,result:await handler({workspaceId:ws,payload:{}},db)};};
  const flags=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_report_flags WHERE workspace_id=$1 AND job_id=162 AND ${where} ORDER BY created_at,id`,[ws])).rows;
  const runs=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_report_runs WHERE workspace_id=$1 AND job_id=162 ORDER BY created_at,id',[ws])).rows;
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('agent-report'));
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const older=()=>db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const books=async()=>(await db.query(`SELECT (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int journals,(SELECT sum(on_hand) FROM balances WHERE workspace_id=$1)::int stock`,[ws])).rows[0];
  return {...f,ws,today,ago,west,shelf,slow,slowCode,fast,fastCode,sell,handler,worker,flags,runs,needs,audits,pilot,older,books};
}

test('Each item at each location gets turns, GMROI and days of supply, Starter gets one suggestion, and the worst items reach Needs you',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws}=f,reviews=require('../../src/autopilot/job-reviews');

  // The figures, bins rolled up into their warehouse.
  const measured=(await health.measure(db,ws,{today:f.today})).rows;
  const at=(code,location)=>measured.find(r=>r.code===code&&r.location===location);
  const slow=at(f.slowCode,'West'),fresh=at(f.slowCode,'Dispatch'),fast=at(f.fastCode,'Dispatch');
  assert.deepEqual([slow.days,slow.average,slow.turns,slow.gmroi,slow.supply,slow.units],[61,Math.round((10000*61-1000*31)/61),0.11,0.02,549,18]);
  assert.deepEqual([fast.days,fast.turns,fast.gmroi,fast.supply],[61,1.1,2.21,15.25]);
  assert.deepEqual([fresh.days,fresh.gmroi,fresh.supply],[1,0,null],'Today\'s fixture receipt: one day measured and no sales');
  assert.equal(measured.filter(r=>r.location==='West shelf').length,0,'The bin counts with its warehouse');
  assert.deepEqual(health.worst(measured).map(r=>[r.code,r.location]),[[f.slowCode,'West']],'Only items with 30 days measured and GMROI under 1 are flagged');

  // Starter: one suggestion, no worker.
  await f.subscribe('starter');
  const starter=await reviews.run(db,ctx,'stock-health',{});
  assert.equal(starter.mode,'suggest');assert.equal(starter.rows.length,1);assert.deepEqual(Object.keys(starter.rows[0]),['Suggestion']);
  assert.match(starter.rows[0].Suggestion,/ at (West|Dispatch)/);
  const starterPage=await f.browser.get(health.href).expect(200);
  assert.match(starterPage.text,/needs Growth/);assert.doesNotMatch(starterPage.text,/Check every item now/);
  assert.deepEqual(await health.schedule(db,ws),{queued:0});assert.deepEqual(await health.run(db,ws),{skipped:'plan'});
  await assert.rejects(health.checkNow(db,ctx),e=>e.code==='entitlement_required');

  for(const tier of ['growth','pro','enterprise']){
    await f.subscribe(tier);
    const review=await reviews.run(db,ctx,'stock-health',{filter:f.slowCode});
    assert.equal(review.mode,'alone',tier);
    const west=review.rows.find(r=>r.Location==='West');
    assert.deepEqual([west['Days measured'],west.GMROI,west['Inventory turns'],west['Days of supply'],west['Valuation check']],[61,0.02,0.11,549,'Matches the stock ledger'],tier);
    const page=await f.browser.get(health.href).query({filter:f.slowCode}).expect(200);
    for(const text of ['Stock health','West','Dispatch','549','Check every item now'])assert(page.text.includes(text),tier+' '+text);
  }
  const asked=await require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review').prepare(null,db,ctx,'Which stock earns least?',{agentJob:'stock-health',search:f.fastCode});
  assert.equal(asked.rows[0].GMROI,2.21);

  // The first 14 days only watch.
  const before=await f.books();
  let made=await f.worker();
  assert.deepEqual(made.queued,{queued:1});assert.equal(made.result.outcome,'WATCHED');assert.match(made.result.reason,/first 14 days/);
  assert.equal((await f.flags()).length,0);assert.equal((await f.needs()).length,0);
  // A flag left open from an earlier month is replaced by the current check.
  const earlier=reportRuns.addMonths(f.today.slice(0,7),-1);
  await db.query(`INSERT INTO stockchief_runtime.agent_report_flags(workspace_id,id,job_id,period,flag_key,detail,status,opened_run_id,last_run_id)
    VALUES($1,'old-flag',162,$2,'item:old','{"title":"Old item"}','OPEN','old-run','old-run')`,[ws,earlier]);
  await f.older();
  made=await f.worker();
  assert.equal(made.result.outcome,'PRODUCED');assert.equal(made.result.opened.length,1);
  assert.equal((await f.flags("id='old-flag'"))[0].status,'CLEARED');assert.match((await f.flags("id='old-flag'"))[0].cleared_reason,/Replaced by the check for/);
  const needs=await f.needs();
  assert.equal(needs.length,1);assert.match(needs[0].title,new RegExp(f.slowCode+' at West earns back less than it costs to hold'));
  assert.match(needs[0].happened,/\$2\.00 gross margin on \$94\.92 of stock on average \(GMROI 0\.02, 0\.11 turns, 549 days of supply\)/);
  assert.equal(needs[0].href,health.href+'?filter='+encodeURIComponent(f.slowCode));
  assert.equal(await f.audits('StockChief checked stock health'),2);
  // A replay of the same day writes nothing.
  const replay=await f.handler({workspaceId:ws,payload:{}},db);
  assert.equal(replay.replayed,true);assert.equal((await f.runs()).length,2);

  // Pause holds it; Watch only and Ask me first only watch; Ask me first lets the owner check.
  await f.pilot('paused=1');
  assert.deepEqual(await f.handler({workspaceId:ws,payload:{}},db),{held:'paused'});
  await f.pilot('paused=0');
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,162,{mode:'watch',revision:0});
  assert.match((await f.handler({workspaceId:ws,payload:{}},db)).reason,/Watch only/);
  await assert.rejects(health.checkNow(db,ctx),/Watch only/);
  await modes.save(db,ctx,162,{mode:'ask',revision:1});
  assert.equal((await f.handler({workspaceId:ws,payload:{}},db)).outcome,'WATCHED');
  assert.equal((await f.flags("status='OPEN'")).length,1,'Watching leaves the open flag alone');
  const checked=await health.checkNow(db,ctx);
  assert.equal(checked.outcome,'PRODUCED');assert.equal(checked.updated.length,1);
  assert.equal(await f.audits('Checked stock health'),1);
  await modes.save(db,ctx,162,{mode:'routine',revision:2});
  assert.deepEqual(await f.books(),before,'Checking stock health posts and moves nothing');

  // Selling the slow stock well clears its flag on the next check.
  await f.sell(f.slow,f.shelf,18,2000,0);
  const cleared=await f.handler({workspaceId:ws,payload:{}},db);
  assert.equal(cleared.cleared.length,1);assert.equal((await f.needs()).length,0);
  assert.match((await f.flags("status='CLEARED' AND id<>'old-flag'"))[0].cleared_reason,/no longer finds it/);
});

test('The stock health page fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t),{db,ws}=f;
  await f.subscribe('growth');await f.older();
  await health.run(db,ws);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+health.href);
    const text=await page.locator('main').innerText();
    assert.match(text,/Stock health/);assert.match(text,/West/);assert.match(text,/earns back less than it costs to hold/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/stock-health-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});
