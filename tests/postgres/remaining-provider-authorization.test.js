'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('Clover, Xero and QuickBooks consent and refresh preserve billing and isolate every supported plan',{timeout:360000},async t=>{
 const environment={...process.env},oldFetch=global.fetch;
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 try{
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'staging',STOCKCHIEF_STAGING_CONNECTION_PROVIDERS:'clover,xero,quickbooks',
   CLOVER_CLIENT_ID:'offline-clover',CLOVER_CLIENT_SECRET:'offline-clover-secret',CLOVER_WEBHOOK_AUTH_CODE:'offline-webhook',CLOVER_ENVIRONMENT:'sandbox',
   QUICKBOOKS_CLIENT_ID:'offline-qb',QUICKBOOKS_CLIENT_SECRET:'offline-qb-secret',QUICKBOOKS_ENVIRONMENT:'sandbox',XERO_CLIENT_ID:'offline-xero',XERO_CLIENT_SECRET:'offline-xero-secret'});
  const auth=require('../../src/domain/postgres-auth-service'),service=require('../../src/connections/postgres-provider-service');
  const registry=require('../../src/connections/providers/registry'),store=require('../../src/connections/postgres-credential-store');
  let incomplete=false,externalCalls=0;
  global.fetch=async(value,options={})=>{
   externalCalls++;const url=new URL(value);
   assert(['apisandbox.dev.clover.com','oauth.platform.intuit.com','sandbox-quickbooks.api.intuit.com','identity.xero.com','api.xero.com'].includes(url.hostname),'Only isolated provider fixtures may be contacted');
   if(url.pathname.endsWith('/token')||url.pathname.endsWith('/refresh')||url.pathname.endsWith('/tokens/bearer')){
    if(incomplete)return Response.json({access_token:'incomplete-fixture'});
    return Response.json({access_token:'offline-access',refresh_token:'offline-refresh',expires_in:1800,
     access_token_expiration:Math.floor(Date.now()/1000)+1800,refresh_token_expiration:Math.floor(Date.now()/1000)+86400});
   }
   if(url.hostname==='apisandbox.dev.clover.com')return Response.json({id:'offline-merchant',name:'Offline Clover merchant'});
   if(url.hostname==='sandbox-quickbooks.api.intuit.com')return Response.json({CompanyInfo:{Id:'1',CompanyName:'Offline QuickBooks company'}});
   if(url.pathname==='/connections')return Response.json([{tenantId:'offline-tenant',tenantType:'ORGANISATION'}]);
   if(url.pathname.endsWith('/Organisation'))return Response.json({Organisations:[{OrganisationID:'offline-tenant',Name:'Offline Xero organization'}]});
   throw Error('Unexpected isolated provider request');
  };
  for(const plan of ['starter','growth','pro'])for(const type of ['clover','xero','quickbooks'])await t.test(plan+' / '+type,async()=>{
   incomplete=false;
   const owner=await auth.createBusiness(db,{name:'Connection Owner',businessName:plan+' '+type,email:randomUUID()+'@example.test',password:'Connection!'+randomUUID()});
   await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[randomUUID(),owner.accountId,plan]);
   process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES=owner.workspaceId;
   const ctx={workspaceId:owner.workspaceId,actorId:owner.userId,accountId:owner.accountId};
   const before=(await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.accountId])).rows;
   const capability=await require('../../src/commercial/entitlements').capabilityState(db,{accountId:owner.accountId,workspaceId:owner.workspaceId},type==='clover'?'connection.commerce':'connection.accounting');
   if(!capability.enabled){
    const calls=externalCalls;
    await assert.rejects(()=>service.beginAuthorization(db,ctx,{providerType:type},'https://app.example.test'),error=>error.code==='entitlement_required');
    assert.equal(externalCalls,calls,'A plan restriction must be enforced before provider traffic');
    assert.equal((await db.query('SELECT 1 FROM workspace_connectors WHERE workspace_id=$1',[owner.workspaceId])).rowCount,0);
    assert.deepEqual((await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.accountId])).rows,before);
    return;
   }
   const started=await service.beginAuthorization(db,ctx,{providerType:type},'https://app.example.test');
   const state=new URL(started.redirectUrl).searchParams.get('state');assert(state);
   assert.equal((await db.query('SELECT 1 FROM workspace_connectors WHERE workspace_id=$1',[owner.workspaceId])).rowCount,0,'Starting consent creates no connector');
   const connected=await service.completeOAuth(db,type,{state,code:'offline-code',realmId:'offline-company',merchant_id:'offline-merchant'},'https://app.example.test');
   assert.equal(connected.workspace_id,owner.workspaceId);assert.equal(connected.provider_type,type);assert.equal(connected.status,'connected');
   const saved=await store.get(db,owner.workspaceId,connected.id,'provider');assert.equal(saved.accessToken,'offline-access');
   if(type==='xero')assert(!connected.capabilities.includes('accounting:post'),'Initial Xero consent remains read-only');
   assert.deepEqual((await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.accountId])).rows,before,'Connecting business software must not change its StockChief subscription');
   const other=await db.query('SELECT 1 FROM connection_credentials WHERE workspace_id<>$1 AND connector_id=$2',[owner.workspaceId,connected.id]);assert.equal(other.rowCount,0);
   const expired={...saved,expiresAt:new Date(Date.now()-60000).toISOString(),accessTokenExpiration:Math.floor(Date.now()/1000)-60};
   await store.put(db,owner.workspaceId,connected.id,'provider',expired);
   if(type==='xero'){
    const network=require('../../src/commercial/network'),context={database:db,scope:{accountId:owner.accountId,workspaceId:owner.workspaceId}};
    for(const url of ['https://api.xero.com/api.xro/2.0/ManualJournals','https://identity.xero.com/connect/token/not-token'])
     await assert.rejects(()=>network.before(context,url,{method:'POST'},'Xero'),/registered business operation/,'The token exception must not authorize accounting writes or neighboring routes');
   }
   incomplete=true;
   await assert.rejects(()=>service.loadProviderCredentials(db,connected,registry.get(type)),error=>error.code==='PROVIDER_REFRESH_UNCONFIRMED');
   assert.deepEqual(await store.get(db,owner.workspaceId,connected.id,'provider'),expired,'Malformed provider success must preserve the complete encrypted grant');
   const current=(await db.query('SELECT status,setup_status FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,connected.id])).rows[0];
   assert.equal(current.status,'connected');assert.notEqual(current.setup_status,'REAUTHORIZATION_REQUIRED','A partial provider response must not demand a new login');
   assert.deepEqual((await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.accountId])).rows,before);
  });
  assert(externalCalls>0);
 }finally{global.fetch=oldFetch;process.env={...environment};await db.close();await cluster.stop();}
});
