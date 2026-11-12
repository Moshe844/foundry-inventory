'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

// Job 59 on every plan: the chosen label is bought through the carrier
// adapter within the owner's $ per label and 24-hour limits, or prepared for
// one tap. A test carrier stands in for the connected account.
async function setup(t,units=40){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units}),{db,ctx}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const state={buys:0,voids:0,price:150,voidAnswer:null};
  const carrier={
    quote:async()=>({providerShipmentIds:['parcel'],rates:[{rateId:'ground',carrier:'usps',service:'Ground Advantage',amountMinor:state.price,currency:'USD',deliveryDate:day(3)},
      {rateId:'late',carrier:'usps',service:'Media Mail',amountMinor:5,currency:'USD',deliveryDate:day(3)}]}),
    buy:async(_ctx,input)=>{state.buys++;return {providerLabelIds:['label-'+state.buys],providerShipmentId:'label-'+state.buys,trackingNumber:'TRACK'+state.buys,
      labelUrl:'https://labels.example.test/'+state.buys+'.pdf',labelFormat:'PDF',amountMinor:input.approvedAmountMinor,currency:'USD',carrier:'usps',service:'Ground Advantage'};},
    voidLabel:async(_ctx,input)=>{state.voids++;return state.voidAnswer||{status:'SUCCEEDED',refundStatus:'PENDING',references:input.providerReferences,detail:'The carrier voided the label.'};},
    verifyVoid:async(_ctx,input)=>({status:'SUCCEEDED',refundStatus:'PENDING',references:input.providerReferences})};
  const labels=require('../../src/shipping/agent-labels'),jobs=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{shippingProviderResolver:()=>carrier});
  const parcel=async(promised=day(7))=>{const p=await f.parcel();await db.query('UPDATE sales_orders SET needed_by=$2 WHERE id=$1',[p.order.salesOrderId,promised]);return p;};
  const routine=()=>labels.run(db,{workspaceId:ctx.workspaceId},{providerResolver:()=>carrier});
  const choice=async id=>(await db.query(`SELECT * FROM stockchief_runtime.agent_label_runs WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY updated_at DESC LIMIT 1`,[ctx.workspaceId,id])).rows[0];
  const work=async()=>{let ran=0;for(;;){const done=await jobs.processOne(db,{'provider.effect':handlers['provider.effect']},{owner:'label-worker'});if(!done||done.status==='IDLE'||!done.status)break;ran++;if(ran>20)break;}return ran;};
  const label=async id=>(await f.shipping.requireShipment(db,ctx.workspaceId,id)).label_status;
  const limits=(perLabel,rollingDay)=>require('../../src/shipping/postgres-purchase-policy').save(db,ctx,{currency:'USD',perLabelMinor:perLabel,rollingDayMinor:rollingDay});
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('label-run:'));
  const auto=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
  return {f,db,ctx,state,carrier,labels,parcel,routine,choice,work,label,limits,needs,auto,modes,day,handlers,jobs};
}

test('Growth, Pro and Custom buy the chosen label alone within the owner limits; Starter gets one tap per shipment',{timeout:300000},async t=>{
  const {f,db,ctx,state,labels,parcel,routine,choice,work,label,limits,needs,auto}=await setup(t);
  // Starter never spends alone: each shipment's label waits for one tap.
  await f.subscribe('starter');
  const s=await parcel();await routine();let run=await choice(s.shipmentId);
  assert.deepEqual([run.status,run.mode],['SUGGESTED','suggest']);await work();assert.equal(state.buys,0);
  assert.ok((await needs()).some(n=>n.sourceId==='label-run:'+run.id&&n.actionLabel==='Approve the label'));
  await labels.approve(db,ctx,s.shipmentId,{runId:run.id});await work();assert.equal(await label(s.shipmentId),'PURCHASED');assert.equal(state.buys,1);

  // Growth, taught by the saved rule, buys alone up to $25 a label.
  await f.subscribe('growth');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await labels.configure(db,ctx,{enabled:true});
  assert.match((await f.browser.get('/settings/shipping').expect(200)).text,/never over \$25 a label/);
  const g=await parcel();await routine();run=await choice(g.shipmentId);
  assert.deepEqual([run.status,run.mode,run.decided_by],['QUEUED','automatic',null]);
  await work();assert.equal(await label(g.shipmentId),'PURCHASED');assert.equal(state.buys,2);
  await routine();await work();assert.equal(state.buys,2,'running again buys nothing twice');
  assert.equal((await db.query('SELECT count(*)::int n FROM shipping_label_transactions WHERE shipment_id=$1',[g.shipmentId])).rows[0].n,1);
  state.price=2501;const over=await parcel();await routine();run=await choice(over.shipmentId);
  assert.equal(run.status,'CHOSEN');assert.match(run.label_reason,/\$25/);await work();assert.equal(state.buys,2);
  assert.ok((await needs()).some(n=>n.sourceId==='label-run:'+run.id&&/\$25/.test(n.why)));
  await labels.approve(db,ctx,over.shipmentId,{runId:run.id});await work();assert.equal(await label(over.shipmentId),'PURCHASED');assert.equal(state.buys,3);
  // The owner's own lower $ per label and 24-hour limit hold labels too.
  state.price=1500;await limits(1000,null);
  const capped=await parcel();await routine();run=await choice(capped.shipmentId);
  assert.equal(run.status,'CHOSEN');assert.match(run.label_reason,/per-parcel postage limit/);
  await limits(null,150+150+2501+1500);state.price=1500;
  const daily=await parcel();await routine();assert.equal((await choice(daily.shipmentId)).status,'QUEUED');await work();
  const nextDay=await parcel();await routine();assert.match((await choice(nextDay.shipmentId)).label_reason,/24-hour/);
  await limits(null,null);

  // Pro and Custom buy alone only within the owner's saved $ per label.
  state.price=4000;await f.subscribe('pro');
  assert.match((await f.browser.get('/settings/shipping').expect(200)).text,/only once a maximum per parcel is set/);
  for(const tier of ['pro','enterprise']){
    await f.subscribe(tier);await limits(null,null);
    const unset=await parcel();await routine();run=await choice(unset.shipmentId);
    assert.equal(run.status,'CHOSEN',tier);assert.match(run.label_reason,/Set your \$ per label/,tier);
    await limits(5000,null);await routine();run=await choice(unset.shipmentId);
    assert.equal(run.status,'QUEUED',tier+' retries once the limit is saved');
    await work();assert.equal(await label(unset.shipmentId),'PURCHASED',tier);
  }
  // The Growth labels left over the owner's limits were bought once Pro's limit allowed them.
  assert.deepEqual([await label(capped.shipmentId),await label(nextDay.shipmentId)],['PURCHASED','PURCHASED']);assert.equal(state.buys,8);
  const bought=Number((await db.query("SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action='Bought a shipping label within your limits'",[ctx.workspaceId])).rows[0].n);
  assert.equal(bought,6);assert.equal(await f.balance(),40,'buying labels never moves stock');
});

test('Ask me first, pause, observe, shadow and a downgrade stop the purchase before the carrier',{timeout:300000},async t=>{
  const {f,db,ctx,state,labels,parcel,routine,choice,work,label,limits,auto,modes}=await setup(t);
  await f.subscribe('pro');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await limits(5000,null);
  await modes.save(db,ctx,59,{mode:'ask',revision:0});
  const ask=await parcel();await routine();let run=await choice(ask.shipmentId);
  assert.equal(run.status,'CHOSEN');assert.match(run.label_reason,/Ask me first/);await work();assert.equal(state.buys,0);
  await modes.save(db,ctx,59,{mode:'inherit',revision:1});await routine();assert.equal((await choice(ask.shipmentId)).status,'QUEUED');
  await work();assert.equal(state.buys,1);
  await auto.pause(db,ctx,{role:'owner'},'Checking postage');
  const paused=await parcel();await routine();assert.notEqual((await choice(paused.shipmentId)).status,'QUEUED');await work();assert.equal(state.buys,1);
  await auto.resume(db,ctx,{role:'owner'});
  await auto.setMode(db,ctx,{role:'owner'},'OBSERVE');
  const observed=await parcel();await routine();assert.equal((await choice(observed.shipmentId)).mode,'watch');
  await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const shadow=await parcel();await routine();assert.equal((await choice(shadow.shipmentId)).mode,'watch');await work();assert.equal(state.buys,1);
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  // A downgrade after the label was queued stops it before the carrier.
  const late=await parcel();await routine();assert.equal((await choice(late.shipmentId)).status,'QUEUED');
  await f.subscribe('starter');await work();assert.equal(state.buys,1);assert.notEqual(await label(late.shipmentId),'PURCHASED');
  // The address check (job 69) still applies to an agent purchase.
  await f.subscribe('pro');
  const moved=await parcel();await routine();assert.equal((await choice(moved.shipmentId)).status,'QUEUED');
  await db.query("UPDATE sales_orders SET ship_to_address='5 Elsewhere Ave, Troy, NY 12180' WHERE id=$1",[moved.order.salesOrderId]);
  await work();assert.equal(state.buys,1);assert.equal(await label(moved.shipmentId),'FAILED');
});

test('cancelling an order before handoff voids its unused label where the carrier can',{timeout:300000},async t=>{
  const {f,db,ctx,state,parcel,routine,work,label,limits,auto}=await setup(t,12);
  await f.subscribe('pro');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await limits(5000,null);
  const voidEffects=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='shipping.label.void' AND aggregate_id=$2",[ctx.workspaceId,id])).rows;
  const p=await parcel();await routine();await work();assert.equal(await label(p.shipmentId),'PURCHASED');
  await f.workflows.cancelSalesOrder(db,ctx,p.order.salesOrderId,{idempotencyKey:'cancel-one',reason:'Customer changed their mind'});
  assert.equal((await db.query('SELECT status FROM sales_orders WHERE id=$1',[p.order.salesOrderId])).rows[0].status,'CANCELLED');
  let parcelRow=await f.shipping.requireShipment(db,ctx.workspaceId,p.shipmentId);assert.deepEqual([parcelRow.status,parcelRow.label_status],['PACKED','VOID_PENDING']);
  const page=await f.browser.get('/orders/'+p.order.salesOrderId).expect(200);assert.match(page.text,/unused label is being voided with the carrier/);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:require('node:crypto').randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const width of [1280,390]){
    const tab=await chrome.newPage({viewport:{width,height:900}});tab.setDefaultTimeout(15000);
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(origin+'/orders/'+p.order.salesOrderId);
    assert.match(await tab.locator('[data-cancel-void]').innerText(),/being voided with the carrier/);
    assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll at '+width);
    await tab.close();
  }
  await f.workflows.cancelSalesOrder(db,ctx,p.order.salesOrderId,{idempotencyKey:'cancel-one',reason:'Customer changed their mind'});
  assert.equal((await voidEffects(p.shipmentId)).length,1,'replaying the cancellation asks once');
  await work();assert.equal(state.voids,1);
  parcelRow=await f.shipping.requireShipment(db,ctx.workspaceId,p.shipmentId);assert.deepEqual([parcelRow.status,parcelRow.label_status],['CANCELLED','VOIDED']);
  assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Voided the unused label of a cancelled order'",[ctx.workspaceId])).rows[0].n,1);
  // When the carrier refuses, the label stays and the order says so.
  state.voidAnswer={status:'FAILED',refundStatus:'REJECTED',references:[],detail:'Label already scanned.'};
  const kept=await parcel();await routine();await work();
  await f.workflows.cancelSalesOrder(db,ctx,kept.order.salesOrderId,{idempotencyKey:'cancel-two'});await work();
  assert.equal(await label(kept.shipmentId),'PURCHASED');assert.equal(state.voids,2);
  assert.match((await f.browser.get('/orders/'+kept.order.salesOrderId).expect(200)).text,/still has a saved label/);
  // A label the carrier cannot void, or one never verified, still stops the cancellation.
  const unverified=await parcel();
  await db.query("UPDATE sales_shipments SET label_status='PURCHASED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,unverified.shipmentId]);
  await assert.rejects(f.workflows.cancelSalesOrder(db,ctx,unverified.order.salesOrderId,{idempotencyKey:'cancel-three'}),/void/i);
  assert.notEqual((await db.query('SELECT status FROM sales_orders WHERE id=$1',[unverified.order.salesOrderId])).rows[0].status,'CANCELLED');
  assert.equal(await f.balance(),12,'no stock left for a cancelled order');
});
