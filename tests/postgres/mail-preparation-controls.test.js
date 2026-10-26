'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
test('ordinary paid owner controls automatic preparation, edits and sends exactly once, and discards without deleting email or draft history',
  {timeout:180000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:9}),{db,ctx}=f;
  await f.parcel({quantity:2});
  await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source)
    VALUES('mail-control-subscription',$1,'growth','COMP','CUSTOM','ISOLATED_MAIL_ACCEPTANCE')`,[f.owner.accountId]);
  await require('../../src/commercial/feature-benefits').set(db,{capability:'communications.ai_drafts',enabled:true,reason:'Isolated mail acceptance'});
  let modelCalls=0,sends=0;const sent=[];
  const aiProvider={name:'anthropic',model:PRICED_MODEL,complete:async input=>{
    modelCalls++;assert.match(input.prompt,/7 available/);
    return {data:{subject:'Re: Availability question',body:'Current recorded availability is 7 units.'},usage:pricedUsage()};
  }};
  const adapter={metadata:()=>({type:'gmail',name:'Gmail',available:true,category:'email',authMode:'oauth',provides:['business mail']}),
    poll:async()=>({messages:[]}),send:async({message})=>{sends++;sent.push(message);return {externalMessageId:'verified-fixture-send',externalThreadId:'fixture-thread'};}};
  const providers={get:type=>type==='gmail'?adapter:null,catalog:()=>[adapter.metadata()]};
  const at=new Date().toISOString(),connectorId='mail-controls-connector';
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,
    capabilities,credential_ref,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,'mail-controls','Business mailbox','gmail','[]','{}','connected','["mail:read","mail:send"]',$3,1,'CONNECTED',$4,'fixture-mailbox','business@example.test',$5,$5)`,
    [connectorId,ctx.workspaceId,'connection_credentials:'+connectorId,ctx.actorId,at]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connectorId,'provider',{accessToken:'isolated-mail-token'}));
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'isolated-mail-controls',connectionProviders:providers,aiProvider});
  const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
  const browser=await chromium.launch();f.cleanup(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;
  await page.goto(base+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('input[name="password"]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  const mail=require('../../src/connections/postgres-mail'),connections=require('../../src/connections/postgres-service');
  const incoming=id=>connections.get(db,ctx.workspaceId,connectorId).then(c=>mail.capture(db,c,{externalMessageId:id,sender:'receiver@example.test',
    subject:'Availability question',bodyText:'What is the current recorded availability?',receivedAt:at}));
  await incoming('before-opt-in');
  assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='mail.reply-draft'",[ctx.workspaceId])).rows[0].n,0);
  await page.goto(base+'/settings/connections/'+connectorId);
  assert.equal(await page.locator('[data-mail-preparation]').count(),1);
  if(process.env.STOCKCHIEF_CONTROL_ARTIFACT_DIR){const out=path.join(process.env.STOCKCHIEF_CONTROL_ARTIFACT_DIR,'mail-screenshots');fs.mkdirSync(out,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(out,'preparation-off-'+width+'.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);}}
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Let StockChief handle reply preparation',exact:true}).click()]);
  assert.match(await page.locator('[data-mail-preparation]').innerText(),/Automatic preparation is on/);
  const captured=await incoming('after-opt-in');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(providers,{aiProvider}),jobs=require('../../src/operations/postgres-job-queue');
  assert.equal((await jobs.processOne(db,{'mail.reply-draft':handlers['mail.reply-draft']},{owner:'automatic-mail-fixture'})).result.prepared,true);
  await page.reload();assert.match(await page.locator('[data-mail-preparation]').innerText(),/Reply ready/);
  await page.goto(base+'/mail/'+captured.messageId);
  if(process.env.STOCKCHIEF_CONTROL_ARTIFACT_DIR){for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:path.join(process.env.STOCKCHIEF_CONTROL_ARTIFACT_DIR,'mail-screenshots','ready-reply-'+width+'.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);}}
  await page.locator('textarea[name="body"]').fill('Owner-edited reply.');
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save for later',exact:true}).click()]);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send to receiver@example.test',exact:true}).click()]);
  await jobs.processOne(db,{'provider.effect':handlers['provider.effect']},{owner:'verified-mail-fixture'});
  await page.reload();assert.equal(await page.locator('[data-native-reply-status]').count(),0);
  assert.equal(sends,1);assert.equal(sent[0].body,'Owner-edited reply.');
  await assert.rejects(require('../../src/connections/postgres-mail-preparation').discard(db,ctx,captured.messageId),/sent|verified/i);
  const discard=await incoming('discard-this-reply');await jobs.processOne(db,{'mail.reply-draft':handlers['mail.reply-draft']},{owner:'discard-mail-fixture'});
  await page.goto(base+'/mail/'+discard.messageId);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Discard reply',exact:true}).click()]);
  assert.equal(await page.locator('[data-native-reply-status]').count(),0);
  const kept=await mail.get(db,ctx.workspaceId,discard.messageId);
  assert.equal(kept.reply_state,'HANDLED');assert.equal(kept.draft_body,'Current recorded availability is 7 units.');assert(kept.body_text);
  const pending=await incoming('cancel-pending-preparation');
  await page.goto(base+'/settings/connections/'+connectorId);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Stop automatic preparation',exact:true}).click()]);
  const paused=await jobs.processOne(db,{'mail.reply-draft':handlers['mail.reply-draft']},{owner:'disabled-mail-fixture'});
  assert.equal(paused.result.skipped,'automatic_preparation_off');assert.equal(modelCalls,2);assert.equal(sends,1);
  assert.equal((await mail.get(db,ctx.workspaceId,pending.messageId)).draft_body,null);
  assert.equal(await f.balance(),9);
  t.diagnostic(JSON.stringify({actualBrowser:true,actualPostgres:true,providerSimulated:true,paidCalls:0,automaticPreparationOptIn:true,exactSendOnce:true,discardPreservesHistory:true}));
});
