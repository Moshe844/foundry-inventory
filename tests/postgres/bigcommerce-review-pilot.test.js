'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('BigCommerce private store admission preserves all three plans, existing grants and checkout',{timeout:600000},async t=>{
 const previous={...process.env},cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();for(const k of Object.keys(process.env))if(!(k in previous))delete process.env[k];Object.assign(process.env,previous);});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',BIGCOMMERCE_CLIENT_ID:'fixture-client',BIGCOMMERCE_CLIENT_SECRET:'fixture-secret',
  STOCKCHIEF_CHECKOUT_ENABLED:'true',STOCKCHIEF_BILLING_AUTOMATIC_TAX:'false',STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID:'acct_1UBFTdIjKuQgOJD6'});
 await db.query("UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true");
 await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
 const auth=require('../../src/domain/postgres-auth-service'),service=require('../../src/connections/postgres-provider-service'),intents=require('../../src/connections/authorization-intent');
 const vault=require('../../src/connections/postgres-credential-store'),release=require('../../src/commercial/release'),permits={appId:'fixture-client',stores:{}};
 t.mock.method(global,'fetch',async(url,init={})=>{
  const target=new URL(url);
  if(target.origin==='https://login.bigcommerce.com'&&target.pathname==='/oauth2/token'){
   const body=JSON.parse(init.body);assert.equal(body.client_id,'fixture-client');
   return Response.json({access_token:'fixture-grant',context:body.context,scope:body.scope,user:{id:7}});
  }
  assert.equal(target.origin,'https://api.bigcommerce.com','No real provider or payment requests');
  if(/\/v2\/store$/.test(target.pathname))return Response.json({name:'Owned fixture store',currency:'USD'});
  assert.match(target.pathname,/\/v3\/hooks$/);return Response.json({data:init.method==='POST'?{id:1}:[]});
 });
 for(const [index,plan] of ['starter','growth','pro'].entries())await t.test(plan,async()=>{
  const owner=await auth.createBusiness(db,{name:'Test owner',businessName:'BigCommerce '+plan,email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
  await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end)
   VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')`,[randomUUID(),owner.accountId,plan]);
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId,accountId:owner.accountId},storeHash='fixture'+index;
  permits.stores[owner.workspaceId]=[storeHash];process.env.STOCKCHIEF_PRODUCTION_BIGCOMMERCE_PILOTS=JSON.stringify(permits);
  const existingId='preserved-'+randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,created_at,updated_at)
   VALUES($1,$2,$1,'Existing Gmail','gmail','[]','{}','connected',now(),now())`,[existingId,ctx.workspaceId]);
  await vault.put(db,ctx.workspaceId,existingId,'provider',{accessToken:'preserved-access',refreshToken:'preserved-refresh'});
  const snapshot=async()=>({subscriptions:(await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.accountId])).rows,
   grant:await vault.get(db,ctx.workspaceId,existingId,'provider'),stock:(await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows});
  const before=await snapshot();assert.equal(await release.isOpen(db),true);
  await assert.rejects(service.beginAuthorization(db,ctx,{providerType:'bigcommerce',storeUrl:'https://store-foreign.mybigcommerce.com'},'https://app.example.test'),/assigned/);
  const started=await service.beginAuthorization(db,ctx,{providerType:'bigcommerce',storeUrl:`https://store-${storeHash}.mybigcommerce.com`},'https://app.example.test');
  const state=await service.readState(db,started.authorizationState,'bigcommerce'),connection=await intents.connectionForState(db,state);
  assert.equal(state.metadata.storeHash,storeHash);
  const result={accountId:storeHash,accountName:'Owned fixture store',credentials:{storeHash,bigcommerceClientId:'fixture-client',accessToken:'fixture-grant',storeUrl:`https://store-${storeHash}.mybigcommerce.com`},capabilities:['store_v2_products','store_inventory','store_v2_orders_read_only','store_v2_information_read_only']};
  const connected=await service.completeOAuth(db,'bigcommerce',{state:started.authorizationState,code:'fixture-code',context:'stores/'+storeHash,scope:state.metadata.requestedScopes.join(' ')},'https://app.example.test');
  const id=connected.id;
  assert.deepEqual(await snapshot(),before);assert.equal(await release.isOpen(db),true,'Qualified private store must preserve subscription checkout');
  const saved=await require('../../src/connections/postgres-service').get(db,ctx.workspaceId,id);
  assert.equal(saved.config.bigcommerceTestEvidence.storeHash,storeHash);assert.equal(saved.config.bigcommerceTestEvidence.approvedByUserId,ctx.actorId);
  const inbox=require('../../src/connections/postgres-webhook-inbox'),event={producer:'stores/'+storeHash,scope:'store/product/updated',hash:'fixture-'+index,created_at:Math.floor(Date.now()/1000),data:{id:43}};
  const receipt=await inbox.receive(db,saved,{headers:{},body:event,rawBody:Buffer.from(JSON.stringify(event))});
  assert.equal((await inbox.processReceipt(db,ctx.workspaceId,receipt.receiptId)).processingStatus,'COMPLETED');
  assert.equal(await release.isOpen(db),true,'Local event and included test-store API costs must preserve checkout');
  const grant=await vault.get(db,ctx.workspaceId,id,'provider');
  await assert.rejects(service.finishAuthorization(db,saved,ctx.actorId,{...result,credentials:{...result.credentials,bigcommerceClientId:'foreign'}},null,{enforceLaunchPolicy:true}),/registered/);
  assert.deepEqual(await vault.get(db,ctx.workspaceId,id,'provider'),grant);
  await db.query("UPDATE workspace_connectors SET config=(config::jsonb #- '{bigcommerceTestEvidence}')::text WHERE id=$1",[id]);
  assert.equal(await release.isOpen(db),false,'An unevidenced store must remain unqualified');
  await db.query('UPDATE workspace_connectors SET config=$2 WHERE id=$1',[id,JSON.stringify(saved.config)]);
  delete permits.stores[ctx.workspaceId];process.env.STOCKCHIEF_PRODUCTION_BIGCOMMERCE_PILOTS=JSON.stringify(permits);
  await assert.rejects(service.finishAuthorization(db,saved,ctx.actorId,result,null,{enforceLaunchPolicy:true}),/certification/);
  assert.deepEqual(await vault.get(db,ctx.workspaceId,id,'provider'),grant);
  permits.stores[ctx.workspaceId]=[storeHash];process.env.STOCKCHIEF_PRODUCTION_BIGCOMMERCE_PILOTS=JSON.stringify(permits);
  await db.query("UPDATE workspace_connectors SET status='disconnected',paused_at=now() WHERE id=$1",[id]);
  const reconnect=await service.beginAuthorization(db,ctx,{providerType:'bigcommerce',connectorId:id,storeUrl:`https://store-${storeHash}.mybigcommerce.com`},'https://app.example.test');
  const nextState=await service.readState(db,reconnect.authorizationState,'bigcommerce');
  const reconnected=await service.finishAuthorization(db,await intents.connectionForState(db,nextState),ctx.actorId,{...result,credentials:{...result.credentials,accessToken:'replacement-grant'}},nextState.id,{enforceLaunchPolicy:true});
  assert.equal(reconnected,id);assert.deepEqual(await snapshot(),before);assert.equal(await release.isOpen(db),true);
 });
});
