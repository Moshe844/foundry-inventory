'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const screening=require('../../src/sales/agent-order-screening');
const reviews=require('../../src/autopilot/job-reviews');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');

// The fixture customer ships to Albany, NY. Ten units are received; one earlier
// order ships one of them and leaves an invoice the test makes overdue.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx,workflows,shipping}=f;
  const ws=ctx.workspaceId,sku=f.item.skuIds[0];
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/pricing/postgres-service').setPrice(db,ctx,{skuId:sku,amountMinor:1000,currency:'USD'});
  const pricing=require('../../src/pricing/postgres-promotions');
  const proposal=await pricing.propose(db,ctx,{kind:'price_list',name:'Receiver agreed prices',currency:'USD',
    scope:{customerIds:['fixture-customer']},entries:[{skuId:sku,minQuantity:1,unitPriceMinor:900}]});
  await pricing.decide(db,ctx,proposal.id,proposal.integrity_hash,true);
  const earlier=await f.parcel({quantity:1});
  await shipping.markPacked(db,ctx,earlier.shipmentId);
  await shipping.handoff(db,ctx,earlier.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TRACK-ORDER-CHECK'});
  const today=await require('../../src/lib/business-time').today(db,ws);
  const yesterday=require('../../src/accounting/customer-money').addDays(today,-1);
  await db.query('UPDATE accounting_customer_invoices SET due_date=$2 WHERE sales_order_id=$1',[earlier.order.salesOrderId,yesterday]);
  await db.transaction(c=>require('../../src/sales/postgres-payment-terms').saveInTransaction(c,ctx,
    {customerId:'fixture-customer',kind:'ON_ACCOUNT',netDays:30,creditApproved:true,creditLimitMinor:1000}));
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(),queue=require('../../src/operations/postgres-job-queue');
  const work=async()=>{let n=0;for(;;){const done=await queue.processOne(db,handlers,{owner:'order-check-test',kinds:[screening.KIND]});
    if(!done)return n;assert.equal(done.status,'COMPLETED');n++;}};
  const jobs=async()=>Number((await db.query('SELECT count(*) n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2',[ws,screening.KIND])).rows[0].n);
  let street=50;
  const order=async(extra={})=>(await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',
    fulfillmentLocationId:f.location.id,shipToAddress:(++street)+' Harbor Ave, Troy, NY 12180',idempotencyKey:randomUUID(),
    lines:[{skuId:sku,quantity:20,unitPriceMinor:500,priceOverride:true}],...extra}));
  const checkRow=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_order_checks WHERE workspace_id=$1 AND sales_order_id=$2',[ws,id])).rows[0];
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  const checkNeeds=async()=>(await needs()).filter(n=>String(n.sourceId).startsWith('order-check-'));
  const mode=async value=>{const r=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=54',[ws])).rows[0];
    await modes.save(db,ctx,54,{mode:value,revision:r?.revision||0});};
  return {...f,ws,sku,earlier,today,yesterday,work,jobs,order,checkRow,audits,needs,checkNeeds,mode};
}

async function screens(t,f,paths){
  const {db}=f,app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');
  require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const [page,heading,check,file] of paths){
      await view.goto(base+page);
      assert(await view.getByRole('heading',{name:heading,exact:true}).first().isVisible(),heading+' at '+name);
      if(check)await check(view);
      await view.waitForTimeout(400);
      await view.screenshot({path:path.join(folder,'order-checks-'+file+'-'+name+'.png'),fullPage:true});
      assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),page+' must not scroll sideways on '+name);
    }
    await view.close();
  }
}

test('Starter gets one sample check; Growth, Pro and Custom check every new or changed order through the worker and flag its problems',{timeout:600000},async t=>{
  const f=await setup(t),{db,ctx,browser}=f;

  // Starter: nothing runs on its own. One sample check answers when asked.
  await f.subscribe('starter');
  const a=await f.order();
  assert.equal(await f.jobs(),0,'Starter never queues automatic checks.');
  const sample=await reviews.run(db,ctx,'sales-order-checks',{filter:a.orderNumber});
  assert.equal(sample.rows.length,1);
  assert.match(sample.rows[0].Suggestion,/Sample check: Stock: Only 9 of the 20 units of PARCEL-/);
  assert.match(sample.rows[0].Suggestion,/Credit: 1 overdue invoice/);
  assert.match(sample.rows[0].Suggestion,/Address: The ship-to address changed since SO-/);
  assert.match(sample.rows[0].Suggestion,/below the customer’s agreed price of \$9\.00/);
  assert.match(sample.rows[0].Suggestion,/Checking every order on its own needs Growth/);
  const starterPage=(await browser.get('/orders/'+a.salesOrderId).expect(200)).text;
  assert.match(starterPage,/See a sample check/);assert.match(starterPage,/needs Growth/);
  await assert.rejects(screening.saveSettings(db,ctx,{discountPercent:'30'}),e=>e.code==='entitlement_required');
  assert.deepEqual(await screening.schedule(db,f.ws),{queued:0});

  // Growth checks each new order on its own once it is committed.
  await f.subscribe('growth');
  const b=await f.order();
  assert.equal(await f.jobs(),1);
  const before=(await db.query('SELECT status,version,ship_to_address FROM sales_orders WHERE id=$1',[b.salesOrderId])).rows[0];
  assert.equal(await f.work(),1);
  const flagged=await f.checkRow(b.salesOrderId);
  assert.equal(flagged.status,'FLAGGED');assert.equal(flagged.trigger,'created');
  assert.deepEqual([...new Set(flagged.findings.map(x=>x.check))],['stock','credit','address','price']);
  const text=screening.describe(flagged.findings);
  assert.match(text,/Stock: Only 9 of the 20 units/);
  assert.match(text,/Credit: 1 overdue invoice \(\$9\.00\), the oldest due /);
  assert.match(text,/Credit: Over the credit limit: \$109\.00 owed or ordered against a limit of \$10\.00/);
  assert.match(text,/Address: The ship-to address changed since SO-/);
  assert.match(text,/Price: PARCEL-\S+ is 50% below its list price of \$10\.00\. Your limit is 20%/);
  assert.match(text,/below the customer’s agreed price of \$9\.00/);
  assert.deepEqual((await db.query('SELECT status,version,ship_to_address FROM sales_orders WHERE id=$1',[b.salesOrderId])).rows[0],before,'A check never changes the order.');
  assert.equal(await f.audits('Order check found problems'),1);
  // Replaying the same check is idempotent.
  await screening.run(db,f.ws,{orderId:b.salesOrderId,trigger:'created'});
  assert.equal(await f.audits('Order check found problems'),1);
  assert.equal((await f.checkNeeds()).length,1);
  assert.match((await f.checkNeeds())[0].why,/Stock: Only 9/);
  const page=(await browser.get('/orders/'+b.salesOrderId).expect(200)).text;
  assert.match(page,/Order checks/);assert.match(page,/6 problems need a person/);assert.match(page,/does not change or cancel the order/);
  const review=await reviews.run(db,ctx,'sales-order-checks',{filter:b.orderNumber});
  assert.equal(review.rows[0]['Automatic check'],'6 problems: stock, credit, address, price');

  // Bad data: an incomplete address stops at a question, not a guess.
  const vague=await f.order({shipToAddress:'Back door',lines:[{skuId:f.sku,quantity:1,unitPriceMinor:900}]});
  await f.work();
  assert.match(screening.describe((await f.checkRow(vague.salesOrderId)).findings),/Address: The delivery address is missing the /);

  // The owner's discount limit, the customer's payment and confirmation change the next check.
  await assert.rejects(screening.saveSettings(db,ctx,{discountPercent:'0'}),/from 1 to 100 percent/);
  const settingsPage=await browser.get('/autopilot/reviews/sales-order-checks').expect(200);
  assert.match(settingsPage.text,/Save discount limit/);
  await browser.post('/autopilot/reviews/sales-order-checks/settings').type('form').send({_csrf:f.csrf(settingsPage.text),discountPercent:'60'}).expect(303);
  assert.equal((await screening.settings(db,ctx)).discountPercent,60);
  const invoice=(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[f.ws,f.earlier.order.salesOrderId])).rows[0];
  await f.workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:invoice.id,method:'cash',paymentDate:f.today,
    amountMinor:Number(invoice.balance_minor),idempotencyKey:randomUUID()});
  await f.workflows.confirmSalesOrder(db,ctx,b.salesOrderId,{idempotencyKey:randomUUID()});
  await f.work();
  const confirmed=await f.checkRow(b.salesOrderId);
  assert.equal(confirmed.trigger,'confirmed');
  const after=screening.describe(confirmed.findings);
  assert.match(after,/Stock: Only 0 of the 11 units/,'Confirmation reserved the 9 free units.');
  assert.doesNotMatch(after,/overdue/);assert.doesNotMatch(after,/list price/);
  assert.equal(await f.audits('Order check found problems'),3);

  // Pause, Ask me first and shadow mode only watch; the routine catches up later.
  await autopilot.pause(db,ctx,{role:'owner'},'Order check test');
  const paused=await f.order();
  await f.work();
  assert.equal(await f.checkRow(paused.salesOrderId),undefined);
  assert.deepEqual(await screening.schedule(db,f.ws),{queued:0});
  await autopilot.resume(db,ctx,{role:'owner'});
  assert.ok((await screening.schedule(db,f.ws)).queued>=1);
  await f.work();
  assert.equal((await f.checkRow(paused.salesOrderId)).trigger,'routine');
  await f.mode('ask');
  const asked=await f.order();await f.work();
  assert.equal(await f.checkRow(asked.salesOrderId),undefined,'Ask me first keeps checks for when you ask.');
  await f.mode('inherit');
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  const shadow=await f.order();await f.work();
  assert.equal(await f.checkRow(shadow.salesOrderId),undefined,'Shadow mode only watches.');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  // Pro and Custom check on their own too.
  for(const tier of ['pro','enterprise']){
    await f.subscribe(tier);
    const o=await f.order();await f.work();
    const row=await f.checkRow(o.salesOrderId);
    assert.equal(row.status,'FLAGGED',tier);assert.match(screening.describe(row.findings),/Address: The ship-to address changed/,tier);
  }

  // Pages render at desktop width and on a phone.
  await screens(t,f,[
    ['/orders/'+b.salesOrderId,b.orderNumber+' · Receiver',async view=>assert(await view.getByRole('heading',{name:'Order checks'}).isVisible()),'order'],
    ['/autopilot/reviews/sales-order-checks','Check open customer orders',null,'review'],
  ]);

  // After a downgrade the flags leave Needs you and the job runs no more.
  await f.subscribe('starter');
  assert.equal((await f.checkNeeds()).length,0);
  const late=await f.order();
  assert.equal(await f.checkRow(late.salesOrderId),undefined);
});
