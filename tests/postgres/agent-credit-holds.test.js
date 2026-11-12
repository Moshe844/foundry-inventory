'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const holds=require('../../src/sales/agent-credit-holds');
const screening=require('../../src/sales/agent-order-screening');
const reviews=require('../../src/autopilot/job-reviews');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const waves=require('../../src/operations/postgres-fulfillment-waves');

// One shipped parcel leaves the fixture customer a $12.00 invoice that the
// test makes 40 days overdue. Each new order is a 1-unit pickup or parcel.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12}),{db,ctx,workflows,shipping}=f;
  const ws=ctx.workspaceId,sku=f.item.skuIds[0];
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const earlier=await f.parcel({quantity:1});
  await shipping.markPacked(db,ctx,earlier.shipmentId);
  await shipping.handoff(db,ctx,earlier.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TRACK-CREDIT-HOLD'});
  const today=await require('../../src/lib/business-time').today(db,ws),days=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const invoice=async id=>(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[ws,id])).rows[0];
  const overdue=async(id,n=40)=>db.query('UPDATE accounting_customer_invoices SET due_date=$2 WHERE workspace_id=$1 AND sales_order_id=$3',[ws,days(-n),id]);
  await overdue(earlier.order.salesOrderId);
  const pay=async(id,amountMinor)=>{const bill=await invoice(id);return workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:bill.id,
    method:'cash',paymentDate:today,amountMinor:amountMinor??Number(bill.balance_minor),idempotencyKey:randomUUID()});};
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(),queue=require('../../src/operations/postgres-job-queue');
  const work=async()=>{let n=0;for(;;){const done=await queue.processOne(db,handlers,{owner:'credit-hold-test',kinds:[screening.KIND,holds.KIND]});
    if(!done)return n;assert.equal(done.status,'COMPLETED');n++;}};
  const order=async(method='PICKUP')=>(await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:method,
    fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:1200}]}));
  const confirm=id=>workflows.confirmSalesOrder(db,ctx,id,{idempotencyKey:randomUUID()});
  const held=async id=>(await db.query("SELECT * FROM stockchief_runtime.agent_order_credit_holds WHERE workspace_id=$1 AND sales_order_id=$2 AND status='HELD'",[ws,id])).rows[0];
  const history=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_order_credit_holds WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY placed_at,id',[ws,id])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('credit-hold-'));
  const mode=async value=>{const r=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=55',[ws])).rows[0];
    await modes.save(db,ctx,55,{mode:value,revision:r?.revision||0});};
  const saveRule=async fields=>{const page=await f.browser.get('/autopilot/reviews/overdue-customer-orders').expect(200);
    return f.browser.post('/autopilot/reviews/overdue-customer-orders/rule').type('form').send({_csrf:f.csrf(page.text),...fields});};
  return {...f,ws,sku,earlier,today,days,invoice,overdue,pay,work,order,confirm,held,history,audits,needs,mode,saveRule};
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
      await view.screenshot({path:path.join(folder,'credit-holds-'+file+'-'+name+'.png'),fullPage:true});
      assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),page+' must not scroll sideways on '+name);
    }
    await view.close();
  }
}

test('Starter is locked, Growth suggests holds, and Pro and Custom hold overdue customers’ orders on their own until full payment',{timeout:600000},async t=>{
  const f=await setup(t),{db,ctx,browser,shipping}=f;

  // Starter: excluded, with the plan lock.
  await f.subscribe('starter');
  const a=await f.order();
  await assert.rejects(reviews.run(db,ctx,'overdue-customer-orders'),e=>e.code==='entitlement_required');
  await assert.rejects(holds.configure(db,ctx,{mode:'on',days:'30'}),e=>e.code==='entitlement_required');
  assert.doesNotMatch((await browser.get('/orders/'+a.salesOrderId).expect(200)).text,/credit hold/i);

  // Growth: suggestions only.
  await f.subscribe('growth');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  assert.match((await reviews.run(db,ctx,'overdue-customer-orders')).rows[0].Suggestion,/credit hold/);
  assert.match((await browser.get('/autopilot/reviews/overdue-customer-orders').expect(200)).text,/Automatic holds require Pro/);
  await assert.rejects(holds.configure(db,ctx,{mode:'on',days:'30'}),e=>e.code==='entitlement_required');
  await assert.rejects(holds.holdByPerson(db,ctx,a.salesOrderId),e=>e.code==='entitlement_required');
  const growthPage=(await browser.get('/orders/'+a.salesOrderId).expect(200)).text;
  assert.match(growthPage,/Consider holding this order until they pay/);assert.match(growthPage,/Automatic holds need Pro/);
  assert.deepEqual(await holds.sweep(db,f.ws),{placed:0,released:0,watching:true});
  await f.confirm(a.salesOrderId);

  // Pro: before the rule, a parcel and a confirmed order are ready to go.
  await f.subscribe('pro');
  const parcel=await f.parcel({quantity:1});
  await shipping.markPacked(db,ctx,parcel.shipmentId);
  const ready=await f.order();await f.confirm(ready.salesOrderId);
  const ship=await f.order('SHIP');await f.confirm(ship.salesOrderId);
  await f.work();
  assert.equal(await f.held(ready.salesOrderId),undefined,'Nothing is held without the owner’s rule.');

  // The owner's rule: more than 30 days overdue and at least $5.00.
  await assert.rejects(holds.configure(db,ctx,{mode:'on',days:'0'}),/from 1 to 365/);
  await assert.rejects(holds.configure(db,ctx,{mode:'on',days:'30',amount:'-2'}),/negative|positive/);
  assert.equal((await f.saveRule({mode:'on',days:'30',amount:'5.00'})).status,303);
  assert.match(holds.describeRule(await holds.rule(db,f.ws)),/more than 30 days overdue totalling at least \$5\.00/);
  assert.equal(await f.audits('Overdue customer order rule changed'),1);

  // The routine holds every open order of the overdue customer, once.
  const swept=await holds.sweep(db,f.ws);
  assert.equal(swept.placed,4,'The routine held the open orders: '+JSON.stringify(swept));
  for(const id of [a.salesOrderId,parcel.order.salesOrderId,ready.salesOrderId,ship.salesOrderId])assert.match((await f.held(id)).reason,/1 invoice more than 30 days overdue, the oldest due .*, with \$12\.00 unpaid/);
  const placed=await f.audits('Order put on credit hold');
  assert.deepEqual(await holds.sweep(db,f.ws),{placed:0,released:0,watching:false},'Replays hold nothing twice.');
  assert.equal(await f.audits('Order put on credit hold'),placed);

  // A held order cannot be confirmed, picked, packed into a parcel or shipped.
  await assert.rejects(f.confirm(ready.salesOrderId),/on credit hold/);
  assert.ok(!(await waves.readyOrders(db,f.ws)).some(o=>o.id===ready.salesOrderId),'Held orders are not offered for picking.');
  await assert.rejects(waves.create(db,ctx,{orderIds:[ready.salesOrderId],idempotencyKey:randomUUID()}),/on credit hold/);
  const shipLine=(await db.query('SELECT id FROM sales_order_lines WHERE sales_order_id=$1',[ship.salesOrderId])).rows[0];
  await assert.rejects(shipping.prepare(db,ctx,ship.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:shipLine.id,locationId:f.location.id,quantity:1}]}),/on credit hold/);
  await assert.rejects(shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TRACK-HELD'}),/on credit hold/);
  const line=(await db.query('SELECT id FROM sales_order_lines WHERE sales_order_id=$1',[ready.salesOrderId])).rows[0];
  await assert.rejects(f.workflows.fulfillSalesOrder(db,ctx,ready.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:line.id,locationId:f.location.id,quantity:1}]}),/on credit hold/);

  // New orders are held by the worker as soon as they are created.
  const fresh=await f.order();
  await f.work();
  assert.ok(await f.held(fresh.salesOrderId));
  assert.equal((await f.needs()).length,5);
  assert.match((await f.needs())[0].title,/is on credit hold/);
  const heldPage=(await browser.get('/orders/'+fresh.salesOrderId).expect(200)).text;
  assert.match(heldPage,/On credit hold/);assert.match(heldPage,/Release the hold/);
  assert.match(heldPage,/The order is on credit hold\./,'The order check reports the hold it found.');

  // A partial payment keeps the holds; full payment releases them on its own.
  await f.pay(f.earlier.order.salesOrderId,500);await f.work();
  assert.ok(await f.held(fresh.salesOrderId),'A partial payment keeps the hold.');
  await f.pay(f.earlier.order.salesOrderId);await f.work();
  for(const id of [a.salesOrderId,parcel.order.salesOrderId,ready.salesOrderId,ship.salesOrderId,fresh.salesOrderId])
    assert.equal(await f.held(id),undefined,'Full payment released '+id);
  assert.equal(await f.audits('Credit hold released after full payment'),5);
  await shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TRACK-RELEASED'});
  await f.confirm(ready.salesOrderId);

  // Below the owner's amount, nothing is held; another currency needs a person.
  assert.equal((await f.saveRule({mode:'on',days:'30',amount:'100.00'})).status,303);
  await f.overdue(parcel.order.salesOrderId,45);
  assert.equal((await holds.sweep(db,f.ws)).placed,0,'Under the owner’s amount.');
  await db.query("UPDATE accounting_customer_invoices SET currency='EUR' WHERE workspace_id=$1 AND sales_order_id=$2",[f.ws,parcel.order.salesOrderId]);
  assert.equal((await holds.sweep(db,f.ws)).placed,0,'Amounts in another currency stop and ask.');
  await db.query("UPDATE accounting_customer_invoices SET currency='USD' WHERE workspace_id=$1 AND sales_order_id=$2",[f.ws,parcel.order.salesOrderId]);
  assert.equal((await f.saveRule({mode:'on',days:'30',amount:''})).status,303);
  assert.ok((await holds.sweep(db,f.ws)).placed>=1);

  // A person releases a hold; the rule leaves that order alone. Putting it back undoes the release.
  await holds.releaseByPerson(db,ctx,fresh.salesOrderId,{note:'Paying on Friday'});
  assert.equal(await f.held(fresh.salesOrderId),undefined);
  await f.confirm(fresh.salesOrderId);
  assert.equal((await holds.sweep(db,f.ws)).placed,0);
  assert.equal((await f.history(fresh.salesOrderId)).at(-1).release_note,'Paying on Friday');
  await holds.holdByPerson(db,ctx,fresh.salesOrderId);
  assert.equal((await f.held(fresh.salesOrderId)).placed_by_kind,'PERSON');
  assert.equal(await f.audits('Credit hold released by a person'),1);
  assert.equal(await f.audits('Order put on credit hold by a person'),1);
  await holds.releaseByPerson(db,ctx,fresh.salesOrderId);

  // Pause, Ask me first and shadow mode hold nothing on their own.
  await autopilot.pause(db,ctx,{role:'owner'},'Credit hold test');
  const paused=await f.order();await f.work();
  assert.equal(await f.held(paused.salesOrderId),undefined);
  assert.equal((await holds.sweep(db,f.ws)).watching,true);
  await autopilot.resume(db,ctx,{role:'owner'});
  await f.mode('ask');
  assert.equal((await holds.sweep(db,f.ws)).watching,true);
  const askPage=(await browser.get('/orders/'+paused.salesOrderId).expect(200)).text;
  assert.match(askPage,/Hold this order/);
  await f.mode('inherit');
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  assert.equal((await holds.sweep(db,f.ws)).watching,true,'Shadow mode only watches.');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  assert.ok((await holds.sweep(db,f.ws)).placed>=1);
  assert.ok(await f.held(paused.salesOrderId));

  // Custom holds on its own too.
  await f.subscribe('enterprise');
  const custom=await f.order();await f.work();
  assert.ok(await f.held(custom.salesOrderId));

  // Pages render at desktop width and on a phone.
  await screens(t,f,[
    ['/orders/'+custom.salesOrderId,custom.orderNumber+' · Receiver',async view=>assert(await view.getByRole('heading',{name:'On credit hold'}).isVisible()),'order'],
    ['/autopilot/reviews/overdue-customer-orders','Review orders from overdue customers',null,'review'],
  ]);

  // Turning the rule off releases what the rule held, not a person's hold. After
  // a downgrade, a person's hold still blocks until a person releases it.
  await holds.holdByPerson(db,ctx,fresh.salesOrderId);
  assert.equal((await f.saveRule({mode:'off'})).status,303);
  assert.equal(await f.held(custom.salesOrderId),undefined,'The rule’s holds end with the rule.');
  assert.ok(await f.held(fresh.salesOrderId),'A person’s hold stays.');
  assert.ok(await f.audits('Credit hold released when the rule was turned off')>=1);
  await f.subscribe('starter');
  await assert.rejects(f.confirm(fresh.salesOrderId),/on credit hold/);
  assert.match((await browser.get('/orders/'+fresh.salesOrderId).expect(200)).text,/Release the hold/);
  await holds.releaseByPerson(db,ctx,fresh.salesOrderId);
  await f.confirm(fresh.salesOrderId);
});
