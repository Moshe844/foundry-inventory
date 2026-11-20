'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('private Clover authorization preserves every plan, credentials, cost accounting and public checkout',{timeout:360000},async t=>{
 const previous={...process.env},oldFetch=global.fetch;
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 let browser,app,server;
 try{
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',CLOVER_ENVIRONMENT:'production',CLOVER_CLIENT_ID:'A123456789012',
   CLOVER_CLIENT_SECRET:'isolated-secret',CLOVER_WEBHOOK_AUTH_CODE:'isolated-webhook',STOCKCHIEF_CHECKOUT_ENABLED:'true',
   STOCKCHIEF_BILLING_AUTOMATIC_TAX:'false',STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID:'acct_1UBFTdIjKuQgOJD6'});
  await db.query("UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true");
  await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
  // Qualification fixtures use explicit nonzero estimated costs, never a claim
  // that real Clover API pricing or App Market fees have been verified.
  for(const version of ['v2','v3'])await db.query(`INSERT INTO commercial_cost_rates
   (id,provider,operation,unit,cost_per_unit_minor,effective_from,source,provider_version,pricing_basis,confidence)
   VALUES($1,'clover','http_request','request',0.1,'1970-01-01','ISOLATED_TEST_BUDGET_NOT_PROVIDER_PRICING',$2,'CONSERVATIVE_ESTIMATE','LOW')`,[randomUUID(),version]);
  const service=require('../../src/connections/postgres-provider-service'),auth=require('../../src/domain/postgres-auth-service');
  const store=require('../../src/connections/postgres-credential-store'),release=require('../../src/commercial/release');
  app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),publicOrigin:'request'});
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  browser=await require('playwright').chromium.launch();const base='http://127.0.0.1:'+server.address().port;
  let billable=false,omitBilling=true,called=0;
  global.fetch=async value=>{
   called++;const url=new URL(value);assert.equal(url.origin,'https://api.clover.com','Only the isolated provider transport may be used');
   if(url.pathname==='/oauth/v2/token')return Response.json({access_token:'isolated-access',refresh_token:'isolated-refresh',
    access_token_expiration:Math.floor(Date.now()/1000)+1800,refresh_token_expiration:Math.floor(Date.now()/1000)+86400});
   const id=url.pathname.match(/^\/v3\/merchants\/([A-Z0-9]+)$/)?.[1];assert(id,'Unexpected provider request');
   return Response.json({id,...(omitBilling?{}:{billingInfo:{planBillable:billable,appBillable:billable}}),name:'Isolated Clover test merchant'});
  };
  for(const [index,plan] of ['starter','growth','pro'].entries())await t.test(plan,async()=>{
   billable=false;omitBilling=true;
   const email=randomUUID()+'@example.test',password='Clover!'+randomUUID();
   const owner=await auth.createBusiness(db,{name:'Clover owner',businessName:'Isolated '+plan,email,password});
   await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end)
    VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')`,[randomUUID(),owner.accountId,plan]);
   const ctx={workspaceId:owner.workspaceId,actorId:owner.userId,accountId:owner.accountId},merchant='M12345678901'+index;
   const permits=JSON.parse(process.env.STOCKCHIEF_PRODUCTION_CLOVER_PILOTS||'{}');permits[owner.workspaceId]=[merchant];
   process.env.STOCKCHIEF_PRODUCTION_CLOVER_PILOTS=JSON.stringify(permits);
   const existingId='existing-'+randomUUID();
   await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,created_at,updated_at)
    VALUES($1,$2,$1,'Existing Gmail','gmail','[]','{}','connected',now(),now())`,[existingId,owner.workspaceId]);
   await store.put(db,owner.workspaceId,existingId,'provider',{accessToken:'preserved-mailbox-token',refreshToken:'preserved-mailbox-refresh'});
   const snapshot=async()=>({subscriptions:(await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.accountId])).rows,
    mailbox:await store.get(db,owner.workspaceId,existingId,'provider')});
   const before=await snapshot();
   const started=await service.beginAuthorization(db,ctx,{providerType:'clover',cloverTestMerchantPermit:{source:'untrusted',ownerId:'another-user'}},'https://app.example.test');
   const state=new URL(started.redirectUrl).searchParams.get('state');
   const saved=(await db.query('SELECT metadata FROM connection_authorization_states WHERE state_hash=$1',[service.stateHash(state)])).rows[0];
   assert.equal(JSON.parse(saved.metadata).expectedMerchantId,merchant);
   assert.equal(JSON.parse(saved.metadata).testMerchantPermit.ownerId,owner.userId,'Client input cannot choose the approving owner');
   assert.equal(JSON.parse(saved.metadata).testMerchantPermit.workspaceId,owner.workspaceId);
   const connected=await service.completeOAuth(db,'clover',{state,code:'isolated-code',merchant_id:merchant},'https://app.example.test');
   assert.equal(connected.status,'connected');assert.equal(connected.provider_account_id,merchant);
   assert.equal(connected.config.cloverTestEvidence.isBillable,undefined);
   assert.equal(connected.config.cloverTestEvidence.source,'CLOVER_OWNER_APPROVED_TEST_MERCHANT_V1');
   assert.equal(connected.config.cloverTestEvidence.approvedByUserId,owner.userId);
   assert.equal(connected.config.cloverTestEvidence.ownerApprovedTestMerchant,true);
   assert.deepEqual(await snapshot(),before,'Connecting Clover must preserve billing and the existing mailbox grant');
   assert.equal(await release.isOpen(db),true,'Verified private test must not close public subscription checkout');
   const browserContext=await browser.newContext();
   try{
    const page=await browserContext.newPage();await page.goto(base+'/login');
    await page.locator('[name=email]').fill(email);await page.locator('[name=password]').fill(password);
    await page.locator('button[type=submit]').click();await page.waitForURL(url=>url.pathname!=='/login');
    const requested=[];
    await page.route('https://www.clover.com/oauth/v2/authorize**',route=>{
     requested.push(route.request().url());return route.fulfill({status:200,contentType:'text/html',body:'<h1>Isolated Clover consent</h1>'});
    });
    const providerCalls=called,launchStateCount=(await db.query("SELECT count(*)::int n FROM connection_authorization_states WHERE workspace_id=$1 AND provider_type='clover'",[owner.workspaceId])).rows[0].n;
    for(const query of ['merchantId='+merchant,'merchant_id='+merchant+'&client_id=A123456789012&code=unused-launch-code&state=untrusted']){
     const launch=await page.request.get(base+'/settings/connections?'+query,{maxRedirects:0});
     assert.equal(launch.status(),303,'Opening an installed Clover app must navigate to its saved connection');
     assert.equal(launch.headers().location,'/settings/connections/'+connected.id);
     assert.equal(launch.headers()['cache-control'],'no-store');
    }
    await page.goto(base+'/settings/connections?merchantId='+merchant);
    assert.equal(new URL(page.url()).pathname,'/settings/connections/'+connected.id);
    assert.equal(await page.getByRole('button',{name:'Continue to Clover'}).count(),0,'A connected launch cannot send the owner back to Clover');
    assert.equal(requested.length,0);assert.equal(called,providerCalls,'Reopening must not exchange or refresh provider credentials');
    assert.equal((await db.query("SELECT count(*)::int n FROM connection_authorization_states WHERE workspace_id=$1 AND provider_type='clover'",[owner.workspaceId])).rows[0].n,launchStateCount,'Launch URLs cannot create or consume authorization state');
    const otherMerchant=await page.request.get(base+'/settings/connections?merchantId=N123456789012',{maxRedirects:0});
    assert.equal(otherMerchant.status(),400,'An existing grant cannot authorize a different merchant');
    for(const state of [{status:'connected',setup:'REAUTHORIZATION_REQUIRED',paused:null},{status:'connected',setup:'CONNECTED',paused:new Date().toISOString()},{status:'error',setup:'CONNECTED',paused:null}]){
     await db.query('UPDATE workspace_connectors SET status=$2,setup_status=$3,paused_at=$4 WHERE id=$1',[connected.id,state.status,state.setup,state.paused]);
     const inactive=await page.request.get(base+'/settings/connections?merchantId='+merchant,{maxRedirects:0});
     assert.equal(inactive.status(),200);assert.match(await inactive.text(),/Continue to Clover/,'An inactive grant still requires explicit authorization');
    }
    await db.query("UPDATE workspace_connectors SET status='disconnected',setup_status='CONNECTED',paused_at=NULL WHERE id=$1",[connected.id]);
    await page.goto(base+'/settings/connections?merchantId='+merchant);
    assert.equal(await page.getByRole('heading',{name:'Connect your Clover test merchant'}).count(),1);
    assert.match(await page.locator('main').innerText(),/does not change your StockChief plan/);
    if(plan==='starter'){
     await require('node:fs/promises').mkdir('output/remaining-connectors/ui',{recursive:true});
     await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.fonts.ready);
     await page.screenshot({path:'output/remaining-connectors/ui/clover-connect-desktop.png',fullPage:true,animations:'disabled'});
     await page.setViewportSize({width:390,height:844});
     await page.screenshot({path:'output/remaining-connectors/ui/clover-connect-mobile.png',fullPage:true,animations:'disabled'});
     await page.setViewportSize({width:1440,height:1000});
    }
    const rejected=await page.request.post(base+'/settings/connections/clover/install',{headers:{accept:'application/json'},form:{merchantId:merchant}});
    assert.equal(rejected.status(),403,'A forged POST cannot start Clover authorization');
    const csrf=await page.locator('form[action="/settings/connections/clover/install"] [name="_csrf"]').inputValue();
    await db.query("UPDATE workspace_connectors SET status='connected' WHERE id=$1",[connected.id]);
    const stale=await page.request.post(base+'/settings/connections/clover/install',{maxRedirects:0,form:{merchantId:merchant,_csrf:csrf}});
    assert.equal(stale.status(),303);assert.equal(stale.headers().location,'/settings/connections/'+connected.id,'Submitting an old setup tab must open the connection completed in another tab');
    assert.equal(called,providerCalls);assert.equal(requested.length,0);
    await db.query("UPDATE workspace_connectors SET status='disconnected' WHERE id=$1",[connected.id]);
    await page.goto(base+'/settings/connections?merchantId='+merchant);
    await page.getByRole('button',{name:'Continue to Clover'}).click();
    await page.getByRole('heading',{name:'Isolated Clover consent'}).waitFor();assert.equal(requested.length,1);
    const providerUrl=new URL(requested[0]);assert.equal(providerUrl.searchParams.get('client_id'),'A123456789012');
    assert.equal(providerUrl.searchParams.get('redirect_uri'),base+'/settings/connections/clover/callback');
    await db.query('DELETE FROM connection_authorization_states WHERE state_hash=$1 AND used_at IS NULL',[service.stateHash(providerUrl.searchParams.get('state'))]);
    await db.query("UPDATE workspace_connectors SET status='connected',setup_status='CONNECTED',paused_at=NULL WHERE id=$1",[connected.id]);
   }finally{await browserContext.close();}
   const grant=await store.get(db,owner.workspaceId,connected.id,'provider');
    assert.equal(grant.billingEvidence.isBillable,null);assert.equal(grant.isBillable,undefined);
    assert.equal(grant.providerBillingFieldsOmitted,true);
    billable=true;omitBilling=false;
   const retry=await service.beginAuthorization(db,ctx,{providerType:'clover',connectorId:connected.id},'https://app.example.test');
   await assert.rejects(service.completeOAuth(db,'clover',{state:new URL(retry.redirectUrl).searchParams.get('state'),code:'isolated-code',merchant_id:merchant},'https://app.example.test'),/non-billable/);
    const rejectedState=(await db.query('SELECT metadata FROM connection_authorization_states WHERE state_hash=$1',
     [service.stateHash(new URL(retry.redirectUrl).searchParams.get('state'))])).rows[0];
    const failure=JSON.parse(rejectedState.metadata).cloverBillingVerification;
    assert.equal(failure.source,'billingInfo');assert.equal(failure.isBillable,true);
    assert.equal(JSON.stringify(failure).includes('isolated-access'),false,'Failure evidence must not store provider tokens');
   assert.deepEqual(await store.get(db,owner.workspaceId,connected.id,'provider'),grant,'Rejected replacement consent must preserve the working grant');
    billable=false;
    const current=await service.beginAuthorization(db,ctx,{providerType:'clover',connectorId:connected.id},'https://app.example.test');
    const verified=await service.completeOAuth(db,'clover',{state:new URL(current.redirectUrl).searchParams.get('state'),code:'isolated-code',merchant_id:merchant},'https://app.example.test');
    assert.equal(verified.config.cloverTestEvidence.source,'CLOVER_NONBILLABLE_TEST_MERCHANT_V1');
    assert.equal(verified.config.cloverTestEvidence.isBillable,false);
    assert.equal(verified.config.cloverTestEvidence.ownerApprovedTestMerchant,undefined,'Provider-confirmed status replaces the owner-evidence record');
    assert.equal(await release.isOpen(db),true);
   assert.deepEqual(await snapshot(),before);assert.equal(await release.isOpen(db),true);
   await db.query("UPDATE workspace_connectors SET config='{}' WHERE id=$1",[connected.id]);
   assert.equal(await release.isOpen(db),false,'An allowlist alone is insufficient without verified non-billable merchant evidence');
   await db.query('UPDATE workspace_connectors SET config=$2 WHERE id=$1',[connected.id,JSON.stringify(connected.config)]);
   assert.equal(await release.isOpen(db),true);
  });
  assert(called>0);
  assert.equal((await db.query("SELECT count(*)::int n FROM commercial_critical_warnings WHERE status='OPEN' AND code='MISSING_COST_RATE'")).rows[0].n,0);
  assert((await db.query("SELECT 1 FROM commercial_cost_events WHERE provider='clover' AND operation='http_request' AND amount_minor>0")).rows.length>0,'Real HTTP attempts retain explicit estimated costs');
 }finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));if(app)await app.locals.sessionStore.close();global.fetch=oldFetch;process.env={...previous};await db.close();await cluster.stop();}
});
