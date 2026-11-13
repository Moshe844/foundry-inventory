'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const clients=require('../../src/connections/postgres-public-api'),hooks=require('../../src/connections/postgres-outbound-webhooks');
const queue=require('../../src/operations/postgres-job-queue'),runtime=require('../../src/operations/postgres-runtime-handlers');

test('agent sales history, activity search, CSV and API use current paid terms',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe}=f;
  await subscribe('enterprise');
  const read=require('../../src/assistant/postgres-service').lookup;
  const names=['recent','quarter','older','archive'],days=[10,95,460,775],orders=[];
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  for(let i=0;i<days.length;i++){
    const date=require('../../src/accounting/customer-money').addDays(today,-days[i]);
    const workId=crypto.randomUUID();
    await db.query(`INSERT INTO work_items(id,workspace_id,idempotency_key,category,source,execution_status,created_at)
      VALUES($1,$2,$1,$3,'postgres_autopilot','COMPLETED',$4)`,[workId,ctx.workspaceId,'AgentHistory '+names[i],date+'T08:00:00Z']);
    await db.query(`INSERT INTO work_item_events(id,workspace_id,work_item_id,event,created_at) VALUES($1,$2,$3,$4,$5)`,
      [crypto.randomUUID(),ctx.workspaceId,workId,'WorkEvent '+names[i],date+'T08:00:00Z']);
    await db.query(`INSERT INTO security_event_history(id,workspace_id,actor_id,action,created_at)
      VALUES($1,$2,$3,$4,$5::timestamptz)`,[crypto.randomUUID(),ctx.workspaceId,ctx.actorId,'HistoryFixture '+names[i],date+'T06:00:00Z']);
    const created=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
      orderDate:date,reference:'Historical fixture '+names[i],idempotencyKey:crypto.randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1000}]});
    await f.workflows.confirmSalesOrder(db,ctx,created.salesOrderId,{idempotencyKey:crypto.randomUUID()});
    orders.push((await db.query('SELECT order_number FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,created.salesOrderId])).rows[0].order_number);
  }
  const mint=scopes=>clients.create(db,ctx,{name:'Activity reader',scopes});
  const api='/api/v1/public/audit',token=(await mint(['audit:read'])).token,ordinary=(await mint(['inventory:read'])).token;
  const call=key=>browser.get(api).query({q:'HistoryFixture'}).set('Authorization','Bearer '+key);
  await call(ordinary).expect(403);
  for(const [tier,logs,sales] of [['starter',1,2],['growth',2,3],['pro',4,4],['enterprise',4,4]]){
    await subscribe(tier);
    for(const route of ['/audit','/activity']){
      const result=await browser.get(route).query({q:'HistoryFixture',from:'2000-01-01'}).expect(200);
      for(let i=0;i<names.length;i++)assert.equal(result.text.includes('HistoryFixture '+names[i]),i<logs,tier+' '+route+' '+names[i]);
      if(route==='/audit')assert.equal(result.text.includes('>Export CSV</a>'),logs===4);
    }
    const overview=await read(db,ctx,{view:'sales_activity',timeframe:'all_time'});
    const work=await browser.get('/autopilot/history').expect(200);
    const events=await browser.get('/audit').query({q:'WorkEvent'}).expect(200);
    for(let i=0;i<names.length;i++){
      assert.equal(work.text.includes('AgentHistory '+names[i]),i<logs);
      assert.equal(events.text.includes('StockChief WorkEvent '+names[i]),i<logs);
    }
    assert.equal(overview.rows[0].value,sales);
    const evidence=await read(db,ctx,{view:'sales_orders',search:'Historical fixture'});
    assert.equal(evidence.rows.length,sales);
    const facts=await require('../../src/connections/postgres-reply-drafting').factsFor(db,ctx.workspaceId,{sender:'receiver@example.test'});
    for(let i=0;i<orders.length;i++)assert.equal(facts.some(v=>v.includes('Customer order '+orders[i]+' has status')),i<sales);
    const csv=await browser.get('/audit/export').query({q:'HistoryFixture'}).expect(logs===4?200:402);
    if(logs===4)assert.ok(csv.text.includes('HistoryFixture archive'));
    if(tier!=='enterprise'){
      await assert.rejects(mint(['audit:read']),e=>e.code==='entitlement_required');
      await call(token).expect(402);
    }else assert.deepEqual((await call(token).expect(200)).body.data.map(r=>r.action),names.map(n=>'HistoryFixture '+n));
  }
});

test('only Custom can start an agent review by API and receive the signed completion event',{timeout:240000},async t=>{
  const {db,ctx,browser,subscribe}=await require('../helpers/agent-workflow-fixture').fixture(t);
  const mint=scopes=>clients.create(db,ctx,{name:'ERP test system',scopes});
  const endpoint=()=>hooks.create(db,ctx,{name:'ERP test endpoint',eventTypes:['agent.review.completed'],endpointUrl:'https://erp.example.com/stockchief'});
  for(const tier of ['starter','growth','pro']){
    await subscribe(tier);await assert.rejects(mint(['agent:run']),e=>e.code==='entitlement_required');
    await assert.rejects(endpoint(),e=>e.code==='entitlement_required');
  }
  await subscribe('enterprise');
  const client=await mint(['agent:run']),other=await mint(['agent:run']),ordinary=await mint(['inventory:read']),hook=await endpoint();
  const base='/api/v1/public/agent/jobs',auth=token=>'Bearer '+token;
  const submit=(token,key,review='catalog-health',inputs={})=>browser.post(base).set('Authorization',auth(token)).set('Idempotency-Key',key).send({review,...inputs});
  await submit(ordinary.token,'denied').expect(403);
  const {body:job}=await submit(client.token,'one-review').expect(202);
  assert.equal((await submit(client.token,'one-review').expect(200)).body.jobId,job.jobId);
  await submit(client.token,'one-review','stock-health').expect(409);
  const status=token=>browser.get(base+'/'+job.jobId).set('Authorization',auth(token));
  await status(other.token).expect(404);
  let sent=0;
  const handlers=runtime.create(undefined,{webhookDelivery:{fetch:async(_url,options)=>{
    sent++;const signed=options.headers['x-stockchief-timestamp']+'.'+options.body;
    assert.equal(options.headers['x-stockchief-signature'],'v1='+crypto.createHmac('sha256',hook.secret).update(signed).digest('hex'));
    const data=JSON.parse(options.body);assert.equal(data.type,'agent.review.completed');assert.equal(data.data.jobId,job.jobId);
    assert.equal(data.data.rows,undefined);return new Response('',{status:200});
  }}});
  assert.equal((await queue.processOne(db,handlers,{owner:'agent-review-test',kinds:['agent.api_review']})).status,'COMPLETED');
  const ready=(await status(client.token).expect(200)).body;
  assert.equal(ready.status,'COMPLETED');assert.match(ready.result.summary,/Data health/);
  const check=await browser.get('/settings/connections?section=developers').expect(200);assert.match(check.text,/value="agent:run"/);
  const pending=await submit(client.token,'other-review').expect(202);
  await subscribe('pro');
  const proPage=await browser.get('/settings/connections?section=developers').expect(200);
  assert.doesNotMatch(proPage.text,/value="agent:run"|value="agent\.review\.completed"/);
  await status(client.token).expect(402);await submit(client.token,'after-downgrade').expect(402);
  const prevented=await queue.processOne(db,handlers,{owner:'agent-review-test',kinds:['agent.api_review']});assert.notEqual(prevented.status,'COMPLETED');
  const registered=(await db.query('SELECT * FROM outbound_webhook_deliveries WHERE workspace_id=$1 AND event_type=$2',[ctx.workspaceId,'agent.review.completed'])).rows;
  assert.equal(registered.length,1);
  const delivery={workspaceId:ctx.workspaceId,payload:{deliveryId:registered[0].id},attemptCount:1,maxAttempts:12};
  await assert.rejects(hooks.deliver(db,delivery,{fetch:async()=>{sent++;throw Error('unexpected external call');}}),e=>e.code==='entitlement_required');
  assert.equal(sent,0);
  await subscribe('enterprise');
  assert.equal((await queue.processOne(db,handlers,{owner:'agent-hook-test',kinds:['webhook.deliver']})).status,'COMPLETED');
  assert.equal(sent,1);
  await clients.revoke(db,ctx.workspaceId,client.id,ctx.actorId);
  await browser.get(base+'/'+pending.body.jobId).set('Authorization',auth(client.token)).expect(401);
  await submit(other.token,'invalid-delay','demand-scenario',{supplierDelayDays:366}).expect(400);
  await submit(other.token,'invalid-quarter','quarterly-supplier-pack',{quarter:'2026-Q9'}).expect(400);
  const {body:scenario}=await submit(other.token,'lead-time','demand-scenario',{supplierDelayDays:6}).expect(202);
  await submit(other.token,'lead-time','demand-scenario',{supplierDelayDays:8}).expect(409);
  const scenarioJob=await queue.processOne(db,handlers,{owner:'agent-review-test',kinds:['agent.api_review']});
  assert.equal(scenarioJob.status,'COMPLETED');
  const scenarioResult=(await browser.get(base+'/'+scenario.jobId).set('Authorization',auth(other.token)).expect(200)).body;
  assert.match(scenarioResult.result.summary,/supplier lead time by 6 days/);

  const reports=require('../../src/reports/postgres-service'),actor={role:'owner',email:'owner@example.test'};
  const definition={dataset:'stock',title:'Inventory to reconcile',columns:['sku','on_hand'],sort:'sku'};
  const report=await reports.save(db,ctx,actor,definition);
  await submit(other.token,'missing-report-id','saved-report').expect(400);
  await submit(other.token,'unknown-report','saved-report',{reportId:'report_unknown'}).expect(400);
  await submit(other.token,'outside-page-range','saved-report',{reportId:report.id,page:10002}).expect(400);
  const {body:savedJob}=await submit(other.token,'saved-current','saved-report',{reportId:report.id}).expect(202);
  assert.equal((await submit(other.token,'saved-current','saved-report',{reportId:report.id}).expect(200)).body.jobId,savedJob.jobId);
  assert.equal((await queue.processOne(db,handlers,{owner:'agent-review-test',kinds:['agent.api_review']})).status,'COMPLETED');
  const reportOutput=(await browser.get(base+'/'+savedJob.jobId).set('Authorization',auth(other.token)).expect(200)).body.result;
  assert.equal(reportOutput.summary,definition.title);
  assert.ok(reportOutput.rows.length);
  assert.ok(reportOutput.rows.every(r=>Object.hasOwn(r,'on_hand')));
  const waiting=await submit(other.token,'report-before-edit','saved-report',{reportId:report.id}).expect(202);
  await reports.save(db,ctx,actor,{...definition,title:'Updated stock'},{id:report.id,expectedRevision:Number(report.revision)});
  assert.equal((await queue.processOne(db,handlers,{owner:'agent-review-test',kinds:['agent.api_review']})).status,'DEAD');
  assert.equal((await browser.get(base+'/'+waiting.body.jobId).set('Authorization',auth(other.token)).expect(200)).body.status,'DEAD');
});
test('Custom managers keep their own report period, download format and decision order in each inventory',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe}=f;
  const prefs=require('../../src/reports/manager-presentation'),path='/reports/my-preferences';
  const choice={revision:0,report_period:'last_month',download_format:'xlsx',inbox_sort:'oldest'};
  for(const tier of ['starter','growth','pro']){
    await subscribe(tier);await browser.get(path).expect(402);
    await browser.get('/reports/business/sales/export.xlsx').expect(402);
    await assert.rejects(prefs.save(db,ctx,choice),e=>e.code==='entitlement_required');
  }
  await subscribe('enterprise');const page=await browser.get(path).expect(200);
  await browser.post(path).type('form').send({...choice,_csrf:f.csrf(page.text)}).expect(303);
  await assert.rejects(prefs.save(db,ctx,choice),/changed/);
  const second=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Second manager',businessName:'Independent space',email:crypto.randomUUID()+'@example.test',password:f.password});
  const colleague={workspaceId:ctx.workspaceId,actorId:crypto.randomUUID()};
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,'Reporting manager','accountant',now()::text)",[colleague.actorId,ctx.workspaceId,second.accountId]);
  assert.equal((await prefs.personal(db,colleague)).download_format,'default');
  await prefs.save(db,colleague,{...choice,actorId:ctx.actorId,report_period:'last_7_days',download_format:'pdf',inbox_sort:'newest'});
  assert.equal((await prefs.personal(db,colleague)).download_format,'pdf');assert.equal((await prefs.personal(db,ctx)).download_format,'xlsx');
  const range=await prefs.dateQuery(db,ctx,{},await prefs.personal(db,ctx)),reportHome=await browser.get('/reports').expect(200);
  assert.match(reportHome.text,new RegExp('name="from" value="'+range.from+'"'));
  assert.match((await browser.get('/reports').query({from:'2024-01-02',to:'2024-01-10'}).expect(200)).text,/name="from" value="2024-01-02"/);
  assert.match((await browser.get('/needs-you/all').expect(200)).text,/data-decision-sort="oldest"/);
  assert.match((await browser.get('/needs-you/all?sort=priority').expect(200)).text,/data-decision-sort="priority"/);
  const standardReport='/reports/business/sales';
  const standard=await browser.get(standardReport).expect(200);
  assert.match(standard.text,new RegExp('name="from" value="'+range.from+'"'));
  assert.match(standard.text,/Download Excel/);
  assert.match((await browser.get(standardReport).query({from:'2024-01-02',to:'2024-01-10'}).expect(200)).text,/name="from" value="2024-01-02"/);
  await browser.get(standardReport+'/export.xlsx').expect(200).expect('Content-Type',/spreadsheet/);
  await browser.get(standardReport+'/export.csv').expect(200).expect('Content-Type',/text\/csv/);
  const saved=await require('../../src/reports/postgres-service').save(db,ctx,{role:'owner',email:f.email},{dataset:'stock',title:'Manager stock',columns:['sku','on_hand'],sort:'sku'});
  const report='/reports/saved/'+saved.id;
  assert.match((await browser.get(report).expect(200)).text,/>Download Excel<\/a>/);
  const file=await browser.get(report+'/export.xlsx').expect(200);assert.match(file.headers['content-type'],/spreadsheet/);
  await subscribe('pro');assert.equal(await prefs.personal(db,ctx),null);
  assert.doesNotMatch((await browser.get(standardReport).expect(200)).text,/Download Excel/);
  assert.match((await browser.get('/needs-you/all').expect(200)).text,/data-decision-sort="priority"/);
  assert.doesNotMatch((await browser.get(report).expect(200)).text,/>Download Excel<\/a>/);
  await subscribe('enterprise');assert.equal((await prefs.personal(db,ctx)).inbox_sort,'oldest');
});
