'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 182: Starter suggests; Growth, Pro and Custom fix the common channel
// sync errors on their own: a sign-in that runs out, a stock update that ran
// out of tries while the channel asked to wait, a channel product with no match
// (exact SKU code or barcode), a stock update that failed, and a lost order
// webhook. Anything else, or facts that do not match, wait for a person. The
// channel is a test adapter for the connected Shopify, WooCommerce,
// BigCommerce, Square and Clover connections; there is no Amazon or eBay one.
test('channel sync errors are suggested on Starter and fixed alone on Growth, Pro and Custom, within pause, shadow and job modes',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-buffer-fixture').fixture(t,'growth'),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
  const fixes=require('../../src/connections/agent-channel-sync-fixes'),reviews=require('../../src/autopilot/job-reviews');
  const needs=require('../../src/projections/postgres-service'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const catalog=require('../../src/domain/postgres-catalog-service'),cache=require('../../src/connections/postgres-provider-sync').cacheRecord;
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'connected_operations',1000,'Synthetic provider operations')`,[randomUUID(),f.owner.accountId]);
  // The test channel can renew its sign-in and register its order webhook too.
  // A sign-in that has no end date, or ends more than an hour away, is not renewed.
  const hooks=[],renewals=[];let hookError=null;
  const adapter={...f.provider,metadata:()=>({available:true}),
    refreshCredentials:async credentials=>{
      if(!credentials.expiresAt||Date.parse(credentials.expiresAt)>Date.now()+3600000)return {credentials,refreshed:false};
      renewals.push(credentials.accessToken);const expiresAt=new Date(Date.now()+86400000).toISOString();
      return {credentials:{...credentials,accessToken:'renewed-'+renewals.length,expiresAt},refreshed:true,expiresAt};},
    registerWebhooks:async({webhookUrl})=>{if(hookError)throw hookError;hooks.push(webhookUrl);return {};}};
  const registry=require('../../src/connections/providers/registry'),original=registry.get;
  t.mock.method(registry,'get',type=>type==='shopify'?adapter:original(type));
  const origin=process.env.FOUNDRY_PUBLIC_URL;process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example';
  t.after(()=>{if(origin===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=origin;});
  const providers={get:()=>adapter},options={providers};
  const run=()=>fixes.run(db,ws,options);
  const list=async()=>(await fixes.problems(db,ws,options)).map(p=>p.kind+(p.fixable?'':' (needs a person)'));
  const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);
  const position=async()=>(await db.query('SELECT * FROM connection_commerce_positions WHERE id=$1',[f.positionId])).rows[0];
  const effect=async id=>(await db.query('SELECT * FROM stockchief_runtime.provider_effects WHERE id=$1',[id])).rows[0];
  const deliver=async()=>{const h=handlers.create(providers);for(let i=0;i<10;i++){const r=await queue.processOne(db,{'provider.effect':h['provider.effect']},{owner:'sync-fix-worker'});if(!r)break;}await f.cache();};
  const order=async quantity=>{const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity,unitPriceMinor:1000}]});await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});};
  // A stock update that fails for certain: StockChief's stock changes between queuing and sending it.
  const failPush=async()=>{
    await order(1);await f.reconcile();const p=await position();
    await db.query('UPDATE balances SET updated_at=clock_timestamp()::text WHERE workspace_id=$1 AND sku_id=$2',[ws,f.item.skuIds[0]]);
    await assert.rejects(f.sync.execute(db,ws,p.pending_effect_id,{providers}),/changed before delivery/);
    assert.equal((await effect(p.pending_effect_id)).status,'FAILED');return p.pending_effect_id;
  };

  // A channel product StockChief could not match when it was found, and one held in a channel order.
  const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[f.connectorId])).rows[0];
  await db.transaction(c=>cache(c,connection,{entityType:'sku',externalId:'late-variant',code:'LATE-1',displayName:'Late product',providerData:{itemName:'Late product'}}));
  await db.query(`INSERT INTO connector_feed_events(id,workspace_id,connector_id,external_event_id,event_type,status,normalized_payload,received_at,processed_at)
    VALUES($1,$2,$3,'order-held','sales_order.created','NEEDS_MAPPING',$4,now()::text,now()::text)`,[randomUUID(),ws,f.connectorId,
    JSON.stringify({type:'sales_order.created',data:{externalOrderId:'held-1',lines:[{externalSku:'held-variant',barcode:'0123456789012',quantity:1}]}})]);
  await db.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,external_event_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
    VALUES($1,$2,$3,'order-held','UNKNOWN_SKU',$4,'Unknown sku','Held','Choose','OPEN',now()::text,now()::text)`,[randomUUID(),ws,f.connectorId,'UNKNOWN_SKU:'+f.connectorId+':held-variant']);
  assert.deepEqual(await list(),[],'No StockChief product has that code or barcode yet: the connection page already asks a person.');
  const late=await catalog.createItem(db,ctx,{name:'Late product',baseCode:'LATE-1',trackingMode:'quantity'});
  const barcoded=await catalog.createItem(db,ctx,{name:'Barcoded product',baseCode:'BAR-'+randomUUID().slice(0,6),trackingMode:'quantity'});
  await db.query("UPDATE skus SET barcode='0123456789012' WHERE id=$1",[barcoded.skuIds[0]]);
  await db.query("UPDATE skus SET code='LATE-1' WHERE id=$1",[late.skuIds[0]]);

  // The other common errors: a failed stock update and a lost order webhook.
  const failed=await failPush();
  await db.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
    VALUES($1,$2,$3,'PUSH_SETUP_FAILED',$4,'Automatic provider events need attention','The store did not accept the order webhook.','Retry event setup.','OPEN',now()::text,now()::text)`,
  [randomUUID(),ws,f.connectorId,'push-setup:'+f.connectorId]);
  const expected=['match','match','resend','webhook'];
  assert.deepEqual((await list()).sort(),expected);

  // An account still on its older terms sees the plan card on both channel pages.
  await db.query('DELETE FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId]);
  for(const key of [fixes.key,'channel-alerts']){const card=await browser.get('/autopilot/reviews/'+key).expect(200);assert.match(card.text,/data-agent-plan-locked/);}
  assert.deepEqual(await run(),{skipped:'plan'});
  // Starter only suggests: nothing changes and the owner cannot apply a fix through StockChief.
  await subscribe('starter');
  assert.deepEqual(await run(),{skipped:'plan'});
  const starter=await reviews.run(db,ctx,fixes.key,{});
  assert.equal(starter.mode,'suggest');
  assert.ok(starter.rows.some(r=>/Match it to LATE-1 \(same SKU code\) on the connection page/.test(r.Suggestion)));
  assert.equal(starter.rows.length,4);
  await assert.rejects(fixes.fixNow(db,ctx,'webhook:'+f.connectorId,options),/Growth/);
  assert.equal(hooks.length,0);assert.equal(await audits(fixes.ACTIONS.fixed),0);

  // Growth fixes on its own, unless the first 14 days, pause, Watch only or Ask me first hold it.
  await subscribe('growth');
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  assert.match((await run()).held,/first 14 days/);
  assert.ok((await fixes.readPage(db,ctx)).rows.filter(r=>r.Channel).some(r=>r.Status==='Watching only'));
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await modes.save(db,ctx,182,{mode:'ask',revision:0});
  assert.match((await run()).held,/Ask me first/);
  const waiting=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='channel-sync-fixes');
  assert.equal(waiting.title,'4 channel sync fixes wait for your approval');assert.equal(waiting.href,fixes.path);
  // With Ask me first the owner approves one fix on the page.
  let page=await browser.get(fixes.path).expect(200);
  assert.match(page.text,/Approve a fix/);
  await browser.post(fixes.path+'/fix').type('form').send({_csrf:f.csrf(page.text),problem:'webhook:'+f.connectorId}).expect(303);
  assert.deepEqual(hooks,['https://stockchief.example/api/v1/connections/shopify/webhooks/'+encodeURIComponent(f.connectorId)]);
  assert.equal(await audits(fixes.ACTIONS.approved),1);
  await modes.save(db,ctx,182,{mode:'watch',revision:1});
  await assert.rejects(fixes.fixNow(db,ctx,'resend:'+failed,options),/Watch only/);
  await modes.save(db,ctx,182,{mode:'inherit',revision:2});
  // A sign-in about to run out.
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,f.connectorId,'provider',
    {accessToken:'synthetic-buffer-token',expiresAt:new Date(Date.now()+600000).toISOString()},new Date(Date.now()+600000).toISOString()));
  assert.ok((await list()).includes('sign-in'));
  await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');
  assert.match((await run()).held,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});

  // Alone: everything due is fixed, audited once, and replays change nothing.
  assert.deepEqual(await run(),{fixed:4,notFixed:0});
  assert.deepEqual(await list(),[]);
  assert.equal(await audits(fixes.ACTIONS.fixed),4);
  assert.deepEqual(await run(),{fixed:0,notFixed:0});
  assert.equal(await audits(fixes.ACTIONS.fixed),4);
  // The matches are exact, and the held order's issue is closed.
  const matched=async external=>(await db.query("SELECT foundry_record_id,confidence FROM connection_mappings WHERE connector_id=$1 AND entity_type='sku' AND external_id=$2",[f.connectorId,external])).rows[0];
  assert.deepEqual(await matched('late-variant'),{foundry_record_id:late.skuIds[0],confidence:'exact'});
  assert.equal((await matched('held-variant')).foundry_record_id,barcoded.skuIds[0]);
  assert.equal((await db.query("SELECT status FROM connection_issues WHERE fingerprint=$1",['UNKNOWN_SKU:'+f.connectorId+':held-variant'])).rows[0].status,'RESOLVED');
  // The failed update was sent again with the current stock, and reached the channel.
  const resent=await position();
  assert.notEqual(resent.pending_effect_id,failed);
  assert.deepEqual((await effect(resent.pending_effect_id)).payload.resend,{of:failed,attempt:1});
  await deliver();
  assert.equal(f.remote.value,19);
  // The sign-in was renewed.
  assert.equal(renewals.length,1);
  assert.ok(new Date((await db.query("SELECT expires_at FROM connection_credentials WHERE connector_id=$1",[f.connectorId])).rows[0].expires_at)>Date.now()+3600000);

  // Undo removes a match StockChief made, and StockChief leaves it to the owner after that.
  const fixedMatch=(await db.query(`SELECT id FROM security_event_history WHERE workspace_id=$1 AND action=$2 AND reference=$3`,[ws,fixes.ACTIONS.fixed,'match:'+f.connectorId+':late-variant'])).rows[0];
  page=await browser.get(fixes.path).expect(200);
  assert.match(page.text,/late-variant matched to LATE-1/);
  await browser.post(fixes.path+'/undo').type('form').send({_csrf:f.csrf(page.text),entry:fixedMatch.id}).expect(303);
  assert.equal(await matched('late-variant'),undefined);
  assert.deepEqual(await list(),['match (needs a person)']);
  assert.deepEqual(await run(),{fixed:0,notFixed:0});
  await fixes.undo(db,ctx,fixedMatch.id);// Replays are harmless.
  assert.equal(await audits(fixes.ACTIONS.undone),1);

  // A rate limit that outlasted the update's own tries: tried again after a wait, at most three times.
  await subscribe('pro');
  await order(1);await f.reconcile();
  const limited=(await position()).pending_effect_id;
  const busy={...adapter,writeSyncPosition:async()=>{throw Object.assign(new Error('Too many requests'),{status:429,retryAfterMs:60000});}};
  await assert.rejects(f.sync.execute(db,ws,limited,{providers:{get:()=>busy}}),/Too many requests/);
  assert.equal((await effect(limited)).error_code,'provider_rate_limited');
  await db.query("UPDATE stockchief_runtime.jobs SET status='DEAD',completed_at=now()-interval '20 minutes' WHERE payload->>'effectId'=$1",[limited]);
  assert.deepEqual((await list()).sort(),['match (needs a person)','retry']);
  assert.deepEqual(await run(),{fixed:1,notFixed:0});
  assert.equal((await db.query("SELECT status FROM stockchief_runtime.jobs WHERE payload->>'effectId'=$1",[limited])).rows[0].status,'RETRY');
  await deliver();
  assert.equal((await effect(limited)).status,'SUCCEEDED');assert.equal(f.remote.value,18);

  // When the channel's count changed since StockChief last checked it, the update is not sent again: a person decides.
  await subscribe('enterprise');
  await db.transaction(c=>cache(c,connection,{entityType:'sku',externalId:'custom-variant',code:'CUSTOM-1',displayName:'Custom product',providerData:{itemName:'Custom product'}}));
  const custom=await catalog.createItem(db,ctx,{name:'Custom product',baseCode:'CUSTOM-1',trackingMode:'quantity'});
  await db.query("UPDATE skus SET code='CUSTOM-1' WHERE id=$1",[custom.skuIds[0]]);
  assert.deepEqual(await run(),{fixed:1,notFixed:0});
  assert.equal((await matched('custom-variant')).foundry_record_id,custom.skuIds[0]);
  const conflict=await failPush();
  f.remote.value=30;
  assert.deepEqual(await run(),{fixed:0,notFixed:1});
  assert.match((await db.query('SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action=$2 ORDER BY created_at DESC LIMIT 1',[ws,fixes.ACTIONS.failed])).rows[0].after_state.reason,/channel count changed/);
  assert.equal((await position()).pending_effect_id,conflict);
  assert.deepEqual(await run(),{fixed:0,notFixed:0},'A fix that did not work waits before the next try.');
  // A lost webhook the channel keeps refusing, and a refused sign-in, wait for a person.
  hookError=Object.assign(new Error('Webhook address refused'),{status:422});
  await db.query(`UPDATE connection_issues SET status='OPEN',resolved_at=NULL WHERE fingerprint=$1`,['push-setup:'+f.connectorId]);
  // Two earlier tries today did not work either.
  for(const hours of [3,2])await db.query(`INSERT INTO security_event_history(id,workspace_id,actor_id,action,reference,created_at)
    VALUES($1,$2,$3,$4,$5,now()-$6*interval '1 hour')`,[randomUUID(),ws,ctx.actorId,fixes.ACTIONS.failed,'webhook:'+f.connectorId,hours]);
  assert.deepEqual(await run(),{fixed:0,notFixed:1});
  assert.ok((await list()).includes('webhook (needs a person)'),'After three tries in a day a person checks the webhook.');
  await db.query("UPDATE workspace_connectors SET setup_status='REAUTHORIZATION_REQUIRED',status='error' WHERE id=$1",[f.connectorId]);
  assert.deepEqual((await list()).filter(k=>k.startsWith('reconnect')),['reconnect (needs a person)']);

  // The page reads well on a desktop and on a 390 px phone.
  await db.query("UPDATE workspace_connectors SET setup_status='CONNECTED',status='connected' WHERE id=$1",[f.connectorId]);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+fixes.path);
    assert(await tab.getByRole('heading',{name:'Watch channel sync and fix common errors',exact:true}).isVisible());
    assert.match(await tab.locator('main').innerText(),/Fixed on its own/);
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'channel-sync-fixes-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
