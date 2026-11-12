'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 200: on every plan the score is worked out on its own after the first
// import (day one, while StockChief only watches), every day through the
// worker and when the owner asks, with a fix list that leads to job 126.
test('a data health score arrives on day one with a fix list, and refreshes through the worker on every plan',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe,location}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const counts=require('../../src/accounting/postgres-physical-count'),commerce=require('../../src/operations/postgres-commerce');
  const health=require('../../src/autopilot/data-health'),reviews=require('../../src/autopilot/job-reviews'),autopilot=require('../../src/autopilot/postgres-service');
  const imports=require('../../src/imports/postgres-service');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const work=()=>queue.processOne(db,handlers,{owner:'health-worker',kinds:[health.kind]});
  const scores=async()=>(await db.query('SELECT score,products,checks,reason FROM stockchief_runtime.agent_data_health_scores WHERE workspace_id=$1 ORDER BY computed_at,id',[ws])).rows;
  const check=(row,key)=>row.checks.find(c=>c.key===key);
  await subscribe('starter');
  assert.equal((await require('../../src/commercial/agent-plan').accountState(db,ws)).shadow,true,'a new account only watches');

  // The catalog: one complete product, and products with each kind of problem.
  const today=await require('../../src/lib/business-time').today(db,ws);
  const old=require('../../src/accounting/customer-money').addDays(today,-400)+'T12:00:00Z';
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,old.slice(0,10)]);
  const product=async(code,name,extra={})=>(await catalog.createItem(db,ctx,{name,baseCode:code,trackingMode:'quantity',...extra})).skuIds[0];
  const good=await product('GOOD-1','Complete product',{purchaseCost:'2',weightGrams:100});
  await db.query("UPDATE skus SET barcode='9001' WHERE id=$1",[good]);
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:good});
  await db.transaction(c=>require('../../src/operations/postgres-reorder-policies').setManyInTransaction(c,ctx,[{skuId:good,reorderPoint:3}]));
  const stale=await product('OLD-1','Old stock',{purchaseCost:'2',weightGrams:100});
  await receipt.receive(db,ctx,{skuId:stale,locationId:location.id,quantity:2,occurredAt:old,idempotencyKey:randomUUID()});
  const below=await product('NEG-1','Oversold',{purchaseCost:'2',weightGrams:100});
  await db.query('INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at) VALUES($1,$2,$3,-2,$4)',[ws,below,location.id,new Date().toISOString()]);
  const spaced=await product('SPACE-TEMP','Spaced',{purchaseCost:'2',weightGrams:100});
  await db.query("UPDATE skus SET code=' BAD 1 ' WHERE id=$1",[spaced]);
  await product('TWIN-A','Twin pack',{purchaseCost:'2',weightGrams:100});await product('TWIN-B','twin-pack',{purchaseCost:'2',weightGrams:100});

  // Day one: the first import brings the score without anyone asking.
  assert.deepEqual(await scores(),[]);
  const file=await imports.analyse(db,ctx,{text:'Name,SKU,Location,Qty\nCarton,CART-1,Dispatch,0',allowModel:false});
  await imports.approve(db,ctx,file.id,file.integrityHash);assert.ok((await imports.execute(db,ctx,file.id)).verified);
  const processed=await work();
  assert.equal(processed.status,'COMPLETED',JSON.stringify(processed.lastError));
  let [first]=await scores();
  // 8 active products (with the fixture's parcel and the imported carton), 9 checks each.
  assert.deepEqual([first.reason,first.products],['IMPORT',8]);
  const passed=first.checks.reduce((n,c)=>n+c.passed,0);
  assert.equal(first.score,Math.round(passed*100/72));
  assert.deepEqual(Object.fromEntries(first.checks.map(c=>[c.key,c.failed])),{code_ok:1,barcode_ok:7,cost_ok:2,weight_ok:2,unique_ok:2,supplier_ok:7,reorder_ok:7,stock_ok:1,counted_ok:1});

  // Every plan sees the score, the breakdown and the ordered fix list.
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const page=await browser.get(health.path).expect(200);
    assert.match(page.text,new RegExp('<span class="stat-value">'+first.score+'</span><span class="stat-label">of 100</span>'));
    for(const key of ['code_ok','stock_ok','counted_ok','supplier_ok'])assert.ok(page.text.includes('data-health-check="'+key+'"'),key);
    const screen=await health.page(db,ctx);
    // Most urgent first, then the most products within each level.
    assert.deepEqual(screen.fixes.map(x=>x.key),['stock_ok','cost_ok','unique_ok','code_ok','barcode_ok','supplier_ok','reorder_ok','weight_ok','counted_ok']);
    assert.match(screen.fixes[0].text,/^1 product shows stock below zero/);
    const costFix=screen.fixes.find(x=>x.key==='cost_ok');
    assert.equal(costFix.href,tier==='starter'?'/autopilot/reviews/catalog-fixes':'/autopilot/catalog-fixes?kind=COST');
    assert.ok(page.text.includes('href="'+costFix.href+'"'));
    const [notice]=await health.inbox(db,ws);
    assert.equal(notice.title,'Data health score: '+first.score+' of 100');
    assert.match(notice.happened,/^9 fixes are listed\. First: 1 product shows stock below zero/);
    assert.match((await browser.get('/needs-you').expect(200)).text,new RegExp('Data health score: '+first.score+' of 100'));
    assert.match((await browser.get('/onboarding?add=1').expect(200)).text,/href="\/autopilot\/data-health"/);
    const review=await reviews.run(db,ctx,'catalog-health',{filter:'NEG-1',scheduled:true});
    assert.match(review.summary,new RegExp('Data health: '+first.score+' of 100'));
    assert.equal(review.rows[0]['Checks passed'],'5 of 9');
    assert.match(review.rows[0]['What to fix'],/Count the stock shown below zero/);
  }

  // The worker refreshes once a business day; pause and watching do not stop a score.
  assert.equal((await health.schedule(db,ws)).queued,true);
  assert.equal((await health.schedule(db,ws)).queued,false,'one daily score');
  await autopilot.pause(db,ctx,{role:'owner'},'checking');
  assert.equal((await work()).status,'COMPLETED');
  await autopilot.resume(db,ctx,{role:'owner'});
  assert.equal((await scores()).at(-1).reason,'DAILY');

  // On demand: fixes raise the score, and the page shows the change.
  await counts.apply(db,ctx,{skuId:stale,locationId:location.id,countedQuantity:1,reasonCode:'count',idempotencyKey:randomUUID()});
  await db.query("UPDATE skus SET code='BAD-1' WHERE id=$1",[spaced]);
  const page=await browser.get(health.path).expect(200);
  await browser.post(health.path+'/check').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
  assert.match((await browser.get(health.path).expect(200)).text,/Checking now/);
  assert.equal((await work()).status,'COMPLETED');
  const latest=(await scores()).at(-1);
  assert.deepEqual([latest.reason,check(latest,'counted_ok').failed,check(latest,'code_ok').failed],['CHECK',0,0]);
  assert.ok(latest.score>first.score);
  assert.match((await browser.get(health.path).expect(200)).text,new RegExp('up '+(latest.score-first.score)+' since the last check'));

  // Only the owner sees it; an empty catalog asks for a first product.
  await assert.rejects(health.page(db,{...ctx,actorId:'not-the-owner'}),/business owner/);
  await assert.rejects(health.check(db,{...ctx,actorId:'not-the-owner'}),/business owner/);
  await db.query('UPDATE items SET is_active=0 WHERE workspace_id=$1',[ws]);
  await db.transaction(c=>health.refresh(c,ws,'CHECK'));
  assert.match((await browser.get(health.path).expect(200)).text,/data-health-empty/);
  assert.deepEqual(await health.inbox(db,ws),[]);
  await db.query('UPDATE items SET is_active=1 WHERE workspace_id=$1',[ws]);
  await db.transaction(c=>health.refresh(c,ws,'CHECK'));

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+health.path);
    assert(await view.getByRole('heading',{name:'Data health',exact:true}).isVisible());
    assert(await view.getByRole('heading',{name:'Fix these first'}).isVisible());
    assert(await view.getByRole('link',{name:'Find stock problems'}).isVisible());
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await view.screenshot({path:require('node:path').join(folder,'data-health-'+name+'.png'),fullPage:true});
    await view.close();
  }
});
