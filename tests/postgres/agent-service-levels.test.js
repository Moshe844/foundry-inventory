'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const levels=require('../../src/forecasting/agent-service-levels');
const reportRuns=require('../../src/reports/agent-report-runs');

// Job 163: forecast accuracy from job 144's saved weekly forecasts, and fill
// rate and on-time-in-full for customers (orders against shipments) and
// suppliers (purchase orders against receipts), kept current on Growth and up.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f,ws=ctx.workspaceId,w=f.workflows;
  const time=require('../../src/lib/business-time'),zone='America/New_York';
  await db.query('UPDATE workspaces SET time_zone=$2 WHERE id=$1',[ws,zone]);
  const today=await time.today(db,ws),month=reportRuns.lastCompleted(today),date=day=>month+'-'+String(day).padStart(2,'0');
  const at=day=>time.wall(date(day),12,0,zone).toISOString();
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,reportRuns.addMonths(month,-1)+'-01']);
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const other=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Second item',baseCode:'SECOND-'+randomUUID().slice(0,6),trackingMode:'quantity'});
  const second=other.skuIds[0],secondCode=(await db.query('SELECT code FROM skus WHERE id=$1',[second])).rows[0].code;
  // Job 144's saved weekly forecasts, scored against what then sold.
  const week=async(skuId,endDay,predicted,actual,comparable=1)=>{const id=randomUUID(),end=endDay.length?endDay:date(endDay),asOf=require('../../src/accounting/customer-money').addDays(end,-6);
    await db.query(`INSERT INTO demand_forecasts(id,workspace_id,sku_id,location_id,as_of,horizon_days,horizon_end,horizon_units,confidence,model_version,created_at)
      VALUES($1,$2,$3,NULL,$4,7,$5,$6,'moderate','agent-144-v1',$4)`,[id,ws,skuId,asOf,end,predicted]);
    await db.query(`INSERT INTO forecast_outcomes(id,workspace_id,forecast_id,sku_id,scored_at,predicted_units,actual_units,error_units,absolute_error,comparable,created_at)
      VALUES($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$4)`,[id,ws,skuId,end+'T23:00:00Z',predicted,actual,predicted-actual,Math.abs(predicted-actual),comparable]);};
  await week(sku,7,10,8);await week(sku,14,6,8);await week(sku,21,40,1,0);// the third week was out of stock: not comparable
  await week(second,7,5,0);await week(second,14,12,10);
  await week(second,reportRuns.addMonths(month,-1)+'-20',100,1);// ended the month before
  // Customers: Receiver collected three units a day early; Late Co collected two of four after the promise.
  const late=randomUUID();
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at) VALUES($1,$2,'Late Co','late@example.test','ACTIVE',$3,now()::text,now()::text)`,[late,ws,ctx.actorId]);
  const sell=async(customerId,quantity,shipped,promised,shippedDay)=>{const sale=await w.createSalesOrder(db,ctx,{customerId,deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity,unitPriceMinor:500}]});
    await w.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
    await db.query('UPDATE sales_orders SET needed_by=$3,created_at=$4 WHERE workspace_id=$1 AND id=$2',[ws,sale.salesOrderId,promised?date(promised):null,at(1)]);
    if(shipped){await w.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),shipment:{},lines:[{lineId:sale.lineIds[0],quantity:shipped,locationId:f.location.id}]});
      await db.query('UPDATE sales_shipments SET shipped_at=$3 WHERE workspace_id=$1 AND sales_order_id=$2',[ws,sale.salesOrderId,at(shippedDay)]);}
    return sale;};
  await sell('fixture-customer',3,3,15,14);await sell(late,4,2,10,12);await sell('fixture-customer',1,0,null);
  // Suppliers: Fixture parts delivered four of four early; Alternative one of four late.
  const alternative=await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:'Alternative',email:'alt@example.test',currency:'USD'});
  const buy=async(supplierId,expected,received,receivedDay)=>{const key=randomUUID(),po=await w.createPurchaseOrder(db,ctx,{supplierId,destinationLocationId:f.location.id,currency:'USD',expectedDate:date(expected),idempotencyKey:key,lines:[{skuId:second,quantityUnits:4,unitCost:1}]});
    await w.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-a'});await w.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-p'});
    await db.query('UPDATE purchase_orders SET expected_date=$3 WHERE workspace_id=$1 AND id=$2',[ws,po.purchaseOrderId,date(expected)]);
    await w.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-r',receivedAt:at(receivedDay),lines:[{lineId:po.lineIds[0],quantity:received,locationId:f.location.id}]});
    return po;};
  await buy('fixture-supplier',10,4,9);const slowPo=await buy(alternative.id,12,1,14);
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[levels.KIND];
  const runs=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_report_runs WHERE workspace_id=$1 AND job_id=163 AND ${where} ORDER BY created_at,id`,[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const older=()=>db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  return {...f,ws,today,month,date,at,sku,code,second,secondCode,slowPo,handler,runs,audits,pilot,older};
}

test('Forecast accuracy, fill rate and OTIF come from saved forecasts, shipments and receipts, kept current on Growth and up',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws,month}=f,reviews=require('../../src/autopilot/job-reviews');

  const r=await levels.compute(db,ws,{month,today:f.today});
  assert.deepEqual(r.forecasts.items.map(i=>[i.code,i.weeks,i.forecast,i.actual,i.mape,i.bias,i.noSales]),
    [[f.code,2,16,16,25,0,0],[f.secondCode,2,17,10,20,70,1]].sort((a,b)=>a[0].localeCompare(b[0])));
  assert.deepEqual(r.forecasts.overall,{products:2,weeks:4,noSales:1,forecast:33,actual:26,mape:23.3,bias:26.9},'Out-of-stock weeks and other months are left out');
  assert.deepEqual([r.customers.orders,r.customers.ordered,r.customers.filled,r.customers.fill,r.customers.otif,r.customers.undated],[2,7,5,71.4,50,1]);
  assert.deepEqual([r.suppliers.orders,r.suppliers.ordered,r.suppliers.filled,r.suppliers.fill,r.suppliers.otif,r.suppliers.undated],[2,8,5,62.5,50,0]);
  assert.deepEqual(r.parties.map(p=>[p.kind,p.name,p.fill,p.otif]),[['Customer','Late Co',50,0],['Customer','Receiver',100,100],['Supplier','Alternative',25,0],['Supplier','Fixture parts',100,100]]);
  assert.match(levels.sentence(r),/MAPE was 23\.3% and bias \+26\.9%.*Customers: 71\.4% of units filled, 50% of 2 orders on time in full.*1 order has no promised date/);
  await assert.rejects(levels.compute(db,ws,{month:'2026-13',today:f.today}),/YYYY-MM/);

  // Starter is refused everywhere with the plan lock.
  await f.subscribe('starter');
  for(const key of ['service-levels','forecast-accuracy'])await assert.rejects(reviews.run(db,ctx,key,{}),e=>e.code==='entitlement_required');
  await f.browser.get(levels.href).expect(402);
  await f.browser.get(levels.href+'/download').query({month,format:'xlsx'}).expect(402);
  assert.deepEqual(await levels.schedule(db,ws),{queued:0});assert.deepEqual(await levels.run(db,ws),{skipped:'plan'});

  const binary=req=>req.buffer(true).parse((res,done)=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>done(null,Buffer.concat(chunks)));});
  for(const tier of ['growth','pro','enterprise']){
    await f.subscribe(tier);
    const service=await reviews.run(db,ctx,'service-levels',{filter:'',scheduled:true});
    assert.equal(service.mode,'alone',tier);
    assert.deepEqual(service.rows.map(row=>[row.Name,row['Fill rate %'],row['OTIF %']]),[['Late Co',50,0],['Receiver',100,100],['Alternative',25,0],['Fixture parts',100,100]]);
    const accuracy=await reviews.run(db,ctx,'forecast-accuracy',{filter:f.secondCode});
    // The review covers the last 90 days, so the week from the month before (100 forecast, 1 sold) counts here too.
    assert.deepEqual([accuracy.rows[0]['Weeks scored'],accuracy.rows[0]['MAPE %'],accuracy.rows[0]['Bias %'],accuracy.rows[0]['Weeks with no sales']],[3,4960,963.6,1]);
    const page=await f.browser.get(levels.href).query({month}).expect(200);
    for(const text of ['Forecast accuracy, fill rate and on-time in full','23.3%','+26.9%','71.4%','62.5%','Late Co','Alternative','no promised date','Download Excel'])assert(page.text.includes(text),tier+' '+text);
  }
  const book=require('xlsx').read((await binary(f.browser.get(levels.href+'/download').query({month,format:'xlsx'})).expect(200)).body,{type:'buffer'});
  const xlsx=require('xlsx');
  assert.equal(xlsx.utils.sheet_to_json(book.Sheets.Summary).find(row=>row.Measure==='Forecast MAPE %').Value,23.3);
  assert.deepEqual(xlsx.utils.sheet_to_json(book.Sheets.Suppliers).map(row=>[row.Supplier,row['Fill rate %']]),[['Alternative',25],['Fixture parts',100]]);
  assert.equal(xlsx.utils.sheet_to_json(book.Sheets['Forecast accuracy']).find(row=>row.SKU===f.secondCode)['Bias %'],70);
  const pdf=await binary(f.browser.get(levels.href+'/download').query({month,format:'pdf'})).expect(200).expect('Content-Type',/application\/pdf/);
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=pdfjs.getDocument({data:new Uint8Array(pdf.body)}),doc=await loading.promise;
  const text=(await (await doc.getPage(1)).getTextContent()).items.map(i=>i.str).join(' ');
  for(const figure of ['23.3%','Late Co','Alternative'])assert(text.includes(figure),figure);
  await loading.destroy();
  const asked=await require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review').prepare(null,db,ctx,'How accurate were the forecasts?',{agentJob:'forecast-accuracy',search:f.code});
  assert.equal(asked.rows[0]['MAPE %'],25);

  // The worker keeps the month so far and the month that just ended; the first 14 days only watch.
  await f.subscribe('growth');
  assert.deepEqual(await levels.schedule(db,ws),{queued:1});
  const months=[month,...(f.today.slice(8,10)==='01'?[]:[f.today.slice(0,7)])];
  let made=await f.handler({workspaceId:ws,payload:{}},db);
  assert.deepEqual(made.months.map(m=>[m.month,m.outcome]),months.map(m=>[m,'WATCHED']));
  await f.older();
  made=await f.handler({workspaceId:ws,payload:{}},db);
  assert.deepEqual(made.months.map(m=>[m.month,m.outcome]),months.map(m=>[m,'PRODUCED']));
  const kept=(await f.runs(`period='${month}' AND outcome='PRODUCED'`))[0];
  assert.deepEqual([kept.result.forecasts.overall.mape,kept.result.customers.otif,kept.result.suppliers.fill],[23.3,50,62.5]);
  assert.equal(await f.audits('StockChief updated the forecast and delivery report'),months.length*2);
  const replay=await f.handler({workspaceId:ws,payload:{}},db);
  assert(replay.months.every(m=>m.replayed));assert.equal(await f.audits('StockChief updated the forecast and delivery report'),months.length*2,'A replay writes nothing');
  // A late receipt changes the month: the next run keeps the new figures.
  const line=(await db.query('SELECT id FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',[ws,f.slowPo.purchaseOrderId])).rows[0];
  await f.workflows.receivePurchaseOrder(db,ctx,f.slowPo.purchaseOrderId,{idempotencyKey:randomUUID(),receivedAt:f.at(20),lines:[{lineId:line.id,quantity:3,locationId:f.location.id}]});
  await f.handler({workspaceId:ws,payload:{}},db);
  const latest=(await f.runs(`period='${month}' AND outcome='PRODUCED'`)).at(-1);
  assert.deepEqual([latest.result.suppliers.fill,latest.result.suppliers.otif],[100,50]);
  const history=await f.browser.get(levels.href).query({month}).expect(200);
  assert.match(history.text,/Kept months/);assert(history.text.includes(month));

  // Pause holds it; Watch only and Ask me first only watch; Ask me first lets the owner keep a month.
  await f.pilot('paused=1');
  assert.deepEqual(await f.handler({workspaceId:ws,payload:{}},db),{held:'paused'});
  await f.pilot('paused=0');
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,163,{mode:'watch',revision:0});
  assert(( await f.handler({workspaceId:ws,payload:{}},db)).months.every(m=>m.outcome==='WATCHED'&&/Watch only/.test(m.reason)));
  await assert.rejects(levels.keep(db,ctx,{month}),/Watch only/);
  await modes.save(db,ctx,163,{mode:'ask',revision:1});
  assert((await f.handler({workspaceId:ws,payload:{}},db)).months.every(m=>m.outcome==='WATCHED'));
  const byHand=await levels.keep(db,ctx,{month});
  assert.equal(byHand.outcome,'PRODUCED');assert.equal(await f.audits('Kept the forecast and delivery report'),1);
});

test('The forecast and delivery page fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t),{db,ws,month}=f;
  await f.subscribe('growth');await f.older();
  await levels.run(db,ws);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+levels.href+'?month='+month);
    const text=await page.locator('main').innerText();
    assert.match(text,/Forecast accuracy by product/);assert.match(text,/Late Co/);assert.match(text,/Kept months/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/service-levels-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});
