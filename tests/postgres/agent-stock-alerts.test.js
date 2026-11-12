'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 166 is alone on every plan. The worker's routine check raises one alert
// per stocking position at or below its reorder point (or the owner's own
// alert level when there is none) and one when it runs out, turns low stock
// into a stock-out, and clears the alert when stock recovers. Alerts appear in
// the app and in Needs you in every mode. Emailing them from the mailbox the
// owner chose waits for shadow, pause, Watch only and Ask me first.
test('stock alerts open, change and clear through the worker on every plan and email only when StockChief may act',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx,browser,subscribe,location}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),inventory=require('../../src/domain/postgres-inventory-engine');
  const alerts=require('../../src/autopilot/agent-alerts'),stock=require('../../src/autopilot/stock-alerts');
  const reviews=require('../../src/autopilot/job-reviews'),needs=require('../../src/projections/postgres-service');
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),mail=require('../../src/connections/postgres-outbound-mail');
  const worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  const check=()=>db.transaction(c=>worker({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  const shop=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shop',kind:'warehouse'});
  const product=async code=>(await catalog.createItem(db,ctx,{name:'Stock '+code,baseCode:code,trackingMode:'quantity'})).skuIds[0];
  const receive=(skuId,quantity,at=location.id)=>inventory.receive(db,ctx,{skuId,quantity,locationId:at,idempotencyKey:randomUUID()});
  const issue=(skuId,quantity,at=location.id)=>inventory.issue(db,ctx,{skuId,quantity,locationId:at,reasonCode:'sold',idempotencyKey:randomUUID()});
  const point=(skuId,locationId,reorder)=>db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,0,'manual',now()::text,now()::text)`,[randomUUID(),ws,skuId,locationId,reorder,reorder*2]);
  const open=async()=>(await db.query(`SELECT kind,reference FROM stockchief_runtime.agent_operational_notices
    WHERE workspace_id=$1 AND job_id=166 AND NOT resolved ORDER BY reference,kind`,[ws])).rows.map(r=>r.kind+': '+r.reference);
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].count);
  const audits=action=>count('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);
  const notice=async()=>(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-166');

  const A=await product('ALERT-A'),B=await product('ALERT-B'),C=await product('ALERT-C');
  await product('ALERT-NEVER');
  await receive(A,6);await point(A,null,5);
  await receive(B,3,shop.id);await point(B,shop.id,4);
  await receive(C,2);await issue(C,2);

  // No plan: the check raises nothing.
  await check();
  assert.deepEqual(await open(),[]);

  // Every plan alerts on its own, in shadow mode too: an alert changes nothing.
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    await check();
    assert.deepEqual(await open(),['Low stock: ALERT-B at Shop','Out of stock: ALERT-C'],tier);
    const shown=await notice();
    assert.equal(shown.title,'Items are out of stock');assert.equal(shown.importance,'Urgent');
    assert.equal(shown.happened,'1 item is out of stock. 1 item is at or below the level you reorder at.');
    const review=await reviews.run(db,ctx,stock.key,{scheduled:true});
    assert.deepEqual(review.rows.map(r=>[r.Alert,r.SKU,r.Location,r['On hand'],r['Alert level'],r['Level from']]),
      [['Out of stock','ALERT-C','All locations','0 units','Out of stock only','No reorder point'],['Low stock','ALERT-B','Shop','3 units','4 units','Reorder point']]);
    const page=await browser.get(stock.path).expect(200);
    assert.match(page.text,/ALERT-B/);assert.match(page.text,/How you get these alerts/);assert.match(page.text,/Connect a mailbox/);
    assert.match((await browser.get('/needs-you').expect(200)).text,/Items are out of stock/);
  }
  assert.equal(await audits('Alerts updated'),1,'The first check raised both alerts once, whatever the plan.');

  // Replaying the check changes nothing.
  await check();await check();
  assert.equal(await audits('Alerts updated'),1);
  assert.equal(await count('SELECT count(*) FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1'),2);

  // Stock changes update the alerts: low, then out, then recovered.
  await issue(A,1);await check();
  assert.deepEqual(await open(),['Low stock: ALERT-A','Low stock: ALERT-B at Shop','Out of stock: ALERT-C']);
  await issue(A,5);await check();
  assert.deepEqual(await open(),['Out of stock: ALERT-A','Low stock: ALERT-B at Shop','Out of stock: ALERT-C']);
  await receive(A,9);await receive(C,1);await check();
  assert.deepEqual(await open(),['Low stock: ALERT-B at Shop']);
  assert.equal((await notice()).title,'Items are running low');assert.equal((await notice()).importance,'Important');
  assert.equal(await audits('Alerts updated'),4);

  // A product the owner covered with their own stock rule is left to that rule.
  await db.query(`INSERT INTO stockchief_runtime.stock_threshold_rules(id,workspace_id,sku_id,location_id,threshold,comparator,metric,stated_as,approved_by_user_id)
    VALUES('own-rule',$1,$2,$3,2,'at_or_below','on_hand','At or below 2',$4)`,[ws,B,shop.id,ctx.actorId]);
  await check();
  assert.deepEqual(await open(),[]);
  assert.equal(await notice(),undefined);
  await db.query("UPDATE stockchief_runtime.stock_threshold_rules SET is_active=false WHERE id='own-rule'");

  // The owner's own alert level covers stocked products with no reorder point.
  await assert.rejects(alerts.configure(db,{...ctx,actorId:'someone-else'},166,{lowStockUnits:'3'}),/Only the owner/);
  await assert.rejects(alerts.configure(db,ctx,166,{lowStockUnits:'-1'}),e=>e.code==='validation_error');
  const D=await product('ALERT-D');await receive(D,2);
  await alerts.configure(db,ctx,166,{lowStockUnits:'2.5',revision:'0'});
  assert.deepEqual(await open(),['Low stock: ALERT-B at Shop','Low stock: ALERT-C','Low stock: ALERT-D'],'Saving the level checks again at once.');
  assert.equal((await reviews.run(db,ctx,stock.key,{filter:'ALERT-D'})).rows[0]['Level from'],'Your alert level');
  await assert.rejects(alerts.configure(db,ctx,166,{lowStockUnits:'',revision:'0'}),/changed/);
  await alerts.configure(db,ctx,166,{lowStockUnits:'',revision:'1'});
  assert.deepEqual(await open(),['Low stock: ALERT-B at Shop']);
  assert.equal(await audits('Alert settings saved'),2);

  // Email: Starter in its first 14 days keeps the email, never the alert.
  await subscribe('starter');
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  await assert.rejects(alerts.configure(db,ctx,166,{mailbox:'not-a-mailbox'}),/connected mailbox/);
  await alerts.configure(db,ctx,166,{mailbox:connector});
  await issue(A,9);await check();
  let panel=await alerts.panel(db,ctx,166);
  assert.equal(panel.waiting,2);assert.match(panel.stop,/first 14 days/);assert.equal(panel.canSendNow,false);
  assert.match((await db.query('SELECT email_note FROM stockchief_runtime.agent_alert_channels WHERE workspace_id=$1 AND job_id=166',[ws])).rows[0].email_note,/first 14 days/);
  assert.equal(await count('SELECT count(*) FROM customer_communications WHERE workspace_id=$1'),0);
  assert.match((await browser.get(stock.path).expect(200)).text,/Emails wait: StockChief is watching during the first 14 days/);

  // After shadow mode one email covers both waiting alerts, to the owner.
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await check();
  const batches=async()=>(await db.query(`SELECT DISTINCT email_communication_id AS id FROM stockchief_runtime.agent_alert_deliveries
    WHERE workspace_id=$1 AND email_communication_id IS NOT NULL ORDER BY 1`,[ws])).rows.map(r=>r.id);
  let emails=await batches();
  assert.equal(emails.length,1);assert.equal(await audits('Alert email queued'),1);
  const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  await mail.executeSendEffect(db,ws,await effect(emails[0]),{provider});
  assert.equal(sent.length,1);assert.equal(sent[0].recipient,f.email);
  assert.equal(sent[0].subject,'2 stock alerts');
  assert.match(sent[0].body,/- Low stock: ALERT-B at Shop \(Stock ALERT-B\)\. 3 units on hand; alert level 4 units \(reorder point\)\./);
  assert.match(sent[0].body,/- Out of stock: ALERT-A \(Stock ALERT-A\)\. 0 units on hand; alert level 5 units \(reorder point\)\./);
  await check();await check();
  assert.equal(await audits('Alert email queued'),1,'Replays never email again.');
  assert.match((await browser.get(stock.path).expect(200)).text,/Last email sent/);

  // A new alert is emailed on its own.
  await issue(D,2);await check();
  emails=await batches();assert.equal(emails.length,2);
  const second=(await db.query('SELECT subject,body FROM customer_communications WHERE workspace_id=$1 AND id=ANY($2::text[]) AND body LIKE $3',[ws,emails,'%ALERT-D%'])).rows[0];
  assert.equal(second.subject,'Out of stock: ALERT-D');assert.doesNotMatch(second.body,/ALERT-B/);

  // Pause, Watch only and the job's own modes hold the email, never the alert.
  const fresh=async code=>{const sku=await product(code);await receive(sku,1);await issue(sku,1);await check();return alerts.panel(db,ctx,166);};
  await autopilot.pause(db,ctx,{role:'owner'},'Stock count');
  panel=await fresh('ALERT-P');assert.equal(panel.waiting,1);assert.match(panel.note,/paused/);assert.equal(panel.canSendNow,true,'A paused owner may still send it.');
  assert.ok((await open()).includes('Out of stock: ALERT-P'));
  await autopilot.resume(db,ctx,{role:'owner'});
  await check();
  assert.equal((await alerts.panel(db,ctx,166)).waiting,0,'The waiting alert is emailed once StockChief may act again.');
  await modes.save(db,ctx,166,{mode:'watch',revision:0});
  panel=await fresh('ALERT-W');assert.match(panel.note,/Watch only/);assert.equal(panel.canSendNow,false);
  await assert.rejects(alerts.sendNow(db,ctx,166),/Watch only/);
  await modes.save(db,ctx,166,{mode:'ask',revision:1});
  panel=await fresh('ALERT-Q');assert.equal(panel.waiting,2);assert.match(panel.note,/Ask me first/);assert.equal(panel.canSendNow,true);
  const page=await browser.get(stock.path).expect(200);
  assert.match(page.text,/Email the waiting alerts now/);
  await browser.post('/autopilot/alerts/166/send').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
  assert.equal((await alerts.panel(db,ctx,166)).waiting,0);
  assert.equal(await audits('Alert email queued'),4);
  const owned=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Alert email queued' ORDER BY created_at DESC LIMIT 1",[ws])).rows[0].after_state;
  assert.equal(owned.sentByOwner,true);assert.equal(owned.alerts,2);
  await modes.save(db,ctx,166,{mode:'inherit',revision:2});
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  panel=await fresh('ALERT-O');assert.match(panel.note,/watch-only/);
  await autopilot.setMode(db,ctx,{role:'owner'},'SUPERVISED');

  // An alert that clears before the mailbox sends is not sent, nor after the
  // owner turns email off.
  await check();
  const pending=(await db.query(`SELECT email_communication_id AS id FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND reference='ALERT-O'`,[ws])).rows[0].id;
  const product0=(await db.query("SELECT id FROM skus WHERE workspace_id=$1 AND code='ALERT-O'",[ws])).rows[0].id;
  await receive(product0,5);await check();
  await assert.rejects(mail.executeSendEffect(db,ws,await effect(pending),{provider}),/cleared before the email was sent/);
  const later=await fresh('ALERT-L');assert.equal(later.waiting,0);
  const laterEmail=(await db.query(`SELECT email_communication_id AS id FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND reference='ALERT-L'`,[ws])).rows[0].id;
  await alerts.configure(db,ctx,166,{mailbox:''});
  await assert.rejects(mail.executeSendEffect(db,ws,await effect(laterEmail),{provider}),/settings changed/);
  assert.equal(sent.length,1);

  // Every paid plan sends on its own after shadow mode.
  await alerts.configure(db,ctx,166,{mailbox:connector});
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    assert.equal((await fresh('ALERT-'+tier)).waiting,0,tier);
  }
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===166).allowed,['inherit','watch','ask','routine']);
  await subscribe('starter');
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===166).allowed,['inherit','watch','ask']);
  await assert.rejects(alerts.configure(db,ctx,999,{}),e=>e.code==='not_found');

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+stock.path);
    assert(await tab.getByRole('heading',{name:'Low stock and stock-out alerts',exact:true}).isVisible());
    assert(await tab.getByRole('heading',{name:'How you get these alerts'}).isVisible());
    assert(await tab.getByRole('button',{name:'Save alert settings'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'stock-alerts-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
