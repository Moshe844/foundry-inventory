'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {addDays}=require('../../src/accounting/customer-money');
const time=require('../../src/lib/business-time');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const receipts=require('../../src/accounting/postgres-stock-receipt');
const sales=require('../../src/accounting/postgres-stock-removal');
const queue=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers').create();
const autopilot=require('../../src/autopilot/postgres-service');
const modes=require('../../src/autopilot/job-modes');
const reviews=require('../../src/autopilot/job-reviews');
const monthly=require('../../src/forecasting/monthly-product-classes');
const safety=require('../../src/forecasting/agent-safety-stock');

test('monthly cost classes drive native shelf and exact location safety planning on every plan',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:1,timeZone:'America/New_York'});
  const {db,ctx,browser,subscribe}=f,{workspaceId}=ctx;
  const day=await time.today(db,workspaceId),month=day.slice(0,7)+'-01';
  const at=(date,days)=>addDays(date,days)+'T17:00:00Z';
  await db.query("UPDATE accounts SET created_at=(now()-interval '200 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[workspaceId,at(day,-191).slice(0,10)]);
  const locations=require('../../src/domain/postgres-location-service');
  const shelf=name=>locations.createLocation(db,ctx,{name,kind:'shelf',parentLocationId:f.location.id});
  const top=await shelf('Monthly priority A shelf'),mid=await shelf('Monthly priority B shelf');
  const bottom=await shelf('Higher value C shelf'),other=await shelf('Separate position');
  const create=(code,input={})=>catalog.createItem(db,ctx,{baseCode:code,name:code,trackingMode:'quantity',...input});
  const a=await create('ABC-MEASURED',{unitLabel:'kg',quantityPrecision:2,quantityIncrement:'0.25'});
  const b=await create('ABC-SECOND'),c=await create('ABC-THIRD');
  const unknown=await create('ABC-UNKNOWN-COST'),quiet=await create('ABC-NO-SALES');
  const current=await create('ABC-THIS-MONTH');
  const key=(product,location)=>({skuId:product.skuIds[0],locationId:location.id});
  const receipt=(product,location,quantity,unitCost,raw=false)=>(raw?inventory:receipts).receive(db,ctx,{
    ...key(product,location),quantity,unitCost,occurredAt:at(day,-190),idempotencyKey:randomUUID(),
  });
  const sell=(product,location,quantity,occurredAt,raw=false)=>(raw?inventory:sales).issue(db,ctx,{
    ...key(product,location),quantity,occurredAt,reasonCode:'sold',idempotencyKey:randomUUID(),
  });
  await receipt(a,top,20,'40');
  await receipt(a,other,2,'40');
  await sell(a,top,'0.5',at(month,-31));
  await sell(a,top,'1.5',at(month,-2));
  await receipt(b,mid,3,'15');await sell(b,mid,1,at(month,-2));
  await receipt(c,bottom,2000,'5');await sell(c,bottom,1,at(month,-2));
  await receipt(unknown,bottom,3,null,true);await sell(unknown,bottom,1,at(month,-2),true);
  await receipt(quiet,bottom,5,'4');
  await receipt(current,bottom,5,'4');await sell(current,bottom,1,time.dayBoundary(day,'America/New_York'));
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,lead_time_days,safety_stock,created_at,updated_at)
    VALUES($1,$2,$3,$4,14,0,now()::text,now()::text),($5,$2,$3,$6,14,0,now()::text,now()::text)`,
    [randomUUID(),workspaceId,a.skuIds[0],top.id,randomUUID(),other.id]);
  const work=kind=>queue.processOne(db,handlers,{owner:'monthly-abc-test',kinds:[kind],leaseMs:120000});
  const schedule=(kind,idempotencyKey,payload={})=>queue.enqueue(db,{workspaceId,kind,idempotencyKey,payload});
  const assertDone=job=>assert.equal(job?.status,'COMPLETED',JSON.stringify(job?.lastError));
  const monthlyKind='planning.monthly-product-classes';
  const reviewPath=monthly.path+'/products/'+a.itemId;
  const position=JSON.stringify([a.skuIds[0],top.id]);
  const nativeStock=async()=>Object.fromEntries((await db.query(`SELECT location_id,safety_stock FROM reorder_policies
    WHERE workspace_id=$1 AND sku_id=$2 ORDER BY location_id`,[workspaceId,a.skuIds[0]])).rows.map(p=>[p.location_id,Number(p.safety_stock)]));
  const effects=async()=> (await db.query(`SELECT
    (SELECT count(*) FROM movements WHERE workspace_id=$1)::int AS movements,
    (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int AS journals,
    (SELECT count(*) FROM warehouse_count_campaigns WHERE workspace_id=$1)::int AS counts
  `,[workspaceId])).rows[0];
  const before=await effects();
  await subscribe('starter');
  const awaiting=await safety.classPlanning(db,ctx,a.itemId,{position,serviceLevel:'99'});
  assert.equal(awaiting.product.category,null);
  assert.match(awaiting.hold,/verified current ABC class/);
  await schedule('autopilot.evaluate','test-monthly-evaluation',{actorId:ctx.actorId,requestedByUser:true});
  assertDone(await work('autopilot.evaluate'));
  const saved=await work(monthlyKind);assertDone(saved);
  assert.deepEqual(saved.result,{month,withSales:4});
  await schedule(monthlyKind,'test-monthly-replay');
  assert.deepEqual((await work(monthlyKind)).result,{month,replayed:true});
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.product_class_months WHERE workspace_id=$1',[workspaceId])).rows[0].n,1);

  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const report=await reviews.run(db,ctx,'monthly-product-classes');
    const byCode=Object.fromEntries(report.rows.map(r=>[r['Product code'],r]));
    assert.deepEqual(['ABC-MEASURED','ABC-SECOND','ABC-THIRD','ABC-NO-SALES','ABC-THIS-MONTH','ABC-UNKNOWN-COST'].map(code=>byCode[code].Class),
      ['A','B','C','C','C','Review']);
    assert.equal(byCode['ABC-MEASURED']['Sale cost'],'$80.00');
    assert.equal(byCode['ABC-NO-SALES']['Sale cost'],'$0.00');
    assert.equal(byCode['ABC-UNKNOWN-COST']['Sale cost'],null);
    assert.equal(byCode['ABC-MEASURED'].link,reviewPath);
    const count=(await reviews.run(db,ctx,'count-priorities')).rows[0];
    assert.match(count.Suggestion||count.Reason,/monthly A position/);
    if(tier==='starter')assert.match(count.Suggestion,/Monthly priority A shelf/);
    else assert.equal(count.Shelf,top.name);
    const rendered=await browser.get(reviewPath).query({position,serviceLevel:99}).expect(200);
    assert.match(rendered.text,/Class A/);
    // Job 150 works safety stock out from the forecast error and late
    // deliveries; with two sales there is no tested forecast yet.
    assert.match(rendered.text,/Needs a tested sales forecast first/);
    assert.match(rendered.text,/method="get"/i);
    assert.doesNotMatch(rendered.text,/action="\/planning\/safety-stock/);
    if(tier==='starter')await assert.rejects(safety.setTarget(db,ctx,{locationId:top.id,class:'A',kind:'percent',percent:'99'}),e=>e.code==='entitlement_required');
  }
  const noSales=await browser.get(monthly.path+'/products/'+quiet.itemId).expect(200);
  assert.match(noSales.text,/No recorded sales in that period/);
  const incomplete=await safety.classPlanning(db,ctx,unknown.itemId,{position:JSON.stringify([unknown.skuIds[0],bottom.id]),serviceLevel:99});
  assert.match(incomplete.hold,/verified current ABC class/);
  await assert.rejects(safety.classPlanning(db,ctx,a.itemId,{position:JSON.stringify([b.skuIds[0],mid.id])}),/current page/);
  assert.deepEqual(await effects(),before);
  assert.deepEqual(await nativeStock(),{[top.id]:0,[other.id]:0});

  await subscribe('starter');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const base='http://127.0.0.1:'+server.address().port;
  await phone.goto(base+'/login');
  await phone.locator('[name=email]').fill(f.email);
  await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(base+monthly.path+'?filter=ABC-MEASURED');
  await Promise.all([phone.waitForNavigation(),phone.getByRole('link',{name:'Open',exact:true}).click()]);
  await phone.locator('select[name=position]').selectOption(position);
  await phone.locator('input[name=serviceLevel]').fill('99');
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Review selected position'}).click()]);
  assert.match(await phone.textContent('body'),/Needs a tested sales forecast first/);
  assert.equal(await phone.locator('body').evaluate(b=>b.scrollWidth<=innerWidth+2),true);

  // Each class has its own safety stock target (job 150); the product's class
  // picks the one a position uses. Estimates here save nothing.
  await subscribe('growth');
  await safety.setTarget(db,ctx,{locationId:top.id,class:'A',kind:'percent',percent:'99'});
  await safety.setTarget(db,ctx,{class:'B',kind:'runouts',runouts:'2'});
  const planned=await safety.classPlanning(db,ctx,a.itemId,{position});
  assert.equal(planned.selected.target,'99% of reorders without running out');
  assert.match(planned.hold,/Needs a tested sales forecast first/);
  const second=await safety.classPlanning(db,ctx,b.itemId,{position:JSON.stringify([b.skuIds[0],mid.id])});
  assert.equal(second.selected.target,'run out at most 2 times a year');
  // With a tested forecast the next missing fact is the delivery record.
  await db.query(`INSERT INTO stockchief_runtime.agent_demand_forecasts(workspace_id,sku_id,as_of,status,reason,holdout_error)
    VALUES($1,$2,$3,'HELD','Test forecast',0.1)`,[workspaceId,a.skuIds[0],day]);
  assert.match((await safety.classPlanning(db,ctx,a.itemId,{position})).hold,/Needs 3 deliveries received against a promised date/);
  const growth=await browser.get(reviewPath).query({position}).expect(200);
  assert.match(growth.text,/Saved class A target: 99% of reorders without running out/);
  await subscribe('enterprise');
  await db.query("UPDATE users SET role='staff' WHERE workspace_id=$1 AND id=$2",[workspaceId,ctx.actorId]);
  await assert.rejects(safety.classPlanning(db,ctx,a.itemId,{}),e=>e.code==='forbidden');
  await db.query("UPDATE users SET role='owner' WHERE workspace_id=$1 AND id=$2",[workspaceId,ctx.actorId]);
  await db.query("UPDATE stockchief_runtime.product_class_months SET currency='EUR' WHERE workspace_id=$1",[workspaceId]);
  const stale=await safety.classPlanning(db,ctx,a.itemId,{position});
  assert.equal(stale.product.category,null);
  assert.match(stale.hold,/verified current ABC class/);
  await db.query("UPDATE stockchief_runtime.product_class_months SET currency='USD' WHERE workspace_id=$1",[workspaceId]);
  assert.deepEqual(await nativeStock(),{[top.id]:0,[other.id]:0});
  assert.deepEqual(await effects(),before);
});
