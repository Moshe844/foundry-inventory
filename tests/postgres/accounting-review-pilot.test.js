'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('private production accounting consent preserves billing and existing grants on all plans',{timeout:360000},async t=>{
 const environment={...process.env},oldFetch=global.fetch;
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 try{
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',QUICKBOOKS_ENVIRONMENT:'production',
   QUICKBOOKS_CLIENT_ID:'isolated-qb',QUICKBOOKS_CLIENT_SECRET:'isolated-qb-secret',XERO_CLIENT_ID:'isolated-xero',XERO_CLIENT_SECRET:'isolated-xero-secret',
   STOCKCHIEF_CHECKOUT_ENABLED:'true',STOCKCHIEF_BILLING_AUTOMATIC_TAX:'false',STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID:'acct_1UBFTdIjKuQgOJD6'});
  await db.query("UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true");
  await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
  for(const provider of ['xero','quickbooks'])for(const version of ['','unversioned','2.0','v1','v3:minor75'])
   for(const operation of ['http_request','authorization_exchange','accounting_verify','accounting_snapshot'])
    await db.query(`INSERT INTO commercial_cost_rates(id,provider,operation,unit,cost_per_unit_minor,effective_from,source,provider_version,pricing_basis,confidence)
     VALUES($1,$2,$3,$5,0.1,'1970-01-01','ISOLATED_QUALIFICATION_ESTIMATE_NOT_PROVIDER_PRICING',$4,'CONSERVATIVE_ESTIMATE','LOW')`,[randomUUID(),provider,operation,version,operation==='http_request'?'request':'operation']);
  const service=require('../../src/connections/postgres-provider-service'),auth=require('../../src/domain/postgres-auth-service');
  const store=require('../../src/connections/postgres-credential-store'),release=require('../../src/commercial/release');
  let calls=0,revokeOnVerification=false,currentProvider;
  global.fetch=async value=>{
   calls++;const url=new URL(value);assert(['oauth.platform.intuit.com','quickbooks.api.intuit.com','identity.xero.com','api.xero.com'].includes(url.hostname));
   if(url.pathname.endsWith('/token')||url.pathname.endsWith('/tokens/bearer'))return Response.json({access_token:'isolated-access',refresh_token:'isolated-refresh',expires_in:1800});
   if(url.pathname==='/connections')return Response.json([{tenantId:'isolated-org',tenantType:'ORGANISATION'}]);
   if(revokeOnVerification)delete process.env[currentProvider==='xero'?'STOCKCHIEF_PRODUCTION_XERO_WORKSPACES':'STOCKCHIEF_PRODUCTION_QUICKBOOKS_WORKSPACES'];
   if(url.hostname==='quickbooks.api.intuit.com')return Response.json({CompanyInfo:{Id:'1',CompanyName:'Isolated company'}});
   if(url.pathname.endsWith('/Organisation'))return Response.json({Organisations:[{OrganisationID:'isolated-org',Name:'Isolated organization'}]});
   throw Error('Unexpected provider fixture request');
  };
  for(const plan of ['starter','growth','pro'])for(const provider of ['xero','quickbooks'])await t.test(plan+' / '+provider,async()=>{
   currentProvider=provider;revokeOnVerification=false;
   const owner=await auth.createBusiness(db,{name:'Accounting Owner',businessName:plan+' '+provider,email:randomUUID()+'@example.test',password:'Accounting!'+randomUUID()});
   await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[randomUUID(),owner.accountId,plan]);
   const envKey=provider==='xero'?'STOCKCHIEF_PRODUCTION_XERO_WORKSPACES':'STOCKCHIEF_PRODUCTION_QUICKBOOKS_WORKSPACES';
   process.env[envKey]=[process.env[envKey],owner.workspaceId].filter(Boolean).join(',');
   const ctx={workspaceId:owner.workspaceId,actorId:owner.userId,accountId:owner.accountId},existingId='existing-'+randomUUID();
   await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,created_at,updated_at) VALUES($1,$2,$1,'Existing Gmail','gmail','[]','{}','connected',now(),now())",[existingId,owner.workspaceId]);
   await store.put(db,owner.workspaceId,existingId,'provider',{accessToken:'preserved',refreshToken:'preserved-refresh'});
   const snapshot=async()=>({subscriptions:(await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.accountId])).rows,
    mailbox:await store.get(db,owner.workspaceId,existingId,'provider')});
   const before=await snapshot(),callCount=calls;
   const capability=await require('../../src/commercial/entitlements').capabilityState(db,{accountId:owner.accountId,workspaceId:owner.workspaceId},'connection.accounting');
   if(!capability.enabled){
    await assert.rejects(()=>service.beginAuthorization(db,ctx,{providerType:provider},'https://app.example.test'),error=>error.code==='entitlement_required');
    assert.equal(calls,callCount);assert.deepEqual(await snapshot(),before);return;
   }
   const start=()=>service.beginAuthorization(db,ctx,{providerType:provider},'https://app.example.test');
   const complete=started=>service.completeOAuth(db,provider,{state:new URL(started.redirectUrl).searchParams.get('state'),code:'isolated-code',realmId:'isolated-realm'},'https://app.example.test');
   const connected=await complete(await start());
   assert.equal(connected.status,'connected');assert.equal(connected.config.accountingPilotEvidence.qualificationOnly,true);
   assert.equal(connected.config.accountingPilotEvidence.approvedByUserId,owner.userId);
   assert.deepEqual(await snapshot(),before);assert.equal(await release.isOpen(db),true,'Private qualification must preserve subscription checkout');
   const sync=require('../../src/accounting/postgres-integration-sync');
   await sync.chooseAuthority(db,ctx,connected.id,'SHADOW');
   const compared=await sync.shadow(db,ctx,connected.id,{metadata:()=>({id:'untrusted-adapter-label'}),
    readAccountingSnapshot:async()=>({currency:'USD',accounts:[]})},{},{asOf:'2026-11-21'});
   const cost=(await db.query("SELECT provider,amount_minor FROM commercial_cost_events WHERE idempotency_key LIKE $1",['%accounting-shadow:'+compared.runId+':attempt:%'])).rows;
   assert.equal(cost.length,1);assert.equal(cost[0].provider,provider,'The stored accounting policy identifies the actual cost provider');
   assert.notEqual(cost[0].amount_minor,null);assert.equal(await release.isOpen(db),true,'A comparison cannot create a spurious unknown-provider cost warning');
   const originalGrant=await store.get(db,owner.workspaceId,connected.id,'provider'),configuration=connected.config;
   await db.query("UPDATE workspace_connectors SET config='{}' WHERE id=$1",[connected.id]);
   assert.equal(await release.isOpen(db),false,'An inventory allowlist alone cannot certify an arbitrary accounting connection');
   await db.query('UPDATE workspace_connectors SET config=$2 WHERE id=$1',[connected.id,JSON.stringify(configuration)]);
   assert.equal(await release.isOpen(db),true);
   const reconnect=await service.beginAuthorization(db,ctx,{providerType:provider,connectorId:connected.id},'https://app.example.test');
   const savedAllowlist=process.env[envKey];revokeOnVerification=true;
   await assert.rejects(()=>complete(reconnect),/not included|private connection/);
   assert.deepEqual(await store.get(db,owner.workspaceId,connected.id,'provider'),originalGrant,'Revocation during OAuth must preserve the established grant');
   process.env[envKey]=savedAllowlist;revokeOnVerification=false;
   assert.deepEqual(await snapshot(),before);assert.equal(await release.isOpen(db),true);
  });
  assert(calls>0);
 }finally{global.fetch=oldFetch;process.env={...environment};await db.close();await cluster.stop();}
});
