'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');

test('customer Xero Starter rollout: real consent on every plan, global capacity, read-only authority and billing preservation',{timeout:360000},async t=>{
 const environment={...process.env},oldFetch=global.fetch;
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 let app,server,browser;
 t.after(async()=>{global.fetch=oldFetch;process.env={...environment};if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));if(app)await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',XERO_CLIENT_ID:'customer-rollout-fixture',XERO_CLIENT_SECRET:'isolated-secret',
  STOCKCHIEF_XERO_STARTER_CLIENT_ID:'customer-rollout-fixture',STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED:'1',
  STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED:'0',
  STOCKCHIEF_PRODUCTION_XERO_WORKSPACES:'',STOCKCHIEF_PRODUCTION_QUICKBOOKS_WORKSPACES:'',
  STOCKCHIEF_CHECKOUT_ENABLED:'true',STOCKCHIEF_BILLING_AUTOMATIC_TAX:'false',STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID:'acct_1UBFTdIjKuQgOJD6'});
 await db.query("UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true");
 await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
 for(const version of ['','unversioned','2.0'])for(const operation of ['http_request','authorization_exchange','accounting_verify','catalog_sync','accounting_snapshot'])
  await db.query(`INSERT INTO commercial_cost_rates(id,provider,operation,unit,cost_per_unit_minor,effective_from,source,provider_version,pricing_basis,confidence)
   VALUES($1,'xero',$2,$4,0,'1970-01-01','ISOLATED_FREE_TIER_FIXTURE',$3,'VERIFIED_PUBLIC','HIGH')`,[randomUUID(),operation,version,operation==='http_request'?'request':'operation']);
 const service=require('../../src/connections/postgres-provider-service'),connections=require('../../src/connections/postgres-service');
 const rollout=require('../../src/connections/xero-customer-rollout'),entitlements=require('../../src/commercial/entitlements'),store=require('../../src/connections/postgres-credential-store');
 const release=require('../../src/commercial/release'),accounting=require('../../src/accounting/postgres-integration-sync'),registry=require('../../src/connections/providers/registry');
 const calls=[],organizations=new Set(),journals=new Map();let revokeApproval=false,grantWriteScopes=false,writeFixture=false,journalPosts=0;
 const token=org=>'fixture.'+Buffer.from(JSON.stringify({authentication_event_id:org,scope:grantWriteScopes?['accounting.manualjournals','accounting.invoices']:['accounting.invoices.read']})).toString('base64url')+'.fixture';
 global.fetch=async(value,init={})=>{
  const url=new URL(value);assert(['identity.xero.com','api.xero.com'].includes(url.hostname),'No other provider may be called');
  calls.push({path:url.pathname,method:init.method||'GET'});
  if(url.pathname==='/connect/token'){const body=new URLSearchParams(init.body);const org=body.get('code')||'org-starter';organizations.add(org);return Response.json({access_token:token(org),refresh_token:'refresh-'+org,expires_in:1800});}
  if(url.pathname==='/connections')return Response.json([...organizations].map(org=>({id:'grant-'+org,tenantId:org,authEventId:org,tenantType:'ORGANISATION'})));
  if(url.pathname.startsWith('/connections/')&&init.method==='DELETE')return new Response(null,{status:204});
  const org=init.headers?.['xero-tenant-id'];
  if(url.pathname.endsWith('/Organisation')){if(revokeApproval)process.env.STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED='0';return Response.json({Organisations:[{OrganisationID:org,Name:'Customer books '+org,BaseCurrency:'USD',IsDemoCompany:false}]});}
  if(url.pathname.endsWith('/Items'))return Response.json({Items:[]});
  if(url.pathname.endsWith('/Accounts'))return Response.json({Accounts:writeFixture?[{AccountID:'xero-expense',Code:'500',Name:'Expense',Type:'EXPENSE',Status:'ACTIVE'},{AccountID:'xero-clearing',Code:'130',Name:'Clearing',Type:'CURRENT',Status:'ACTIVE'}]:[]});
  if(url.pathname.endsWith('/Reports/TrialBalance'))return Response.json({Reports:[{Rows:[{RowType:'Header',Cells:[{Value:'Account'},{Value:'Debit'},{Value:'Credit'}]}]}]});
  if(url.pathname.endsWith('/ManualJournals')&&init.method==='POST'){
   assert(writeFixture,'Only the governed-write subtest may post');const key=init.headers['idempotency-key'];
   if(!journals.has(key)){const row=JSON.parse(init.body).ManualJournals[0];journalPosts++;journals.set(key,{...row,ManualJournalID:randomUUID(),JournalLines:row.JournalLines.map(l=>({...l,AccountID:l.AccountCode==='500'?'xero-expense':'xero-clearing',TaxAmount:0}))});}
   return Response.json({ManualJournals:[journals.get(key)]});
  }
  if(url.pathname.includes('/ManualJournals/')){const id=url.pathname.split('/').at(-1);return Response.json({ManualJournals:[...journals.values()].filter(row=>row.ManualJournalID===id)});}
  throw Error('Unrecognized provider fixture request: '+url.pathname);
 };
 const owners=[];
 async function owner(plan){const email=randomUUID()+'@example.test',password='Customer!'+randomUUID();
  const created=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:plan+' customer',email,password});
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end,source) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month','ISOLATED_TEST')",[randomUUID(),created.accountId,plan]);
  const result={...created,email,password,ctx:{workspaceId:created.workspaceId,actorId:created.userId},scope:{accountId:created.accountId,workspaceId:created.workspaceId}};owners.push(result);return result;
 }
 const start=async(o,input={})=>{const started=await service.beginAuthorization(db,o.ctx,{providerType:'xero',...input},'https://customer.example.test');return new URL(started.redirectUrl);};
 const complete=(url,org)=>service.completeOAuth(db,'xero',{state:url.searchParams.get('state'),code:org},'https://customer.example.test');
 const snapshot=async()=>({subscriptions:(await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s ORDER BY account_id')).rows,
  otherConnections:(await db.query("SELECT to_jsonb(c) state FROM workspace_connectors c WHERE provider_type<>'xero' ORDER BY id")).rows,
  otherGrants:(await db.query("SELECT to_jsonb(g) state FROM connection_credentials g JOIN workspace_connectors c ON c.id=g.connector_id WHERE c.provider_type<>'xero' ORDER BY g.id")).rows});
 app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'xero-customer-browser-fixture'});
 server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
 browser=await require('playwright').chromium.launch();const base='http://127.0.0.1:'+server.address().port;
 const output=path.join(process.cwd(),'output','xero-customer-rollout');fs.mkdirSync(output,{recursive:true});
 for(const plan of ['starter','growth','pro'])await t.test(plan+' customers connect without a pilot allowlist, compare and disconnect/reconnect',async()=>{
  const o=await owner(plan),mailId=randomUUID();
  await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,created_at,updated_at) VALUES($1,$2,$1,'Existing Gmail','gmail','[]','{}','connected',now(),now())",[mailId,o.workspaceId]);
  await store.put(db,o.workspaceId,mailId,'provider',{accessToken:'preserved-'+plan,refreshToken:'preserved-refresh'});
  const before=await snapshot();
  assert.equal((await entitlements.capabilityState(db,o.scope,'connections.accounting',{providerType:'xero'})).enabled,true);
  const qbAccess=await entitlements.capabilityState(db,o.scope,'connections.accounting',{providerType:'quickbooks'});
  process.env.STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED='0';
  assert.equal((await entitlements.capabilityState(db,o.scope,'connections.accounting',{providerType:'quickbooks'})).enabled,qbAccess.enabled,'Xero must not change the existing QuickBooks plan decision');
  process.env.STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED='1';
  assert.notEqual(qbAccess.source,'xero_starter_customer');
  await assert.rejects(service.beginAuthorization(db,o.ctx,{providerType:'quickbooks'},'https://customer.example.test'),/not included/);
  await assert.rejects(start(o,{requestedAuthority:'POST'}),/read-only/);
  const url=await start(o);assert(!url.searchParams.get('scope').split(' ').includes('accounting.manualjournals'));
  assert(!url.searchParams.get('scope').split(' ').includes('accounting.invoices'));
  const connected=await complete(url,'org-'+plan);o.connection=connected;
  assert(rollout.certified(connected));assert.equal(connected.status,'connected');assert(!connected.capabilities.includes('accounting:post'));
  assert.equal((await store.get(db,o.workspaceId,connected.id,'provider')).tenantId,'org-'+plan);
  assert.equal(await release.isOpen(db),true,'Customer Xero qualification preserves subscription checkout');
  await accounting.chooseAuthority(db,o.ctx,connected.id,'SHADOW');
  const compared=await accounting.shadow(db,o.ctx,connected.id,registry.get('xero'),await store.get(db,o.workspaceId,connected.id,'provider'),{asOf:'2026-11-22'});
  assert(['MATCHED','MISMATCH'].includes(compared.status));
  await assert.rejects(accounting.chooseAuthority(db,o.ctx,connected.id,'POST'),/read-only/);
  assert.equal((await accounting.state(db,o.workspaceId,connected.id)).canVerifyWrites,false);
  assert.deepEqual(await snapshot(),before);
  const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(15000);
  await page.goto(base+'/login');await page.getByLabel('Work email',{exact:true}).fill(o.email);await page.locator('input[name="password"]').fill(o.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(url=>!url.pathname.startsWith('/login'));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const [size,width,height]of [['desktop',1440,1000],['mobile',390,844]]){
   await page.setViewportSize({width,height});await page.goto(base+'/settings/connections');
   const card=page.locator('[data-integration-card="xero"]');await card.waitFor();assert.match(await card.innerText(),/cannot change your Xero books/);
   assert.equal(await card.getByRole('link',{name:'Manage Xero',exact:true}).count(),1);
   assert(!/View plan options/.test(await card.innerText()));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
   await page.screenshot({path:path.join(output,plan+'-'+size+'.png'),fullPage:true});
   await page.goto(base+'/settings/connections/'+connected.id+'?reviewAccounting=1');
   assert.equal(await page.getByRole('button',{name:'Request governed posting'}).count(),0);
  }
  assert.deepEqual(errors,[]);await context.close();
  await connections.disconnect(db,o.workspaceId,connected.id);
  assert.equal((await connections.get(db,o.workspaceId,connected.id)).status,'disconnected');
  o.connection=await complete(await start(o,{connectorId:connected.id}),'org-'+plan);assert.equal(o.connection.id,connected.id);
  assert.deepEqual(await snapshot(),before);assert.equal(await release.isOpen(db),true);
 });
 await t.test('governed customer writes require fresh owner scope, plan authority and matching books; day-one manual work preserves billing',async()=>{
  const previous=process.env.STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED,before=await snapshot();
  process.env.STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED='1';writeFixture=true;
  try{for(const o of owners.slice(0,3)){
   const box=o.connection,id=box.id,org=box.provider_account_id;
   const permission=await entitlements.capabilityState(db,o.scope,'accounting.post_connected');
   if(!permission.enabled){await assert.rejects(start(o,{connectorId:id,requestedAuthority:'POST'}),/requires|unavailable/);continue;}
   await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason,source) VALUES($1,$2,'accounting.post_connected',0,'Test posting denial','ISOLATED_TEST')",[randomUUID(),o.accountId]);
   await assert.rejects(accounting.chooseAuthority(db,o.ctx,id,'POST'),/requires|unavailable/);
   await assert.rejects(start(o,{connectorId:id,requestedAuthority:'POST'}),/requires|unavailable/);
   assert.equal((await accounting.state(db,o.workspaceId,id)).canVerifyWrites,false);
   await db.query("DELETE FROM commercial_entitlement_overrides WHERE account_id=$1 AND capability='accounting.post_connected'",[o.accountId]);
   await accounting.chooseAuthority(db,o.ctx,id,'POST');
   await assert.rejects(accounting.enableWrites(db,o.ctx,id),/posting permission|matching shadow/);
   const old=await store.get(db,o.workspaceId,id,'provider'),missing=await start(o,{connectorId:id,requestedAuthority:'POST'});
   grantWriteScopes=false;await assert.rejects(complete(missing,org),/posting permissions/);assert.deepEqual(await store.get(db,o.workspaceId,id,'provider'),old);
   const request=await start(o,{connectorId:id,requestedAuthority:'POST'});assert(request.searchParams.get('scope').includes('accounting.manualjournals'));
   grantWriteScopes=true;o.connection=await complete(request,org);grantWriteScopes=false;
   assert(rollout.postingCertified(o.connection));assert.equal((await accounting.policy(db,o.workspaceId,id)).requested_authority,'POST');
   assert.equal((await accounting.policy(db,o.workspaceId,id)).stage,'SHADOW','Consent preserves the requested authority without enabling writes');
   assert.equal(await release.isOpen(db),true);
   const today=await require('../../src/lib/business-time').today(db,o.workspaceId),ledger=require('../../src/accounting/postgres-ledger');
   await ledger.configure(db,o.ctx,{startDate:today,currency:'USD'});
   const adapter=registry.get('xero'),grant=await store.get(db,o.workspaceId,id,'provider');
   await accounting.shadow(db,o.ctx,id,adapter,grant,{asOf:today});
   const accounts=(await db.query("SELECT id,system_key FROM accounting_accounts WHERE workspace_id=$1 AND system_key=ANY($2::text[])",[o.workspaceId,['CASH','OPERATING_EXPENSE']])).rows;
   for(const a of accounts)await accounting.mapAccount(db,o.ctx,id,{accountId:a.id,externalId:a.system_key==='CASH'?'xero-clearing':'xero-expense'});
   const matched=await accounting.shadow(db,o.ctx,id,adapter,grant,{asOf:today});assert.equal(matched.status,'MATCHED');
   await accounting.enableWrites(db,o.ctx,id);
   const journal=await ledger.post(db,o.ctx,{postingDate:today,sourceKey:'customer-write-'+id,description:'Individually reviewed test journal',sourceType:'manual_certification',createdByType:'USER',lines:[{accountKey:'OPERATING_EXPENSE',debitMinor:1},{accountKey:'CASH',creditMinor:1}]});
   await assert.rejects(accounting.queuePending(db,o.ctx,id,{entryIds:[journal.id]},{agentRequested:true}),/first 14 days/);
   const queued=await accounting.queuePending(db,o.ctx,id,{entryIds:[journal.id]});assert.equal(queued.queued,1);
   const count=journalPosts,run=require('../../src/operations/postgres-runtime-handlers').create()['provider.effect'];
   const result=await run({kind:'provider.effect',workspaceId:o.workspaceId,payload:{effectId:queued.effects[0].id}},db);assert(result.externalId);assert.equal(journalPosts,count+1);
   await run({kind:'provider.effect',workspaceId:o.workspaceId,payload:{effectId:queued.effects[0].id}},db);assert.equal(journalPosts,count+1,'Confirmed effects never create duplicates');
   assert.equal(await release.isOpen(db),true,'Native write pricing must preserve checkout');
   process.env.STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED='0';assert.throws(()=>rollout.assertNoPosting(o.connection),/read-only/);assert(rollout.certified(o.connection));assert.equal(await release.isOpen(db),true);
   process.env.STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED='1';
   const current=await connections.get(db,o.workspaceId,id);assert(rollout.postingCertified(current));
  }
  assert(journalPosts>0,'The customer rollout must exercise the native write path, not only denied plans');
  assert.deepEqual(await snapshot(),before);assert.equal((await rollout.availability(db)).maximum,5);
  }finally{writeFixture=false;grantWriteScopes=false;if(previous===undefined)delete process.env.STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED;else process.env.STOCKCHIEF_XERO_GOVERNED_WRITES_APPROVED=previous;}
 });
 await t.test('global last-slot reservations serialize across customer accounts and expire without altering grants',async()=>{
  const a=await owner('growth'),b=await owner('growth'),c=await owner('growth');
  const before=await snapshot(),urls=await Promise.all([start(a),start(b)]);
  assert.equal((await rollout.availability(db)).remaining,0);
  await assert.rejects(start(c),/at capacity/);assert.deepEqual(await snapshot(),before);
  await assert.rejects(service.completeOAuth(db,'xero',{state:urls[0].searchParams.get('state'),error:'access_denied'},'https://customer.example.test'),/not completed|access_denied/);
  assert.equal((await rollout.availability(db)).remaining,1);
  await db.query('UPDATE connection_authorization_states SET expires_at=$2 WHERE state_hash=$1',[service.stateHash(urls[1].searchParams.get('state')),new Date(Date.now()-1000).toISOString()]);
  assert.equal((await rollout.availability(db)).remaining,2);
  const first=await start(a),races=await Promise.allSettled([start(b),start(c)]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal(races.filter(r=>r.status==='rejected').length,1);
  await complete(first,'org-fourth');const fifth=races.find(r=>r.status==='fulfilled').value;await complete(fifth,'org-fifth');
  assert.equal((await rollout.availability(db)).remaining,0);
  const established=owners[0],oldGrant=await store.get(db,established.workspaceId,established.connection.id,'provider');
  const reconnect=await start(established,{connectorId:established.connection.id});
  await assert.rejects(complete(reconnect,'org-sixth'),/same Xero organization/);
  // The pinned reconnect now refuses a different company before capacity
  // admission. Keep the independent last-slot guard covered as well.
  await assert.rejects(db.transaction(client=>rollout.admit(client,established.connection,{accountId:'org-sixth'},null)),/at capacity/);
  assert.deepEqual(await store.get(db,established.workspaceId,established.connection.id,'provider'),oldGrant);
  const connected=await complete(await start(established,{connectorId:established.connection.id}),'org-starter');assert.equal(connected.id,established.connection.id);
  assert.equal((await db.query("SELECT count(DISTINCT provider_account_id)::int n FROM workspace_connectors WHERE provider_type='xero' AND status<>'disconnected'")).rows[0].n,5);
  assert.equal(await release.isOpen(db),true);assert.deepEqual(await snapshot(),before);
  const context=await browser.newContext(),page=await context.newPage();
  await page.goto(base+'/login');await page.getByLabel('Work email',{exact:true}).fill(established.email);await page.locator('input[name="password"]').fill(established.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(url=>!url.pathname.startsWith('/login'));
  await page.goto(base+'/settings/connections');const card=page.locator('[data-integration-card="xero"]');
  assert.match(await card.innerText(),/at capacity/);assert.equal(await card.getByRole('link',{name:'Manage Xero',exact:true}).count(),1);
  assert.equal(await card.getByRole('link',{name:'Connect Xero',exact:true}).count(),0);
  await page.screenshot({path:path.join(output,'capacity-full.png'),fullPage:true});await context.close();
 });
 await t.test('onboarding pause preserves qualified reads and checkout; application mismatch and explicit access denials fail closed',async()=>{
  const o=owners[0],before=await snapshot();
  process.env.STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED='0';
  assert.equal((await entitlements.capabilityState(db,o.scope,'connections.accounting',{providerType:'xero'})).enabled,true);
  assert.equal(await release.isOpen(db),true);await assert.rejects(start(owners.at(-1)),/not included/);
  process.env.STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED='1';
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason,source) VALUES($1,$2,'connections.accounting',0,'Test access denial','ISOLATED_TEST')",[randomUUID(),o.accountId]);
  assert.equal((await entitlements.capabilityState(db,o.scope,'connections.accounting',{providerType:'xero'})).enabled,false);
  await assert.rejects(start(o,{connectorId:o.connection.id}),error=>error.code==='entitlement_required');
  await db.query("DELETE FROM commercial_entitlement_overrides WHERE account_id=$1 AND capability='connections.accounting'",[o.accountId]);
  const subscription=(await db.query('SELECT status,refunded_at,trial_ends_at FROM account_subscriptions WHERE account_id=$1',[o.accountId])).rows[0];
  for(const condition of ["status='SUSPENDED'","refunded_at=now()","status='TRIALING',trial_ends_at=now()-interval '1 hour'"]){
   await db.query('UPDATE account_subscriptions SET '+condition+' WHERE account_id=$1',[o.accountId]);
   assert.equal((await entitlements.capabilityState(db,o.scope,'connections.accounting',{providerType:'xero'})).enabled,false);
   await db.query('UPDATE account_subscriptions SET status=$2,refunded_at=$3,trial_ends_at=$4 WHERE account_id=$1',[o.accountId,subscription.status,subscription.refunded_at,subscription.trial_ends_at]);
  }
  await assert.rejects(entitlements.capabilityState(db,{accountId:owners[1].accountId,workspaceId:o.workspaceId},'connections.accounting',{providerType:'xero'}));
  process.env.STOCKCHIEF_XERO_STARTER_CLIENT_ID='different-app';assert.equal(rollout.enabled(),false);assert.equal(await release.isOpen(db),false);
  process.env.STOCKCHIEF_XERO_STARTER_CLIENT_ID='customer-rollout-fixture';
  const pending=await start(o,{connectorId:o.connection.id});revokeApproval=true;
  await assert.rejects(complete(pending,'org-starter'),/not included/);revokeApproval=false;
  process.env.STOCKCHIEF_XERO_STARTER_CUSTOMERS_APPROVED='1';assert.deepEqual(await snapshot(),before);
 });
 assert(calls.length>0);assert(!calls.some(call=>!['GET','DELETE'].includes(call.method)&&!['/connect/token','/api.xro/2.0/ManualJournals'].includes(call.path)),'Only qualified fixture journal writes are allowed; no paid upgrade or other provider is contacted');
});
