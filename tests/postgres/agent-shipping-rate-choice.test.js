'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 58 on every plan: StockChief compares the current quotes from the
// connected accounts and picks the cheapest that arrives by the promised date.
// A test carrier stands in for the connected accounts; nothing live is called.
async function setup(t,units=40){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units}),{db,ctx}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const state={quotes:0,buys:0,bump:0};
  const rates=()=>[
    {rateId:'late',carrier:'ups',service:'Ground',amountMinor:100+state.bump,currency:'USD',deliveryDate:day(8)},
    {rateId:'media',carrier:'usps',service:'Media Mail',amountMinor:10,currency:'USD',deliveryDate:day(3)},
    {rateId:'cutoff',carrier:'usps',service:'Priority Mail',amountMinor:130+state.bump,currency:'USD',deliveryDays:1,shipDate:day(9)},
    {rateId:'slow',carrier:'fedex',service:'Ground Economy',amountMinor:120+state.bump,currency:'USD',deliveryDays:9},
    {rateId:'transit',carrier:'usps',service:'Ground Advantage',amountMinor:150+state.bump,currency:'USD',deliveryDays:2,shipDate:day(1)},
    {rateId:'timely',carrier:'ups',service:'2nd Day Air',amountMinor:state.upsCheap?5:200+state.bump,currency:'USD',deliveryDate:day(3)},
    {rateId:'euro',carrier:'dhl',service:'Express',amountMinor:50,currency:'EUR',deliveryDate:day(1)}];
  const carrier={quote:async()=>{state.quotes++;return {providerShipmentIds:['parcel'],rates:rates()};},
    buy:async(_ctx,input)=>{state.buys++;return {providerLabelIds:['label-'+state.buys],providerShipmentId:'label-'+state.buys,trackingNumber:'TRACK'+state.buys,
      labelUrl:'https://labels.example.test/'+state.buys+'.pdf',labelFormat:'PDF',amountMinor:input.approvedAmountMinor,currency:'USD',carrier:'usps',service:'Ground Advantage'};}};
  const labels=require('../../src/shipping/agent-labels');
  const parcel=async(promised=day(7))=>{const p=await f.parcel();await db.query('UPDATE sales_orders SET needed_by=$2 WHERE id=$1',[p.order.salesOrderId,promised]);return p;};
  const routine=()=>labels.run(db,{workspaceId:ctx.workspaceId},{providerResolver:()=>carrier});
  const choice=async id=>(await db.query(`SELECT * FROM stockchief_runtime.agent_label_runs WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY updated_at DESC LIMIT 1`,[ctx.workspaceId,id])).rows[0];
  const finish=async result=>require('../../src/shipping/postgres-service').executeLabelPurchaseEffect(db,ctx.workspaceId,result.run.effect_id,{provider:carrier});
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('label-run:'));
  const auto=require('../../src/autopilot/postgres-service');
  return {f,db,ctx,state,carrier,labels,parcel,routine,choice,finish,needs,day,auto,today};
}

test('every plan picks the cheapest rate that arrives by the promised date, per its mode',{timeout:300000},async t=>{
  const {f,db,ctx,state,labels,parcel,routine,choice,finish,needs,day,auto}=await setup(t);
  await f.subscribe('growth');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  // Buying labels alone is job 59; here every chosen label waits for a tap.
  await require('../../src/autopilot/job-modes').save(db,ctx,59,{mode:'ask',revision:0});

  // Starter: the suggestion, and one tap buys its label.
  await f.subscribe('starter');
  const s=await parcel();await routine();let run=await choice(s.shipmentId);
  assert.deepEqual([run.status,run.mode,run.service,Number(run.amount_minor),run.currency],['SUGGESTED','suggest','Ground Advantage',150,'USD']);
  assert.equal(run.promised_date,day(7));assert.equal(run.arrival_date,require('../../src/shipping/agent-labels').addBusinessDays(day(1),2),'transit days count from the carrier ship date');
  assert.equal(state.buys,0);assert.ok((await needs()).some(n=>/Approve the label for order/.test(n.title)&&/Ground Advantage at \$1\.50/.test(n.happened)));
  const quotes=state.quotes;await routine();assert.equal(state.quotes,quotes,'a waiting suggestion is not quoted again');
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_label_runs WHERE shipment_id=$1',[s.shipmentId])).rows[0].n,1);
  const tapped=await labels.approve(db,ctx,s.shipmentId,{runId:run.id});assert.equal(tapped.queued,true);
  assert.equal((await labels.approve(db,ctx,s.shipmentId,{runId:run.id})).replayed,true,'a second tap buys nothing more');
  await finish(tapped);assert.equal(state.buys,1);
  assert.equal((await f.shipping.requireShipment(db,ctx.workspaceId,s.shipmentId)).service,'Ground Advantage');

  // Growth suggests until the owner approves an example, then chooses alone up to that price.
  await f.subscribe('growth');
  const g1=await parcel();await routine();run=await choice(g1.shipmentId);
  // The Starter approval above already taught a $1.50 example.
  assert.deepEqual([run.status,run.mode],['CHOSEN','automatic']);
  state.bump=10;const g2=await parcel();await routine();run=await choice(g2.shipmentId);
  assert.deepEqual([run.status,run.mode,Number(run.amount_minor)],['SUGGESTED','draft',160],'a dearer rate than any approved example waits');
  const approved=await labels.approve(db,ctx,g2.shipmentId,{runId:run.id});await finish(approved);
  const g3=await parcel();await routine();assert.deepEqual([(await choice(g3.shipmentId)).status,(await choice(g3.shipmentId)).mode],['CHOSEN','automatic']);
  state.bump=40;const g4=await parcel();await routine();assert.equal((await choice(g4.shipmentId)).mode,'draft');
  await labels.configure(db,ctx,{enabled:true});
  await routine();assert.equal((await choice(g4.shipmentId)).mode,'automatic','the saved rule teaches the rest');
  await labels.configure(db,ctx,{enabled:false});

  // Pro and Custom choose on their own without training.
  state.bump=500;
  for(const tier of ['pro','enterprise']){await f.subscribe(tier);const p=await parcel();await routine();
    assert.deepEqual([(await choice(p.shipmentId)).status,(await choice(p.shipmentId)).mode],['CHOSEN','automatic'],tier);}
  assert.equal(state.buys,2,'choosing a rate never buys a label on its own here');
  const audited=Number((await db.query("SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action='Chose a shipping rate'",[ctx.workspaceId])).rows[0].n);
  assert.ok(audited>=4);
  assert.ok((await db.query("SELECT 1 FROM security_event_history WHERE workspace_id=$1 AND action='Approved a shipping rate and its label'",[ctx.workspaceId])).rowCount>=2);
});

test('missing or mismatched facts stop the choice; pause, Ask me first, observe and shadow only suggest or watch',{timeout:300000},async t=>{
  const {f,db,ctx,state,carrier,labels,parcel,routine,choice,needs,day,auto}=await setup(t);
  await f.subscribe('pro');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  // No promised date: nothing is quoted and a person is asked.
  const none=await f.parcel(),quotes=state.quotes;await routine();let run=await choice(none.shipmentId);
  assert.deepEqual([run.status,run.hold],['HELD','promise']);assert.equal(state.quotes,quotes);
  assert.ok((await needs()).some(n=>n.title==='Shipping for order '+none.order.orderNumber+' is waiting'));
  // Nothing arrives in time: held with the fastest option named.
  const tight=await parcel(day(0));await routine();run=await choice(tight.shipmentId);
  assert.equal(run.hold,'late');assert.match(run.reason,/No rate arrives by the promised date.*The fastest/);
  // A PO box never gets a UPS or FedEx rate.
  await db.query("UPDATE customers SET shipping_address='PO Box 12, Albany, NY 12207' WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);
  state.upsCheap=true;const box=await parcel();await routine();run=await choice(box.shipmentId);
  assert.deepEqual([run.carrier,run.service],['usps','Ground Advantage'],'the cheaper UPS rate is not offered for a PO box');state.upsCheap=false;
  await db.query("UPDATE customers SET shipping_address='10 Jobsite Rd, Albany, NY 12207' WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);
  state.bump=0;
  // The owner's per-job setting and the inventory's authority are respected.
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,58,{mode:'ask',revision:0});
  const ask=await parcel();await routine();assert.deepEqual([(await choice(ask.shipmentId)).status,(await choice(ask.shipmentId)).mode],['SUGGESTED','draft']);
  await modes.save(db,ctx,58,{mode:'watch',revision:1});
  const watched=await parcel();await routine();run=await choice(watched.shipmentId);assert.equal(run.mode,'watch');
  await assert.rejects(labels.approve(db,ctx,watched.shipmentId,{runId:run.id}),/changed/);
  assert.equal((await needs()).some(n=>n.sourceId==='label-run:'+run.id),false,'watching asks nobody');
  await modes.save(db,ctx,58,{mode:'inherit',revision:2});
  await auto.pause(db,ctx,{role:'owner'},'Checking postage');
  const paused=await parcel();await routine();assert.equal((await choice(paused.shipmentId)).mode,'draft');
  await auto.resume(db,ctx,{role:'owner'});
  await auto.setMode(db,ctx,{role:'owner'},'OBSERVE');
  const observed=await parcel();await routine();assert.equal((await choice(observed.shipmentId)).mode,'watch');
  await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const shadow=await parcel();await routine();assert.equal((await choice(shadow.shipmentId)).mode,'watch');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  // An expired quote is fetched again at the tap; a dearer answer is shown, not bought.
  await f.subscribe('starter');
  const later=await parcel();await routine();run=await choice(later.shipmentId);
  await db.query("UPDATE shipment_rates SET quoted_at=(now()-interval '31 minutes')::text WHERE shipment_id=$1",[later.shipmentId]);
  state.bump=25;const changed=await labels.approve(db,ctx,later.shipmentId,{runId:run.id},{providerResolver:()=>carrier});
  assert.equal(changed.changed,true);assert.equal(Number(changed.run.amount_minor),175);assert.equal(state.buys,0);
  const again=await labels.approve(db,ctx,later.shipmentId,{runId:changed.run.id},{providerResolver:()=>carrier});assert.equal(again.queued,true);
  // A changed parcel is a new choice; the old one cannot buy.
  const moved=await parcel();await routine();run=await choice(moved.shipmentId);
  await f.shipping.setPackages(db,ctx,moved.shipmentId,[{weightGrams:900,lengthMm:200,widthMm:150,heightMm:100}]);
  await assert.rejects(labels.approve(db,ctx,moved.shipmentId,{runId:run.id}),/changed/);
  const declined=await parcel();await routine();run=await choice(declined.shipmentId);
  await labels.dismiss(db,ctx,declined.shipmentId,{runId:run.id});await routine();assert.equal((await choice(declined.shipmentId)).status,'DECLINED');
  await assert.rejects(labels.configure(db,ctx,{enabled:true}),/plan/);
  assert.equal(await f.balance(),40,'choosing rates never moves stock');
});

test('the review, the worker and the order page show the choice at desktop and phone width',{timeout:300000},async t=>{
  const {f,db,ctx,state,carrier,labels,parcel,choice,day}=await setup(t,10);
  await f.subscribe('growth');
  const p=await parcel();
  const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{shippingProviderResolver:()=>carrier});
  await db.transaction(c=>labels.schedule(c,ctx.workspaceId,'cycle-1'));await db.transaction(c=>labels.schedule(c,ctx.workspaceId,'cycle-1'));
  assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2",[ctx.workspaceId,labels.KIND])).rows[0].n,1);
  assert.equal((await jobs.processOne(db,{[labels.KIND]:handlers[labels.KIND]},{owner:'test-worker'})).status,'COMPLETED');
  const run=await choice(p.shipmentId);assert.deepEqual([run.status,run.mode],['SUGGESTED','draft']);
  for(const tier of ['starter','growth','pro','enterprise']){await f.subscribe(tier);
    const review=await require('../../src/autopilot/job-reviews').run(db,ctx,'timely-shipping-rates',{filter:p.order.orderNumber});
    if(tier==='starter')assert.match(review.rows[0].Suggestion,/usps Ground Advantage at \$1\.50/);
    else{assert.equal(review.rows[0].Service,'usps Ground Advantage');assert.match(review.rows[0].Status,/Suggested · Carrier transit days/);}}
  await f.subscribe('growth');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),shippingOptions:{providerResolver:()=>carrier}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const width of [1280,390]){
    const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+'/settings/shipping');
    assert.match(await page.locator('#handling').innerText(),/Let StockChief choose on its own/);
    await page.goto(origin+'/orders/'+p.order.salesOrderId);
    const block=page.locator('#ship-now [data-agent-rate]');
    assert.match(await block.innerText(),/StockChief suggests USPS Ground Advantage · \$1\.50/);assert.match(await block.innerText(),new RegExp('promised by '+day(7)));
    assert.equal(await page.locator('#ship-now input[name=rateId]:checked').getAttribute('value'),run.rate_id);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll at '+width);
    if(width===390){
      await Promise.all([page.waitForNavigation(),block.getByRole('button',{name:'Buy this label'}).click()]);
      assert.equal((await choice(p.shipmentId)).status,'QUEUED');
      assert.equal((await f.shipping.requireShipment(db,ctx.workspaceId,p.shipmentId)).label_status,'PENDING');
    }
    await page.close();
  }
  assert.equal(state.buys,0,'the carrier is only called by the worker');
});
