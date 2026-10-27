'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
test('abandoned consent never saves or counts a connection; successful callbacks preserve grants and enforce capacity',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Consent lifecycle',email:crypto.randomUUID()+'@example.test',password:'Test!'+crypto.randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES('consent-subscription',$1,'growth','COMP','CUSTOM','ISOLATED_TEST')",[owner.accountId]);
 const service=require('../../src/connections/postgres-provider-service'),connections=require('../../src/connections/postgres-service'),entitlements=require('../../src/entitlements/postgres-service'),intents=require('../../src/connections/authorization-intent');
 const scope=await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId),count=async()=>Number((await entitlements.meterState(db,scope,'connections')).capacityUsed);
 const adapter={metadata:()=>({name:'Consent fixture',available:true,provides:['products']}),authorizationUrl:({state})=>({url:'https://consent.example.test/?state='+state}),exchangeAuthorization:async({query})=>{if(query.error)throw Error('Not approved');return {accountId:query.code,accountName:'Test store',capabilities:['catalog:read'],credentials:{accessToken:'fixture-grant'}};}},providers={get:()=>adapter};
 const begin=async input=>{const r=await service.beginAuthorization(db,ctx,{providerType:'square',popup:'1',...input},'https://stockchief.example.test',{providers});return new URL(r.redirectUrl).searchParams.get('state');};
 await t.test('nine closes consume zero slots, create no connector and expire after thirty minutes',async()=>{
  const before=await count();for(let i=0;i<9;i++)await begin();assert.equal(await count(),before);assert.equal((await connections.list(db,ctx.workspaceId)).length,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  const states=(await db.query('SELECT * FROM connection_authorization_states WHERE workspace_id=$1',[ctx.workspaceId])).rows;assert.equal(states.length,9);
  for(const row of states){assert.equal(row.connector_id,null);assert.equal(Date.parse(row.expires_at)-Date.parse(row.created_at),intents.TTL_MS);}
  const value=await begin();await db.query("UPDATE connection_authorization_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1",[service.stateHash(value)]);await assert.rejects(service.readState(db,value,'square'),/expired/);
 });
 let saved;
 await t.test('callback creates exactly one real connection and duplicate store consent reuses it',async()=>{
  const state=await begin();saved=await service.completeOAuth(db,'square',{state,code:'same-store'},'https://stockchief.example.test',{providers});assert.equal(await count(),1);assert(saved.first_connected_at);
  const again=await service.completeOAuth(db,'square',{state:await begin(),code:'same-store'},'https://stockchief.example.test',{providers});assert.equal(again.id,saved.id);assert.equal((await connections.list(db,ctx.workspaceId)).length,1);
  await assert.rejects(service.completeOAuth(db,'square',{state,code:'same-store'},'https://stockchief.example.test',{providers}),/already used/);
 });
 await t.test('closing or declining reconnect preserves the existing connection and credentials',async()=>{
  const before=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[saved.id])).rows[0];await begin({connectorId:saved.id});assert.deepEqual((await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[saved.id])).rows[0],before);
  await assert.rejects(service.completeOAuth(db,'square',{state:await begin({connectorId:saved.id}),error:'access_denied'},'https://stockchief.example.test',{providers}),/Not approved/);
  assert.deepEqual((await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[saved.id])).rows[0],before);assert.equal((await require('../../src/connections/postgres-credential-store').get(db,ctx.workspaceId,saved.id,'provider')).accessToken,'fixture-grant');
 });
 await t.test('callback rechecks the current limit and never persists a refused grant',async()=>{
  const state=await begin();await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason,source) VALUES('consent-cap',$1,'connections',1,'Consent regression','ISOLATED_TEST')",[owner.accountId]);
  await assert.rejects(service.completeOAuth(db,'square',{state,code:'another-store'},'https://stockchief.example.test',{providers}),/plan limit/);
  assert.equal(await count(),1);assert.equal((await connections.list(db,ctx.workspaceId)).length,1);assert.equal((await db.query('SELECT count(*)::int n FROM connection_credentials WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
 });
 await t.test('real disconnected history is retained without consuming capacity',async()=>{await connections.disconnect(db,ctx.workspaceId,saved.id);assert.equal(await count(),0);const history=await connections.list(db,ctx.workspaceId);assert.equal(history.length,1);assert.equal(history[0].id,saved.id);assert(history[0].first_connected_at);});
 await t.test('two successful provider grants compete atomically for the last slot',async()=>{
  const [a,b]=await Promise.all([begin(),begin()]);
  const results=await Promise.allSettled([service.completeOAuth(db,'square',{state:a,code:'race-a'},'https://stockchief.example.test',{providers}),service.completeOAuth(db,'square',{state:b,code:'race-b'},'https://stockchief.example.test',{providers})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/plan limit/);assert.equal(await count(),1);
  assert.equal((await db.query('SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,2,'One established connection and one preserved disconnected history row');
 });
});
