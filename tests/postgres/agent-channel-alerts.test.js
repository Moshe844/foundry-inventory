'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 169 is alone on every plan. The worker's routine check raises an alert
// for each channel that shows more stock than StockChief can sell there (after
// customer orders, protected stock, transfer holds and the channel buffer),
// and for each channel whose sync is paused, needs a new sign-in, failed, went
// quiet or stopped sending orders, and each stock update that failed. Alerts
// clear once fixed, and reach the app, Needs you and email like job 166.
test('channel oversell risk and stopped syncs alert and clear on every plan, and email only when StockChief may act',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-buffer-fixture').fixture(t,'pro'),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId,sku=f.item.skuIds[0];
  const alerts=require('../../src/connections/agent-channel-alerts'),delivery=require('../../src/autopilot/agent-alerts');
  const reviews=require('../../src/autopilot/job-reviews'),needs=require('../../src/projections/postgres-service');
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),mail=require('../../src/connections/postgres-outbound-mail');
  const worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  const check=()=>db.transaction(c=>worker({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  const open=async()=>(await db.query(`SELECT kind FROM stockchief_runtime.agent_operational_notices
    WHERE workspace_id=$1 AND job_id=169 AND NOT resolved ORDER BY kind,reference`,[ws])).rows.map(r=>r.kind);
  const found=async kind=>(await alerts.evaluate(db,ws)).filter(r=>r.kind===kind);
  const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);
  const oversell=alerts.KINDS.oversell;
  await db.query("UPDATE workspace_connectors SET last_synced_at=now()::text,expected_interval_minutes=60 WHERE id=$1",[f.connectorId]);

  // The channel shows the 20 units StockChief can sell: nothing to say.
  assert.deepEqual(await alerts.evaluate(db,ws),[]);
  // Every hold lowers what the channel may show: a customer order, a
  // transfer request, protected stock for a customer, and the channel buffer.
  const sellable=async()=>(await found(oversell))[0]?.sellable;
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:2,unitPriceMinor:1000}]});
  await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  assert.equal(await sellable(),18);
  const annex=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Annex',kind:'warehouse'});
  await require('../../src/transfers/postgres-transfer-service').request(db,ctx,{fromLocationId:f.location.id,toLocationId:annex.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1}]});
  assert.equal(await sellable(),17);
  const protection=randomUUID();
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at)
    VALUES('big-buyer',$1,'Big buyer','big@example.test','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  await db.query(`INSERT INTO stockchief_runtime.agent_stock_protections(id,workspace_id,customer_id,location_id,kind,lines,authorized_by,request_key)
    VALUES($1,$2,'big-buyer',$3,'customer',$4,$5,$1)`,[protection,ws,f.location.id,JSON.stringify([{skuId:sku,quantity:1}]),ctx.actorId]);
  await db.query(`INSERT INTO stockchief_runtime.agent_stock_reservations(id,workspace_id,protection_id,cycle,customer_id,sku_id,location_id,target,held,one_time)
    VALUES($1,$2,$3,'standing','big-buyer',$4,$5,1,1,false)`,[randomUUID(),ws,protection,sku,f.location.id]);
  assert.equal(await sellable(),16);
  await f.configure({bufferUnits:3});
  const [risk]=await found(oversell);
  assert.equal(risk.shows,20);assert.equal(risk.sellable,13);assert.match(risk.detail,/shows 20 but you can sell 13 .*3-unit buffer/);
  const position=await f.service.position(db,ctx,f.positionId);
  assert.equal((await f.sync.local(db,position)).value,13,'The alert uses the figure StockChief publishes.');

  // Alone on every plan: the worker opens the alert, Needs you shows it and the page lists it.
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);await check();
    assert.deepEqual(await open(),[oversell],tier);
    const notice=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-169');
    assert.equal(notice.importance,'Urgent');assert.equal(notice.title,'A sales channel may oversell');assert.equal(notice.href,alerts.path);
    const review=await reviews.run(db,ctx,alerts.key,{scheduled:true});
    assert.equal(review.mode,'alone');assert.deepEqual(review.rows.map(r=>[r.Alert,r.SKU,r['Channel shows'],r['You can sell']]),[[oversell,f.code,20,13]]);
    const page=await browser.get(alerts.path).expect(200);
    assert.match(page.text,/Sales channel problems/);assert.match(page.text,/How you get these alerts/);
  }
  assert.equal(await audits('Alerts updated'),1);
  await check();await check();
  assert.equal(await audits('Alerts updated'),1,'Replays add nothing.');

  // Publishing the buffered quantity fixes it, and the alert clears.
  await subscribe('pro');await f.reconcile();await f.deliver();await f.cache();
  assert.equal(f.remote.value,13);await check();
  assert.deepEqual(await open(),[]);assert.equal(await audits('Alerts updated'),2);

  // A channel figure StockChief never saw is not guessed.
  await db.query(`UPDATE connection_external_records SET provider_data=(provider_data::jsonb||'{"inventoryCounts":[{"externalLocationId":"buffer-room","quantity":"lots"}]}')::text
    WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sku'`,[ws,f.connectorId]);
  await db.query('UPDATE connection_commerce_positions SET baseline_provider=NULL WHERE id=$1',[f.positionId]);
  assert.deepEqual(await found(oversell),[]);
  await f.cache();await db.query("UPDATE connection_commerce_positions SET baseline_provider='13' WHERE id=$1",[f.positionId]);

  // A stopped or failed sync, each in its own words.
  const connector=sql=>db.query('UPDATE workspace_connectors SET '+sql+' WHERE id=$1',[f.connectorId]);
  await connector("paused_at=now()::text");assert.equal((await found('Sync paused')).length,1);await connector('paused_at=NULL');
  await connector("setup_status='REAUTHORIZATION_REQUIRED',status='error'");assert.match((await found('Reconnect needed'))[0].detail,/Reconnect/);
  await connector("setup_status='CONNECTED',status='connected',last_error='The provider asked StockChief to wait. Updates will retry automatically.'");
  assert.match((await found('Sync failed'))[0].detail,/asked StockChief to wait/);await connector('last_error=NULL');
  await connector("last_synced_at=(now()-interval '3 hours')::text,last_activity_at=NULL,created_at=(now()-interval '1 day')::text");assert.equal((await found('No recent sync activity')).length,1);
  await connector('last_synced_at=now()::text');
  await db.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
    VALUES($1,$2,$3,'PUSH_SETUP_FAILED',$4,'Automatic provider events need attention','The store refused the order webhook.','Retry event setup.','OPEN',now()::text,now()::text)`,
  [randomUUID(),ws,f.connectorId,'push-setup:'+f.connectorId]);
  assert.match((await found('Order updates stopped'))[0].detail,/refused the order webhook/);
  // A stock update that changed before delivery fails and leaves the channel behind.
  await f.workflows.confirmSalesOrder(db,ctx,(await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:1000}]})).salesOrderId,{idempotencyKey:randomUUID()});
  await f.reconcile();
  const pending=(await db.query('SELECT pending_effect_id FROM connection_commerce_positions WHERE id=$1',[f.positionId])).rows[0].pending_effect_id;
  await db.query('UPDATE balances SET on_hand=on_hand-1,updated_at=clock_timestamp()::text WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ws,sku,f.location.id]);
  await assert.rejects(f.sync.execute(db,ws,pending,{providers:f.providers}),/changed before delivery/);
  assert.match((await found('Stock update failed'))[0].detail,/changed before delivery/);
  await check();
  assert.deepEqual(new Set(await open()),new Set(['Order updates stopped','Stock update failed',oversell]));
  const stopped=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-169');
  assert.match(stopped.happened,/1 listing shows more stock than you can sell\. 2 channel sync problems\./);

  // Email: held during the first 14 days, then one email for the waiting alerts.
  const mailbox=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[mailbox,ws,'connection_credentials:'+mailbox,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,mailbox,'provider',{accessToken:'test-token'}));
  const settings=await browser.get(alerts.path).expect(200);
  await browser.post('/autopilot/alerts/169').type('form').send({_csrf:f.csrf(settings.text),mailbox,revision:'0'}).expect(303);
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  await check();
  let panel=await delivery.panel(db,ctx,169);
  assert.equal(panel.waiting,3);assert.match(panel.note,/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await check();
  assert.equal((await delivery.panel(db,ctx,169)).waiting,0);
  const communication=async()=>(await db.query('SELECT * FROM customer_communications WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[ws])).rows[0];
  const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
  const delivered=[],provider={send:async({message})=>{delivered.push(message);return {externalMessageId:'accepted-'+message.id};}};
  let email=await communication();
  await mail.executeSendEffect(db,ws,await effect(email.id),{provider});
  assert.equal(delivered[0].recipient,f.email);assert.equal(delivered[0].subject,'3 sales channel problems');
  assert.match(delivered[0].body,new RegExp('- Buffered test channel: '+f.code+' at .* \\(Channel quantity exceeds available stock\\)\\. The channel shows'));
  assert.match(delivered[0].body,/- Buffered test channel \(Order updates stopped\)\. The store refused the order webhook\./);

  // Pause and Ask me first hold the email of a new problem; the owner can send it under Ask me first.
  await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');
  await connector("paused_at=now()::text");await check();
  panel=await delivery.panel(db,ctx,169);assert.equal(panel.waiting,1);assert.match(panel.note,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await modes.save(db,ctx,169,{mode:'ask',revision:0});await check();
  panel=await delivery.panel(db,ctx,169);assert.match(panel.note,/Ask me first/);assert.equal(panel.canSendNow,true);
  const sendPage=await browser.get(alerts.path).expect(200);
  await browser.post('/autopilot/alerts/169/send').type('form').send({_csrf:f.csrf(sendPage.text)}).expect(303);
  email=await communication();assert.match(email.body,/Sync paused/);
  assert.equal(await audits('Alert email queued'),2);
  // Fixed before the mailbox sends it: nothing goes out.
  await modes.save(db,ctx,169,{mode:'watch',revision:1});
  await connector('paused_at=NULL');await check();
  await assert.rejects(mail.executeSendEffect(db,ws,await effect(email.id),{provider}),/cleared before the email was sent|Watch only/);
  assert.equal(delivered.length,1);
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===169).allowed,['inherit','watch','ask','routine']);

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+alerts.path);
    assert(await tab.getByRole('heading',{name:'Sales channel problems',exact:true}).isVisible());
    assert.match(await tab.locator('main').innerText(),/Channel quantity exceeds available stock/);
    assert(await tab.getByRole('heading',{name:'How you get these alerts'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'channel-alerts-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
