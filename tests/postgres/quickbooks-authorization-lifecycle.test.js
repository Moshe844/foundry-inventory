'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('isolated QuickBooks consent, refresh, revocation and fresh consent preserve subscriptions and unrelated grants',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_CONNECTION_PROVIDERS','STOCKCHIEF_STAGING_CONNECTION_WORKSPACES','QUICKBOOKS_CLIENT_ID','QUICKBOOKS_CLIENT_SECRET','QUICKBOOKS_ENVIRONMENT'],before={};
 for(const key of keys)before[key]=process.env[key];
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'staging',STOCKCHIEF_STAGING_CONNECTION_PROVIDERS:'quickbooks',QUICKBOOKS_CLIENT_ID:'lifecycle-fixture',QUICKBOOKS_CLIENT_SECRET:'lifecycle-fixture-secret',QUICKBOOKS_ENVIRONMENT:'sandbox'});
 t.after(()=>{for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];});
 const auth=require('../../src/domain/postgres-auth-service'),service=require('../../src/connections/postgres-provider-service'),connections=require('../../src/connections/postgres-service');
 const store=require('../../src/connections/postgres-credential-store'),qbo=require('../../src/connections/providers/quickbooks');
 const owner=await auth.createBusiness(db,{name:'Lifecycle Owner',businessName:'Lifecycle fixture',email:randomUUID()+'@example.test',password:'Lifecycle!'+randomUUID()});
 process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES=owner.workspaceId;
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId,accountId:owner.accountId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,'pro',(SELECT id FROM commercial_plan_versions WHERE plan_id='pro' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[randomUUID(),owner.accountId]);
 const mail=randomUUID();await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,provides,config,created_at,updated_at) VALUES($1,$2,$1,'Existing mailbox','gmail','connected','[]','{}',now(),now())",[mail,owner.workspaceId]);
 await store.put(db,owner.workspaceId,mail,'provider',{accessToken:'preserved-mail',refreshToken:'preserved-mail-refresh'});
 const preserved=async()=>({subscriptions:(await db.query('SELECT to_jsonb(s) AS state FROM account_subscriptions s WHERE account_id=$1 ORDER BY id',[owner.accountId])).rows,mail:await store.get(db,owner.workspaceId,mail,'provider')});
 const baseline=await preserved();
 // The real application service and PostgreSQL store run against a strictly
 // isolated Intuit wire fixture. This is not a claim of genuine sandbox consent.
 t.mock.method(require('../../src/commercial/operations'),'run',async(_db,_workspace,_operation,run)=>run());
 let generation=0,current=null,active=false,revocations=0,failRevocation=false,refreshEntered,releaseRefresh;
 t.mock.method(global,'fetch',async(value,options={})=>{
  const url=new URL(value);assert(['oauth.platform.intuit.com','sandbox-quickbooks.api.intuit.com','developer.api.intuit.com'].includes(url.hostname));
  if(url.pathname.endsWith('/tokens/bearer')){
   const input=new URLSearchParams(options.body);
   if(input.get('grant_type')==='refresh_token'){
    assert.equal(input.get('refresh_token'),current.refreshToken);
    if(refreshEntered){refreshEntered();await new Promise(resolve=>{releaseRefresh=resolve;});}
   }
   current={accessToken:'access-'+(++generation),refreshToken:'refresh-'+generation};active=true;
   return Response.json({access_token:current.accessToken,refresh_token:current.refreshToken,expires_in:3600});
  }
  if(url.pathname==='/v2/oauth2/tokens/revoke'){
   revocations++;assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).token,current.refreshToken);
   if(failRevocation)return Response.json({error:'temporary_failure'},{status:503});
   active=false;return Response.json({});
  }
  assert.equal(options.method||'GET','GET');
  if(!active||options.headers.authorization!=='Bearer '+current.accessToken)return Response.json({Fault:{type:'AuthenticationFault',Error:[{code:'120'}]}},{status:401});
  assert.match(url.pathname,/\/companyinfo\//);return Response.json({CompanyInfo:{Id:'1',CompanyName:'Lifecycle company'}});
 });
 const connect=async connectorId=>{
  const started=await service.beginAuthorization(db,ctx,{providerType:'quickbooks',...(connectorId?{connectorId}:{})},'https://app.example.test');
  return service.completeOAuth(db,'quickbooks',{state:new URL(started.redirectUrl).searchParams.get('state'),code:'fixture-code-'+randomUUID(),realmId:'fixture-realm'},'https://app.example.test');
 };
 let linked=await connect();const id=linked.id,first=await store.get(db,owner.workspaceId,id,'provider');
 assert.equal(linked.status,'connected');assert.deepEqual(await preserved(),baseline);
 await store.put(db,owner.workspaceId,id,'provider',{...first,expiresAt:new Date(Date.now()-60000).toISOString()});
 let entered;const waiting=new Promise(resolve=>{entered=resolve;});refreshEntered=entered;
 const refreshing=service.loadProviderCredentials(db,linked,qbo);await waiting;
 await assert.rejects(connections.disconnect(db,owner.workspaceId,id),error=>error.code==='QUICKBOOKS_AUTHORIZATION_BUSY');
 assert.equal(revocations,0);releaseRefresh();refreshEntered=null;
 const rotated=await refreshing;assert.notEqual(rotated.refreshToken,first.refreshToken);
 let removed=await connections.disconnect(db,owner.workspaceId,id);
 assert.equal(removed.status,'disconnected');assert.equal(removed.providerAuthorizationRevoked,true);assert.equal(revocations,1);
 assert.equal(await store.get(db,owner.workspaceId,id,'provider'),null);
 await assert.rejects(qbo.verifyReadOnly({credentials:rotated}),error=>error.status===401);
 assert.deepEqual(await preserved(),baseline);
 linked=await connect(id);const renewed=await store.get(db,owner.workspaceId,id,'provider');
 assert.equal(linked.id,id);assert.equal(linked.status,'connected');assert.notEqual(renewed.refreshToken,rotated.refreshToken);
 assert.equal((await qbo.verifyReadOnly({credentials:renewed})).externalId,'fixture-realm');
 failRevocation=true;const attempts=revocations;removed=await connections.disconnect(db,owner.workspaceId,id);
 assert.equal(revocations,attempts+1);assert.equal(removed.status,'disconnected');assert.equal(removed.providerAuthorizationRevoked,false);
 assert.equal(await store.get(db,owner.workspaceId,id,'provider'),null);assert.deepEqual(await preserved(),baseline);
 failRevocation=false;linked=await connect(id);const sharedGrant=await store.get(db,owner.workspaceId,id,'provider');
 const other=await auth.createBusiness(db,{name:'Other Owner',businessName:'Other authorized business',email:randomUUID()+'@example.test',password:'Other!'+randomUUID()}),shared=randomUUID();
 await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,provides,config,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Other connection','quickbooks','connected','[]','{}','fixture-realm',now(),now())",[shared,other.workspaceId]);
 await store.put(db,other.workspaceId,shared,'provider',sharedGrant);
 const otherBefore=(await db.query('SELECT to_jsonb(c) AS state FROM workspace_connectors c WHERE id=$1',[shared])).rows;
 const sharedAttempts=revocations;removed=await connections.disconnect(db,owner.workspaceId,id);
 assert.equal(removed.status,'disconnected');assert.equal(removed.providerAuthorizationRevoked,false);assert.equal(revocations,sharedAttempts,'Removing one local link must not revoke another active connection');
 assert.deepEqual((await db.query('SELECT to_jsonb(c) AS state FROM workspace_connectors c WHERE id=$1',[shared])).rows,otherBefore);
 assert.deepEqual(await store.get(db,other.workspaceId,shared,'provider'),sharedGrant);
 assert.equal((await qbo.verifyReadOnly({credentials:sharedGrant})).externalId,'fixture-realm');assert.deepEqual(await preserved(),baseline);
});
