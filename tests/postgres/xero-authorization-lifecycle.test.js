'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('Xero consent, refresh, disconnect and reconnect preserve billing and unrelated grants on all plans',{timeout:360000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_CONNECTION_PROVIDERS','STOCKCHIEF_STAGING_CONNECTION_WORKSPACES','XERO_CLIENT_ID','XERO_CLIENT_SECRET'],before={};
 for(const key of keys)before[key]=process.env[key];
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'staging',STOCKCHIEF_STAGING_CONNECTION_PROVIDERS:'xero',XERO_CLIENT_ID:'lifecycle-fixture',XERO_CLIENT_SECRET:'lifecycle-fixture-secret'});
 t.after(()=>{for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];});
 const auth=require('../../src/domain/postgres-auth-service'),service=require('../../src/connections/postgres-provider-service'),connections=require('../../src/connections/postgres-service');
 const store=require('../../src/connections/postgres-credential-store'),xero=require('../../src/connections/providers/xero');
 // Native PostgreSQL and application services exercise a controlled Xero wire
 // fixture. Genuine demo-company consent remains a separate operator test.
 t.mock.method(require('../../src/commercial/operations'),'run',async(_db,_workspace,_operation,run)=>run());
 let generation=0,current=null,active=false,deletions=0,failDelete=false,refreshEntered,releaseRefresh,company='',currentEvent=null,connectionEvent=null;
 t.mock.method(global,'fetch',async(value,options={})=>{
  const url=new URL(value);assert(['identity.xero.com','api.xero.com'].includes(url.hostname));
  if(url.pathname==='/connect/token'){
   const input=new URLSearchParams(options.body);
   if(input.get('grant_type')==='refresh_token'){
    assert.equal(input.get('refresh_token'),current.refreshToken);
    if(refreshEntered){refreshEntered();await new Promise(resolve=>{releaseRefresh=resolve;});}
   }
   generation++;
   if(input.get('grant_type')!=='refresh_token'){
    currentEvent='event-'+generation;
    if(!active)connectionEvent=currentEvent;
   }
   current={accessToken:'fixture.'+Buffer.from(JSON.stringify({authentication_event_id:currentEvent})).toString('base64url')+'.signature-'+generation,refreshToken:'refresh-'+generation};active=true;
   return Response.json({access_token:current.accessToken,refresh_token:current.refreshToken,expires_in:1800});
  }
  if(!active||options.headers.authorization!=='Bearer '+current.accessToken)return Response.json({error:'unauthorized'},{status:401});
  if(url.pathname==='/connections')return Response.json([{id:'link-'+company,tenantId:company,tenantType:'ORGANISATION',authEventId:connectionEvent}]);
  if(url.pathname.startsWith('/connections/')){
   deletions++;assert.equal(options.method,'DELETE');assert.equal(url.pathname,'/connections/link-'+company);
   if(failDelete)return Response.json({error:'temporary_failure'},{status:503});
   active=false;return new Response(null,{status:204});
  }
  assert.equal(options.method||'GET','GET');assert.equal(url.pathname,'/api.xro/2.0/Organisation');
  assert.equal(options.headers['xero-tenant-id'],company);
  return Response.json({Organisations:[{OrganisationID:company,Name:'Lifecycle company '+company,BaseCurrency:'USD'}]});
 });
 for(const plan of ['starter','growth','pro'])await t.test(plan,async()=>{
  company='fixture-'+plan;failDelete=false;active=false;currentEvent=null;connectionEvent=null;
  const owner=await auth.createBusiness(db,{name:'Lifecycle Owner',businessName:'Lifecycle '+plan,email:randomUUID()+'@example.test',password:'Lifecycle!'+randomUUID()});
  process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES=owner.workspaceId;
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId,accountId:owner.accountId};
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[randomUUID(),owner.accountId,plan]);
  const mail=randomUUID();await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,provides,config,created_at,updated_at) VALUES($1,$2,$1,'Existing mailbox','gmail','connected','[]','{}',now(),now())",[mail,owner.workspaceId]);
  await store.put(db,owner.workspaceId,mail,'provider',{accessToken:'preserved-mail',refreshToken:'preserved-mail-refresh'});
  const preserved=async()=>({subscriptions:(await db.query('SELECT to_jsonb(s) AS state FROM account_subscriptions s WHERE account_id=$1 ORDER BY id',[owner.accountId])).rows,mail:await store.get(db,owner.workspaceId,mail,'provider')});
  const baseline=await preserved();
  const begin=async(connectorId,extra={})=>service.beginAuthorization(db,ctx,{providerType:'xero',...(connectorId?{connectorId}:{}),...extra},'https://app.example.test');
  const finish=async started=>service.completeOAuth(db,'xero',{state:new URL(started.redirectUrl).searchParams.get('state'),code:'fixture-'+randomUUID()},'https://app.example.test');
  let linked=await finish(await begin());const id=linked.id,first=await store.get(db,owner.workspaceId,id,'provider');
  assert.equal(linked.status,'connected');assert.equal(first.xeroConnectionId,'link-'+company);assert.deepEqual(await preserved(),baseline);
  assert(!linked.capabilities.includes('accounting:post'));
  const pending=await begin(id,{xeroTenantId:'caller-must-not-select-a-different-company',...(plan==='pro'?{requestedAuthority:'POST'}:{})});
  const pinned=await service.readState(db,new URL(pending.redirectUrl).searchParams.get('state'),'xero');
  assert.equal(pinned.metadata.xeroTenantId,company,'Reconnect company comes from the persisted connector, never caller input');
  await store.put(db,owner.workspaceId,id,'provider',{...first,expiresAt:new Date(0).toISOString()});
  let entered;const waiting=new Promise(resolve=>{entered=resolve;});refreshEntered=entered;
  const refreshing=service.loadProviderCredentials(db,linked,xero);await waiting;
  const beforeDelete=deletions;
  await assert.rejects(connections.disconnect(db,owner.workspaceId,id),error=>error.code==='XERO_AUTHORIZATION_BUSY');
  await assert.rejects(finish(pending),error=>error.code==='XERO_AUTHORIZATION_BUSY');assert.equal(deletions,beforeDelete);
  releaseRefresh();refreshEntered=null;const rotated=await refreshing;
  assert.notEqual(rotated.refreshToken,first.refreshToken);
  linked=await finish(pending);assert.equal(linked.id,id,'Busy consent did not consume the pending OAuth state');
  assert.notEqual(currentEvent,connectionEvent,'Re-consent fixture retains the original Xero connection event');
  assert.equal(linked.capabilities.includes('accounting:post'),plan==='pro');
  assert.deepEqual(await preserved(),baseline);
  const changed=await begin(id),beforeChanged=current.refreshToken;
  await db.query('UPDATE workspace_connectors SET provider_account_id=$2 WHERE id=$1',[id,'changed-during-consent']);
  await assert.rejects(finish(changed),/connection changed while authorization was open/);
  assert.equal(current.refreshToken,beforeChanged,'Changed company is refused before consuming a provider code');
  assert.equal((await store.get(db,owner.workspaceId,id,'provider')).refreshToken,beforeChanged);
  await db.query('UPDATE workspace_connectors SET provider_account_id=$2 WHERE id=$1',[id,company]);
  const refreshed=await store.get(db,owner.workspaceId,id,'provider');
  await store.put(db,owner.workspaceId,id,'provider',{...refreshed,expiresAt:new Date(0).toISOString()});
  let removed=await connections.disconnect(db,owner.workspaceId,id);
  assert.equal(removed.status,'disconnected');assert.equal(removed.providerAuthorizationRevoked,true);assert.equal(deletions,beforeDelete+1);
  assert.equal(await store.get(db,owner.workspaceId,id,'provider'),null);
  await assert.rejects(xero.verifyReadOnly({credentials:current?{...current,tenantId:company}:rotated}),error=>error.status===401);
  assert.deepEqual(await preserved(),baseline);
  linked=await finish(await begin(id));assert.equal(linked.id,id);assert.equal(linked.status,'connected');
  failDelete=true;const attempts=deletions;removed=await connections.disconnect(db,owner.workspaceId,id);
  assert.equal(deletions,attempts+1);assert.equal(removed.providerAuthorizationRevoked,false);assert.equal(await store.get(db,owner.workspaceId,id,'provider'),null);
  assert.deepEqual(await preserved(),baseline);
  failDelete=false;linked=await finish(await begin(id));const sharedGrant=await store.get(db,owner.workspaceId,id,'provider'),shared=randomUUID();
  await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,provides,config,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Other authorized Xero link','xero','connected','[]','{}',$3,now(),now())",[shared,owner.workspaceId,company]);
  await store.put(db,owner.workspaceId,shared,'provider',sharedGrant);
  const sharedBefore=await store.get(db,owner.workspaceId,shared,'provider'),sharedAttempts=deletions;
  removed=await connections.disconnect(db,owner.workspaceId,id);
  assert.equal(removed.providerAuthorizationRevoked,false);assert.equal(deletions,sharedAttempts);
  assert.deepEqual(await store.get(db,owner.workspaceId,shared,'provider'),sharedBefore);
  assert.equal((await xero.verifyReadOnly({credentials:sharedBefore})).externalId,company);assert.deepEqual(await preserved(),baseline);
 });
});
