'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 172 is excluded on Starter and Growth and alone on Pro and Custom. Once
// the owner chooses how long to wait, an alert (jobs 166 to 171) or an
// approval in the owner's Needs you that nobody answers is passed to the next
// person who can take it (permission and approval limit, least senior first),
// then back to the owner, with Needs you and email. Passing on waits for
// shadow, pause, Watch only and Ask me first, and every step is audited.
test('unanswered alerts and approvals pass to the next person on their own on Pro and Custom',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:3}),{db,ctx,browser,subscribe,location}=f,ws=ctx.workspaceId;
  const escalations=require('../../src/autopilot/escalations'),alerts=require('../../src/autopilot/agent-alerts'),authz=require('../../src/actions/permissions');
  const needs=require('../../src/projections/postgres-service'),inventory=require('../../src/domain/postgres-inventory-engine'),bulk=require('../../src/domain/postgres-catalog-bulk');
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),mail=require('../../src/connections/postgres-outbound-mail');
  const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  // The routine check queues the escalation check; the worker runs it.
  const check=async()=>{await db.transaction(c=>worker({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
    const done=await jobs.processOne(db,{'agent.escalations':handlers['agent.escalations']},{owner:'escalation-test'});return done?.result||done;};
  const run=()=>escalations.run(db,ws);
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].count);
  const audits=action=>count('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);
  const rows=async()=>(await db.query(`SELECT e.id,e.source,e.status,e.step,u.name AS holder FROM stockchief_runtime.agent_escalations e
    LEFT JOIN users u ON u.id=e.holder_user_id WHERE e.workspace_id=$1 ORDER BY e.source,e.id`,[ws])).rows;
  const later=()=>db.query(`UPDATE stockchief_runtime.agent_escalations SET opened_at=opened_at-interval '3 hours',passed_at=passed_at-interval '3 hours' WHERE workspace_id=$1`,[ws]);
  const passed=async actor=>(await needs.needs(db,ws,actor)).filter(n=>String(n.sourceId).startsWith('escalation:'));
  const auth=require('../../src/domain/postgres-auth-service');
  const member=async(name,role,grants=null)=>{const account=await auth.createBusiness(db,{name,businessName:name+' inventory',email:randomUUID()+'@example.test',password:f.password});
    const id='user-'+randomUUID();await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,$4,$5,$6,now()::text)`,
      [id,ws,account.accountId,name,role,grants?authz.encodeGrant(grants):null]);return {workspaceId:ws,actorId:id,email:(await db.query('SELECT email FROM accounts WHERE id=$1',[account.accountId])).rows[0].email};};
  const clerk=await member('Stock clerk','staff');
  const manager=await member('Office manager','staff',[authz.VIEW,authz.OPERATE,authz.VIEW_PURCHASING,authz.ADMIN]);
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));

  // An alert (the product sold out) and an approval (a prepared price change).
  const sku=f.item.skuIds[0];
  await inventory.issue(db,ctx,{skuId:sku,quantity:3,locationId:location.id,reasonCode:'sold',idempotencyKey:randomUUID()});
  const review=await bulk.prepare(db,ctx,{kind:'price',itemIds:[f.item.itemId],currency:'USD',amount:'12.00'});

  // Starter and Growth: excluded, with the plan lock.
  for(const tier of ['starter','growth']){
    await subscribe(tier);
    await check();
    assert.deepEqual(await run(),{skipped:'plan'});
    await browser.get(escalations.path).expect(402);
    await assert.rejects(alerts.configure(db,ctx,172,{escalationHours:'2'}),e=>e.code==='entitlement_required');
  }

  // Pro: off until the owner chooses a window. Only the owner can.
  await subscribe('pro');
  assert.deepEqual(await run(),{skipped:'off'});
  await assert.rejects(alerts.configure(db,manager,172,{escalationHours:'2'}),/Only the owner/);
  await assert.rejects(alerts.configure(db,ctx,172,{escalationHours:'0'}),e=>e.code==='validation_error');
  let page=await browser.get(escalations.path).expect(200);
  assert.match(page.text,/Choose how many hours to wait/);
  await browser.post('/autopilot/alerts/172').type('form').send({_csrf:f.csrf(page.text),revision:0,escalationHours:'2',mailbox:connector}).expect(303);
  assert.equal(await audits('Alert settings saved'),1);

  // The worker follows the open alert and approval. Nothing is due yet.
  await check();
  assert.deepEqual((await rows()).map(r=>[r.source,r.status,r.step,r.holder]),[['ALERT','WAITING',0,null],['APPROVAL','WAITING',0,null]]);
  await check();assert.equal((await rows()).length,2,'Replays add nothing.');

  // In the first 14 days StockChief only shows who would get them.
  await later();
  let result=await run();
  assert.equal(result.passed,0);assert.equal(result.held,2);
  assert.ok((await rows()).every(r=>r.step===0));
  page=await browser.get(escalations.path).expect(200);
  assert.match(page.text,/Stock clerk/);assert.match(page.text,/Office manager/);assert.match(page.text,/first 14 days/);

  // After shadow mode the alert goes to the stock clerk (purchasing, not a
  // settings manager) and the approval, which needs settings, to the manager.
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  result=await check();
  assert.equal(result.passed,2,JSON.stringify({result,items:await rows()}));
  assert.deepEqual((await rows()).map(r=>[r.source,r.step,r.holder]),[['ALERT',1,'Stock clerk'],['APPROVAL',1,'Office manager']]);
  assert.equal(await audits('Unanswered alert passed on'),1);assert.equal(await audits('Unanswered approval passed on'),1);
  const clerkView=await passed(clerk.actorId);
  assert.equal(clerkView.length,1);assert.match(clerkView[0].title,/^Passed to you: Out of stock: /);
  assert.equal(clerkView[0].dismiss.label,'I\'m on it');assert.match(clerkView[0].happened,/Nobody answered it within 2 hours/);
  assert.match((await passed(manager.actorId))[0].title,/^Passed to you: Review selected selling prices/);
  assert.equal((await passed(ctx.actorId)).length,0);
  // Each person gets one email from the owner's mailbox.
  const emails=async()=>(await db.query(`SELECT id,recipient AS recipient_email,subject FROM customer_communications WHERE workspace_id=$1 ORDER BY created_at,id`,[ws])).rows;
  let sentMail=await emails();
  assert.deepEqual(sentMail.map(m=>m.recipient_email).sort(),[clerk.email,manager.email].sort());
  const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  const toClerk=sentMail.find(m=>m.recipient_email===clerk.email);
  await mail.executeSendEffect(db,ws,await effect(toClerk.id),{provider});
  assert.match(sent[0].subject,/^Passed to you: Out of stock: /);assert.match(sent[0].body,/I'm on it/);
  await check();await run();
  assert.equal((await emails()).length,2,'Replays never pass or email again.');
  assert.equal(await audits('Unanswered alert passed on'),1);

  // Answers: only someone it was passed to, or the owner. The manager takes
  // the approval.
  const ids=Object.fromEntries((await rows()).map(r=>[r.source,r.id]));
  await assert.rejects(escalations.answer(db,clerk,ids.APPROVAL),/Only the person it was passed to/);
  await escalations.answer(db,manager,ids.APPROVAL);
  assert.equal(await audits('Answered an approval'),1);
  assert.equal((await escalations.answer(db,manager,ids.APPROVAL)).replayed,true);
  assert.equal((await passed(manager.actorId)).length,0);

  // The clerk does not answer: the alert goes to the manager, then back to
  // the owner, and stops there.
  await later();await run();
  assert.deepEqual((await rows()).map(r=>[r.source,r.step,r.holder]),[['ALERT',2,'Office manager'],['APPROVAL',1,'Office manager']]);
  assert.equal((await passed(clerk.actorId)).length,0);
  await later();await run();
  const ownerView=await passed(ctx.actorId);
  assert.equal(ownerView.length,1);assert.match(ownerView[0].title,/^Nobody answered: Out of stock/);assert.equal(ownerView[0].importance,'Urgent');
  await later();assert.equal((await run()).passed,0,'Everyone who can take it has had it.');
  const toManager=(await emails()).filter(m=>m.recipient_email===manager.email);
  assert.equal(toManager.length,2);
  // An email whose item was answered or moved on before sending is not sent.
  await assert.rejects(mail.executeSendEffect(db,ws,await effect(toManager[0].id),{provider}),/answered or moved on/);
  await assert.rejects(mail.executeSendEffect(db,ws,await effect(toManager[1].id),{provider}),/answered or moved on/);

  // The owner answers the alert from Needs you.
  const ownerPage=await browser.get('/needs-you').expect(200);
  await browser.post('/autopilot/escalations/'+ids.ALERT+'/answer').type('form').send({_csrf:f.csrf(ownerPage.text),returnTo:'/needs-you'}).expect(303);
  assert.deepEqual((await rows()).map(r=>r.status),['ANSWERED','ANSWERED']);
  await later();assert.equal((await run()).passed,0);

  // Deciding the approval and restocking close them.
  await bulk.cancel(db,ctx,review.id);
  await inventory.receive(db,ctx,{skuId:sku,quantity:5,locationId:location.id,idempotencyKey:randomUUID()});
  await check();
  assert.deepEqual((await rows()).map(r=>r.status),['CLOSED','CLOSED']);

  // A new alert the owner answers in Needs you is never passed on.
  await inventory.issue(db,ctx,{skuId:sku,quantity:5,locationId:location.id,reasonCode:'sold',idempotencyKey:randomUUID()});
  await check();
  const grouped=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-166');
  assert.equal(grouped.dismiss.label,'I\'m on it');
  const home=await browser.get('/needs-you').expect(200);
  await browser.post(grouped.dismiss.action).type('form').send({_csrf:f.csrf(home.text),entryId:grouped.dismiss.entryId,returnTo:'/needs-you'}).expect(303);
  assert.deepEqual((await rows()).map(r=>[r.source,r.status]),[['ALERT','ANSWERED'],['APPROVAL','CLOSED']]);
  await later();assert.equal((await run()).passed,0);

  // Pause, Watch only and Ask me first hold passing on. Under pause or Ask me
  // first the owner can pass a due item on; Watch only cannot.
  await inventory.receive(db,ctx,{skuId:sku,quantity:2,locationId:location.id,idempotencyKey:randomUUID()});await check();
  await inventory.issue(db,ctx,{skuId:sku,quantity:2,locationId:location.id,reasonCode:'sold',idempotencyKey:randomUUID()});await check();
  assert.equal((await rows()).find(r=>r.source==='ALERT').status,'WAITING','The alert came back, so it is followed again.');
  await autopilot.pause(db,ctx,{role:'owner'},'Stock count');
  await later();result=await run();assert.equal(result.passed,0);assert.equal(result.held,1);
  let held=await escalations.actions(db,ctx);
  assert.match(held.stop,/paused/);assert.equal(held.items[0].canPass,true);
  page=await browser.get(escalations.path).expect(200);
  assert.match(page.text,/Pass it on now/);
  await browser.post('/autopilot/escalations/'+held.items[0].id+'/pass').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
  assert.equal((await rows()).find(r=>r.source==='ALERT').holder,'Stock clerk');
  const byOwner=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Unanswered alert passed on' ORDER BY created_at DESC LIMIT 1",[ws])).rows[0].after_state;
  assert.equal(byOwner.passedByOwner,true);
  await autopilot.resume(db,ctx,{role:'owner'});
  await modes.save(db,ctx,172,{mode:'watch',revision:0});
  await later();result=await run();assert.equal(result.held,1);
  held=await escalations.actions(db,ctx);assert.match(held.stop,/Watch only/);assert.equal(held.items[0].canPass,false);
  await assert.rejects(escalations.passNow(db,ctx,held.items[0].id),/Watch only/);
  await modes.save(db,ctx,172,{mode:'ask',revision:1});
  result=await run();assert.equal(result.held,1);
  await escalations.passNow(db,ctx,(await escalations.actions(db,ctx)).items[0].id);
  assert.equal((await rows()).find(r=>r.source==='ALERT').holder,'Office manager');
  await modes.save(db,ctx,172,{mode:'inherit',revision:2});
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===172).allowed,['inherit','watch','ask','routine']);

  // Custom runs it too; a downgrade hides what was passed on.
  await subscribe('enterprise');
  await later();assert.equal((await run()).passed,1);
  assert.equal((await rows()).find(r=>r.source==='ALERT').holder,'Owner');
  await subscribe('growth');
  assert.equal((await passed(ctx.actorId)).length,0);
  assert.deepEqual(await run(),{skipped:'plan'});
  await subscribe('pro');

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+escalations.path);
    assert(await tab.getByRole('heading',{name:escalations.label,exact:true}).isVisible());
    assert(await tab.getByLabel('Hours to wait for an answer').isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'escalations-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});

// Code on the routine check and Needs you runs on databases migrated only part of the way.
test('the routine check, Needs you and the page keep working before migration 474',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:1,through:'473-agent-cost-and-activity-alerts.sql'}),{db,ctx,subscribe}=f;
  await subscribe('pro');
  await require('../../src/domain/postgres-inventory-engine').issue(db,ctx,{skuId:f.item.skuIds[0],quantity:1,locationId:f.location.id,reasonCode:'sold',idempotencyKey:randomUUID()});
  await db.transaction(c=>require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate({id:randomUUID(),workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  assert.ok((await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).some(n=>n.sourceId==='agent-notice-166'));
  assert.deepEqual(await require('../../src/autopilot/escalations').run(db,ctx.workspaceId),{skipped:'upgrade'});
  assert.match((await require('../../src/autopilot/job-reviews').run(db,ctx,'unanswered',{})).summary,/being upgraded/);
  assert.match((await f.browser.get('/autopilot/reviews/unanswered').expect(200)).text,/being upgraded/);
});
