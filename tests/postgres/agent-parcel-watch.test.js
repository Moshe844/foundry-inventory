'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 62 on every plan: shipped parcels are watched through carrier webhooks
// and the polling fallback (a test carrier stands in for the connected
// account), and late, stalled, lost, damaged, returned and held-up parcels are
// flagged once on the order and in Needs you. The owner can have customers
// told about a delay. Starter does not include the watch.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx,browser,shipping}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const time=require('../../src/lib/business-time'),today=await time.today(db,ctx.workspaceId),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
    credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Dispatch mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'dispatch-mailbox',now(),now())`,
    [connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
  // The test carrier answers for each tracking number from this table.
  const scans=new Map(),state={tracks:0,labels:0};
  const carrier={quote:async()=>({rates:[{rateId:'g',carrier:'usps',service:'Ground Advantage',amountMinor:300,currency:'USD'}]}),
    buy:async()=>{state.labels++;return {providerShipmentId:'label-'+state.labels,trackingNumber:'9400LABEL'+state.labels,labelUrl:'https://labels.example.test/'+state.labels+'.pdf',
      amountMinor:300,currency:'USD',carrier:'usps',service:'Ground Advantage'};},
    track:async(_ctx,input)=>{state.tracks++;return scans.get(input.trackingNumber)||null;},readEvent:event=>event};
  const watch=require('../../src/shipping/agent-parcel-watch'),mail=require('../../src/connections/postgres-outbound-mail'),sent=[];
  const mailbox={send:async({message})=>{sent.push(message);return {externalMessageId:'accept-'+message.id};}};
  const routine=()=>watch.run(db,{workspaceId:ctx.workspaceId,id:randomUUID()},{providerResolver:()=>carrier});
  let seq=0;
  const iso=n=>new Date(Date.now()+n*86400000).toISOString();
  async function shipped({promised=day(5),scan,label=false,ago=0}={}){
    const p=await f.parcel(),number=label?null:'1Z999AA1'+String(10000000+(++seq));
    await db.query('UPDATE sales_orders SET needed_by=$2 WHERE id=$1',[p.order.salesOrderId,promised]);
    await shipping.markPacked(db,ctx,p.shipmentId);
    if(label){const rate=(await shipping.quote(db,ctx,p.shipmentId,{provider:carrier})).rates[0];
      await shipping.buyLabel(db,ctx,p.shipmentId,rate.id,{idempotencyKey:'label-'+p.shipmentId},{provider:carrier});
      await shipping.handoff(db,ctx,p.shipmentId,{handover:'CARRIER'});}
    else await shipping.handoff(db,ctx,p.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:number});
    if(ago)await db.query('UPDATE sales_shipments SET shipped_at=$2 WHERE id=$1',[p.shipmentId,iso(-ago)]);
    const s=await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId);
    scans.set(s.tracking_number,scan||{status:'IN_TRANSIT',events:[{externalEventId:'moving-'+s.id,status:'IN_TRANSIT',detail:'Departed facility',location:'Albany, NY',occurredAt:iso(0)}]});
    return {...p,id:p.shipmentId,orderId:p.order.salesOrderId,tracking:s.tracking_number};
  }
  const flags=async id=>(await db.query("SELECT detail FROM sales_order_events WHERE workspace_id=$1 AND event_type='parcel_flagged' AND detail::jsonb->>'shipmentId'=$2",[ctx.workspaceId,id])).rows.map(r=>JSON.parse(r.detail).problem);
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
  const watched=async()=>(await needs()).filter(n=>String(n.sourceId).startsWith('parcel-watch:'));
  const audits=async pattern=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action LIKE $2',[ctx.workspaceId,pattern])).rows[0].n);
  const settings=async(exceptionNotice,status=303)=>{const page=await browser.get('/fulfilment').expect(200);
    return browser.post('/fulfilment/settings/notices').set('Accept','application/json').type('form').send({_csrf:f.csrf(page.text),shippingNotice:'prepare',exceptionNotice,connectorId:connector}).expect(status);};
  const delay=async id=>(await db.query(`SELECT n.*,e.id effect FROM customer_communications n LEFT JOIN stockchief_runtime.provider_effects e
    ON e.workspace_id=n.workspace_id AND e.kind='mail.outbound.send' AND e.aggregate_id=n.id WHERE n.workspace_id=$1 AND n.shipment_id=$2 AND n.message_kind='shipping_delay'
    ORDER BY e.created_at DESC NULLS LAST`,[ctx.workspaceId,id])).rows[0];
  const deliver=async id=>mail.executeSendEffect(db,ctx.workspaceId,(await delay(id)).effect,{provider:mailbox});
  const auto=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
  return {f,db,ctx,day,iso,carrier,scans,state,watch,routine,shipped,flags,needs,watched,audits,settings,delay,deliver,sent,connector,auto,modes,mail,mailbox};
}

test('Growth, Pro and Custom watch alone and flag late, stalled, lost, damaged and returned parcels once; Starter does not include it',{timeout:400000},async t=>{
  const {f,db,ctx,day,iso,carrier,scans,state,watch,routine,shipped,flags,needs,watched,audits,auto}=await setup(t);
  await f.subscribe('starter');
  const starterLate=await shipped({promised:day(-1)});
  assert.deepEqual(await routine(),{skipped:'plan'});assert.equal(state.tracks,0);
  assert.deepEqual(await flags(starterLate.id),[]);assert.equal((await watched()).length,0);
  assert.equal((await db.transaction(c=>watch.schedule(c,ctx.workspaceId,'starter-cycle'))).queued,false);

  await f.subscribe('growth');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const lateSoon=await shipped({promised:day(2),scan:{status:'IN_TRANSIT',estimatedDeliveryDate:day(4),events:[{externalEventId:'est',status:'IN_TRANSIT',detail:'In transit',occurredAt:iso(0)}]}});
  const stalled=await shipped({promised:day(9),ago:6,scan:{status:'IN_TRANSIT',events:[{externalEventId:'old',status:'IN_TRANSIT',detail:'Arrived at facility',location:'Newark, NJ',occurredAt:iso(-5)}]}});
  const lost=await shipped({label:true});
  const damaged=await shipped({scan:{status:'FAILURE',events:[{externalEventId:'dmg',status:'FAILURE',detail:'Package damaged in transit',occurredAt:iso(0)}]}});
  const returned=await shipped({scan:{status:'RETURNED',events:[{externalEventId:'rts',status:'RETURNED',detail:'Returned to sender: refused',occurredAt:iso(0)}]}});
  const fine=await shipped();
  const delivered=await shipped({scan:{status:'DELIVERED',events:[{externalEventId:'del',status:'DELIVERED',detail:'Delivered',occurredAt:iso(0)}]}});
  // The webhook brings the carrier's own "lost" for the label bought here.
  await f.shipping.receiveProviderEvent(db,ctx,'shippo',{externalEventId:'lost-hook',trackingNumber:lost.tracking,status:'FAILURE',detail:'Package lost - cannot be located',occurredAt:iso(0)},{provider:carrier});
  scans.delete(lost.tracking);
  const result=await routine();
  assert.deepEqual(await flags(starterLate.id),['late']);assert.deepEqual(await flags(lateSoon.id),['late']);assert.deepEqual(await flags(stalled.id),['stuck']);
  assert.deepEqual(await flags(lost.id),['lost']);assert.deepEqual(await flags(damaged.id),['damaged']);assert.deepEqual(await flags(returned.id),['returned']);
  assert.deepEqual(await flags(fine.id),[]);assert.deepEqual(await flags(delivered.id),[]);
  assert.equal(result.flagged,6,'the Starter-era late parcel and five new problems');assert.ok(result.polled>=6);
  assert.equal((await f.shipping.requireShipment(db,ctx.workspaceId,delivered.id)).status,'DELIVERED');
  let inbox=await watched();assert.equal(inbox.length,6);
  assert.ok(inbox.some(n=>n.sourceId==='parcel-watch:'+lost.id+':lost'&&/lost the parcel/.test(n.title)&&n.importance==='Urgent'));
  assert.match(inbox.find(n=>n.sourceId==='parcel-watch:'+lateSoon.id+':late').happened,/carrier now expects it/);
  assert.match(inbox.find(n=>n.sourceId==='parcel-watch:'+stalled.id+':stuck').happened,/has not scanned it since/);
  assert.equal((await needs()).filter(n=>/^Carrier exception on/.test(n.title)).length,0,'the base carrier exception is not shown twice');
  assert.equal(await audits('Flagged a %'),6);
  // Running again flags nothing twice and does not ask the carrier again so soon.
  const tracks=state.tracks,again=await routine();assert.equal(again.flagged,0);assert.equal(state.tracks,tracks);assert.equal(await audits('Flagged a %'),6);
  // The order shows it; a person marks it handled and Needs you lets it go.
  const order=await f.browser.get('/orders/'+lost.orderId).expect(200);
  assert.match(order.text,/id="parcel-watch"/);assert.match(order.text,/The carrier lost the parcel/);assert.match(order.text,/cannot be located/);
  await f.browser.post('/orders/'+lost.orderId+'/parcel-watch/handled').type('form').send({_csrf:f.csrf(order.text),shipmentId:lost.id,problem:'lost'}).expect(303);
  assert.equal((await watch.markHandled(db,ctx,lost.orderId,{shipmentId:lost.id,problem:'lost'})).replayed,true);
  inbox=await watched();assert.equal(inbox.length,5);assert.match((await f.browser.get('/orders/'+lost.orderId).expect(200)).text,/Marked handled/);
  // Delivered at last: the late flag clears on its own.
  await f.shipping.applyTracking(db,ctx,lateSoon.id,{status:'DELIVERED',externalEventId:'finally',occurredAt:iso(0)});
  assert.equal((await watched()).length,4);
  // Pro and Custom watch the same way.
  for(const tier of ['pro','enterprise']){
    await f.subscribe(tier);const late=await shipped({promised:day(-2)});
    assert.equal((await routine()).flagged,1,tier);assert.deepEqual(await flags(late.id),['late'],tier);
  }
  // Each business review schedules the watch while parcels are out.
  assert.equal((await db.transaction(c=>watch.schedule(c,ctx.workspaceId,'paid-cycle'))).queued,true);
  // A downgrade to Starter hides the watch.
  await f.subscribe('starter');assert.equal((await watched()).length,0);
  assert.equal(await f.balance(),40-10,'watching moves no stock beyond the ten parcels handed over');
});

test('the customer hears about a delay only if the owner turns it on, within pause, observe, shadow and Ask me first',{timeout:400000},async t=>{
  const {f,db,ctx,day,watch,routine,shipped,flags,watched,audits,settings,delay,deliver,sent,connector,auto,modes}=await setup(t);
  await f.subscribe('growth');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await settings('off');
  const quiet=await shipped({promised:day(-1)});await routine();
  assert.deepEqual(await flags(quiet.id),['late']);assert.equal(await delay(quiet.id),undefined,'off writes no email');
  // Prepare for review: one tap sends it.
  await settings('prepare');
  const drafted=await shipped({promised:day(-1)});await routine();
  let note=await delay(drafted.id);assert.equal(note.status,'PREPARED');assert.match(note.body,/running late/);assert.match(note.body,/1Z999AA1/);
  assert.match((await watched()).find(n=>n.sourceId==='parcel-watch:'+drafted.id+':late').recommendation,/delay email is written/);
  const page=await f.browser.get('/fulfilment/'+drafted.id).expect(200);assert.match(page.text,/id="delay-notice"/);
  await f.browser.post('/fulfilment/'+drafted.id+'/delay-notice').type('form').send({_csrf:f.csrf(page.text),messageId:note.id,version:note.updated_at,
    subject:note.subject,body:note.body,connectorId:connector,action:'send'}).expect(303);
  assert.equal((await deliver(drafted.id)).message.status,'SENT');assert.equal(sent.length,1);
  // Starter cannot have delay emails sent on its own; Growth's owner can.
  await f.subscribe('starter');await settings('send',402);await f.subscribe('growth');
  await settings('send');
  const told=await shipped({promised:day(-1)});await routine();
  note=await delay(told.id);assert.equal(note.status,'QUEUED');assert.equal((await deliver(told.id)).message.status,'SENT');assert.equal(sent.length,2);
  await routine();assert.equal(sent.length,2);assert.equal((await db.query("SELECT count(*)::int n FROM customer_communications WHERE shipment_id=$1 AND message_kind='shipping_delay'",[told.id])).rows[0].n,1,'one delay email per parcel');
  assert.equal(await audits('Told a customer their parcel is late'),1);
  // Delivered before the queued email went out: it is not sent.
  const arrived=await shipped({promised:day(-1)});await routine();assert.equal((await delay(arrived.id)).status,'QUEUED');
  await f.shipping.applyTracking(db,ctx,arrived.id,{status:'DELIVERED',externalEventId:'arrived',occurredAt:new Date().toISOString()});
  await assert.rejects(deliver(arrived.id),/no longer late/);assert.equal(sent.length,2);
  // Lost, damaged and returned parcels are for the owner to explain, never automatic.
  const gone=await shipped({scan:{status:'FAILURE',events:[{externalEventId:'gone',status:'FAILURE',detail:'Package lost',occurredAt:new Date().toISOString()}]}});
  await routine();assert.deepEqual(await flags(gone.id),['lost']);assert.equal(await delay(gone.id),undefined);
  // Ask me first: flagged, and the email waits for a tap.
  await modes.save(db,ctx,62,{mode:'ask',revision:0});
  const ask=await shipped({promised:day(-1)});await routine();
  assert.deepEqual(await flags(ask.id),['late']);assert.equal((await delay(ask.id)).status,'PREPARED');
  await modes.save(db,ctx,62,{mode:'inherit',revision:1});
  // Pause stops the watch; resuming picks the parcel up.
  await auto.pause(db,ctx,{role:'owner'},'Quiet week');
  const paused=await shipped({promised:day(-1)});assert.deepEqual(await routine(),{skipped:'paused'});assert.deepEqual(await flags(paused.id),[]);
  await auto.resume(db,ctx,{role:'owner'});await routine();assert.deepEqual(await flags(paused.id),['late']);
  // Observe and the first 14 days: flagged, nothing written to customers.
  await auto.setMode(db,ctx,{role:'owner'},'OBSERVE');
  const observed=await shipped({promised:day(-1)});await routine();assert.deepEqual(await flags(observed.id),['late']);assert.equal(await delay(observed.id),undefined);
  await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const shadow=await shipped({promised:day(-1)});await routine();assert.deepEqual(await flags(shadow.id),['late']);assert.equal(await delay(shadow.id),undefined);
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  // A downgrade after queueing stops the email at the mailbox.
  const downgraded=await shipped({promised:day(-1)});await routine();assert.equal((await delay(downgraded.id)).status,'QUEUED');
  await f.subscribe('starter');await assert.rejects(deliver(downgraded.id));assert.equal(sent.length,2);
});

test('the parcel problem on the order and the delay email read well on a desktop and on a 390 px phone',{timeout:300000},async t=>{
  const {f,db,ctx,day,routine,shipped,settings,auto}=await setup(t);
  await f.subscribe('growth');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await settings('prepare');
  const late=await shipped({promised:day(-1)});await routine();
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const width of [1280,390]){
    const tab=await chrome.newPage({viewport:{width,height:900}});tab.setDefaultTimeout(15000);
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(origin+'/orders/'+late.orderId);
    assert.match(await tab.locator('#parcel-watch').innerText(),/is late/);
    assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll on the order at '+width);
    await tab.goto(origin+'/fulfilment/'+late.id);
    assert.match(await tab.locator('#delay-notice').innerText(),/running late/);
    assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll on the shipment at '+width);
    await tab.close();
  }
});
