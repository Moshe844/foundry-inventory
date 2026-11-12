'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 60 on every plan: once a parcel leaves (a recorded carrier handoff or
// the carrier's first scan of a label bought here), the customer is emailed
// the carrier, tracking number and link through the outbox and a test
// mailbox. Starter taps once per shipment; Growth, Pro and Custom send alone.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:30}),{db,ctx,browser,shipping}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
    credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Dispatch mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'dispatch-mailbox',now(),now())`,
    [connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
  const runtime=require('../../src/operations/postgres-runtime-handlers').create();
  const mail=require('../../src/connections/postgres-outbound-mail'),sent=[];
  const mailbox={send:async({message})=>{sent.push(message);return {externalMessageId:'accept-'+message.id};}};
  const settings=async(mode,status=303,extra={})=>{const page=await browser.get('/fulfilment').expect(200);
    return browser.post('/fulfilment/settings/notices').set('Accept','application/json').type('form').send({_csrf:f.csrf(page.text),shippingNotice:mode,connectorId:connector,...extra}).expect(status);};
  const notice=async id=>(await db.query(`SELECT n.*,e.id effect FROM customer_communications n LEFT JOIN stockchief_runtime.provider_effects e
    ON e.workspace_id=n.workspace_id AND e.kind='mail.outbound.send' AND e.aggregate_id=n.id WHERE n.workspace_id=$1 AND n.shipment_id=$2 ORDER BY e.created_at DESC NULLS LAST,e.id DESC`,[ctx.workspaceId,id])).rows[0];
  const jobsFor=id=>db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='agent.shipment-notice' AND payload->>'shipmentId'=$2",[ctx.workspaceId,id]);
  const run=async id=>{const {rows:[job]}=await jobsFor(id);assert.ok(job,'the parcel leaving queues the tracking email');
    return db.transaction(c=>runtime['agent.shipment-notice']({workspaceId:ctx.workspaceId,payload:job.payload},c));};
  let trackingSeq=0;
  async function physical(prepare){
    const p=await f.parcel();if(prepare)await prepare(p);await shipping.markPacked(db,ctx,p.shipmentId);
    assert.equal((await jobsFor(p.shipmentId)).rowCount,0,'packing alone queues nothing');
    await shipping.handoff(db,ctx,p.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z999AA1012345'+String(6700+(++trackingSeq))});
    const first=await run(p.shipmentId),again=await run(p.shipmentId);
    return {...p,id:p.shipmentId,first,again,note:await notice(p.shipmentId)};
  }
  async function tap(id){
    const note=await notice(id),url='/fulfilment/'+id,review=await browser.get(url).expect(200);
    assert.match(review.text,/id="notice"/);assert.match(review.text,/Send to receiver@example.test/);
    await browser.post(url+'/notice').type('form').send({_csrf:f.csrf(review.text),version:note.updated_at,messageId:note.id,
      subject:note.subject,body:note.body,connectorId:connector,action:'send'}).expect(303);
    const approved=await notice(id);return mail.executeSendEffect(db,ctx.workspaceId,approved.effect,{provider:mailbox});
  }
  const deliver=async id=>mail.executeSendEffect(db,ctx.workspaceId,(await notice(id)).effect,{provider:mailbox});
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n);
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('shipment-notice:'));
  const auto=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
  return {f,db,ctx,connector,runtime,mail,mailbox,sent,settings,notice,jobsFor,run,physical,tap,deliver,audits,needs,auto,modes};
}

test('Starter taps once per shipment; Growth, Pro and Custom send the tracking email alone, once',{timeout:300000},async t=>{
  const {f,db,ctx,sent,settings,physical,tap,deliver,audits,needs,auto}=await setup(t);
  await f.subscribe('starter');
  assert.match((await f.browser.get('/fulfilment').expect(200)).text,/Automatic tracking emails · Growth/);
  await settings('send',402);await settings('prepare');
  const starter=await physical();
  assert.equal(starter.note.status,'PREPARED');assert.equal(starter.note.effect,null);assert.ok(starter.again.replayed,'running again writes nothing new');
  assert.match(starter.note.body,/UPS tracking number 1Z999AA10123456701/);assert.match(starter.note.body,/https:\/\//);
  const waiting=(await needs()).find(n=>n.sourceId==='shipment-notice:'+starter.note.id);
  assert.ok(waiting);assert.equal(waiting.actionLabel,'Send the tracking email');assert.equal(waiting.href,'/fulfilment/'+starter.id+'#notice');
  assert.equal((await tap(starter.id)).message.status,'SENT');assert.equal(sent.length,1);
  assert.equal((await needs()).length,0,'a sent email leaves Needs you');
  assert.equal(await audits('Prepared a tracking email'),1);assert.equal(await audits('Approved a tracking email'),1);

  await f.subscribe('growth');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await settings('send');
  for(const tier of ['growth','pro','enterprise']){
    await f.subscribe(tier);const {id,note}=await physical();
    assert.equal(note.status,'QUEUED',tier);
    assert.equal((await deliver(id)).message.status,'SENT',tier);
    assert.equal((await deliver(id)).replayed,true,'delivering again sends nothing twice');
    assert.equal(sent.at(-1).recipient,'receiver@example.test');assert.match(sent.at(-1).body,/1Z999AA1012345/);
  }
  assert.equal(sent.length,4);assert.equal(await audits('Sent a tracking email on its own'),3);
  // A Starter downgrade after queueing returns the email to a tap.
  await f.subscribe('pro');const pending=await physical();await f.subscribe('starter');
  await assert.rejects(deliver(pending.id),/Approve this tracking email/);
  assert.equal((await db.query('SELECT status FROM customer_communications WHERE id=$1',[pending.note.id])).rows[0].status,'PREPARED');
  await tap(pending.id);assert.equal(sent.length,5);
  const nextStarter=await physical();assert.equal(nextStarter.note.status,'PREPARED');assert.equal(nextStarter.note.effect,null);
  // Turning notices off before delivery stops the queued email at the mailbox.
  await f.subscribe('pro');const revoked=await physical();await settings('off');
  await assert.rejects(deliver(revoked.id),/setting changed/);assert.equal(sent.length,5);
});

test('the carrier scan counts as handoff, and channel orders are left to the channel unless the owner says otherwise',{timeout:300000},async t=>{
  const {f,db,ctx,sent,settings,notice,jobsFor,run,physical,deliver,auto}=await setup(t);
  await f.subscribe('growth');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await settings('send');
  // A label bought here, scanned by the carrier before anyone records the handoff.
  const carrier={quote:async()=>({rates:[{rateId:'g',carrier:'usps',service:'Ground Advantage',amountMinor:300,currency:'USD'}]}),
    buy:async()=>({providerShipmentId:'label-scan',trackingNumber:'9400100000000000000001',trackingUrl:'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000001',
      labelUrl:'https://labels.example.test/scan.pdf',amountMinor:300,currency:'USD',carrier:'usps',service:'Ground Advantage'})};
  const p=await f.parcel();await f.shipping.markPacked(db,ctx,p.shipmentId);
  const rate=(await f.shipping.quote(db,ctx,p.shipmentId,{provider:carrier})).rates[0];
  await f.shipping.buyLabel(db,ctx,p.shipmentId,rate.id,{idempotencyKey:'scan-label'},{provider:carrier});
  assert.equal((await jobsFor(p.shipmentId)).rowCount,0,'a label alone is not a handoff');
  await f.shipping.applyTracking(db,ctx,p.shipmentId,{status:'IN_TRANSIT',externalEventId:'acceptance-scan',detail:'Accepted at USPS origin facility',occurredAt:new Date().toISOString()});
  await run(p.shipmentId);let note=await notice(p.shipmentId);
  assert.equal(note.status,'QUEUED');assert.match(note.body,/9400100000000000000001/);assert.match(note.body,/tools\.usps\.com/);
  await deliver(p.shipmentId);assert.equal(sent.length,1);
  await f.shipping.handoff(db,ctx,p.shipmentId,{handover:'CARRIER'});
  assert.equal((await jobsFor(p.shipmentId)).rowCount,1,'recording the handoff later queues no second email');
  assert.ok((await run(p.shipmentId)).replayed);assert.equal(sent.length,1);

  // An order from a connected store: the store sends its own email.
  const shop=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,created_at,updated_at)
    VALUES($1,$2,$1,'Corner Shop store','shopify','connected',now()::text,now()::text)`,[shop,ctx.workspaceId]);
  const fromShop=p=>db.query(`INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,created_at,updated_at)
    VALUES($1,$2,$3,'sales_order',$4,$5,now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,shop,'shop-'+p.order.salesOrderId,p.order.salesOrderId]);
  const quiet=await physical(fromShop);
  assert.deepEqual(quiet.first,{skipped:'channel',channel:'Corner Shop store'});assert.equal(quiet.note,undefined);
  assert.match((await f.browser.get('/orders/'+quiet.order.salesOrderId).expect(200)).text,/Corner Shop store tells them/);
  const page=await f.browser.get('/fulfilment').expect(200);
  assert.match(page.text,/Orders from Corner Shop store/);assert.match(page.text,/name="channelSender\[/);
  // Only the owner can let StockChief email a channel's customers.
  await assert.rejects(require('../../src/shipping/agent-shipping-notices').saveChannels(db,ctx,{[shop]:'stockchief'},{role:'staff'}),/Only the inventory owner/);
  await settings('send',303,{['channelSender['+shop+']']:'stockchief'});
  const told=await physical(fromShop);assert.equal(told.note.status,'QUEUED');
  await deliver(told.id);assert.equal(sent.length,2);
  // Handing it back to the store before delivery stops a queued email.
  const handedBack=await physical(fromShop);assert.equal(handedBack.note.status,'QUEUED');
  await settings('send',303,{['channelSender['+shop+']']:'channel'});
  await assert.rejects(deliver(handedBack.id),/tells its own customers/);assert.equal(sent.length,2);
  assert.equal(Number((await db.query("SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Changed who tells%'",[ctx.workspaceId])).rows[0].n),2);
});

test('Ask me first, pause, observe and the first 14 days leave the email for a tap; a missing address asks',{timeout:300000},async t=>{
  const {f,db,ctx,connector,sent,settings,notice,physical,tap,needs,auto,modes}=await setup(t);
  await f.subscribe('pro');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await settings('send');
  await modes.save(db,ctx,60,{mode:'ask',revision:0});
  const ask=await physical();assert.equal(ask.note.status,'PREPARED');assert.equal(ask.note.effect,null);
  await tap(ask.id);assert.equal(sent.length,1,'one tap still sends under Ask me first');
  await modes.save(db,ctx,60,{mode:'inherit',revision:1});
  await auto.pause(db,ctx,{role:'owner'},'Checking emails');
  const paused=await physical();assert.equal(paused.note.status,'PREPARED');await auto.resume(db,ctx,{role:'owner'});
  await auto.setMode(db,ctx,{role:'owner'},'OBSERVE');
  const observed=await physical();assert.equal(observed.note.status,'PREPARED');
  const held=await notice(observed.id);
  await assert.rejects(require('../../src/shipping/agent-shipping-notices').edit(db,ctx,observed.id,{messageId:held.id,version:held.updated_at,
    subject:held.subject,body:held.body,connectorId:connector,action:'send'}),/paused or in the initial watch period/);
  await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const shadow=await physical();assert.equal(shadow.note.status,'PREPARED');assert.equal(shadow.note.effect,null);
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  // No email on the order: the email is written but waits for the address.
  const missing=await physical(p=>db.query('UPDATE sales_orders SET contact_email=NULL WHERE id=$1',[p.order.salesOrderId]));
  assert.equal(missing.note.status,'PREPARED');assert.equal(missing.note.recipient,null);
  assert.match((await needs()).find(n=>n.sourceId==='shipment-notice:'+missing.note.id).happened,/no email address/);
  assert.equal(sent.length,1);
});

test('the settings and shipment email read well on a desktop and on a 390 px phone',{timeout:300000},async t=>{
  const {f,db,ctx,settings,physical}=await setup(t);
  await f.subscribe('growth');await settings('prepare');
  const shop=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,created_at,updated_at)
    VALUES($1,$2,$1,'Corner Shop store','shopify','connected',now()::text,now()::text)`,[shop,ctx.workspaceId]);
  const p=await physical();
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const width of [1280,390]){
    const tab=await chrome.newPage({viewport:{width,height:900}});tab.setDefaultTimeout(15000);
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(origin+'/fulfilment');await tab.locator('#customer-notices > summary').click();
    assert.match(await tab.locator('#channel-notices').innerText(),/Orders from Corner Shop store/);
    assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll on settings at '+width);
    await tab.goto(origin+'/fulfilment/'+p.id+'#notice');
    assert.match(await tab.locator('#notice').innerText(),/Send to receiver@example.test/);
    assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll on the shipment at '+width);
    await tab.close();
  }
});
