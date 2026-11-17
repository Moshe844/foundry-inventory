'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),request=require('supertest');
const csrf=html=>html.match(/name="_csrf" value="([^"]+)"/)?.[1],shop='approved-sotre.myshopify.com',secondShop='second-approved.myshopify.com';
test('production Shopify consent keeps native plan capacity, store identity and current pilot authority',{timeout:240000},async t=>{
 const originalEnv={...process.env},originalFetch=global.fetch,cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 process.env.STOCKCHIEF_RUNTIME_ENV='production';process.env.SHOPIFY_CLIENT_ID='production-pilot-fixture';process.env.SHOPIFY_CLIENT_SECRET='production-pilot-secret';
 process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS='{}';delete process.env.SHOPIFY_ACCESS_SCOPES_BY_SHOP;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID(),connectionPublicOrigin:'https://app.stockchiefhq.com'});
 t.after(async()=>{global.fetch=originalFetch;process.env={...originalEnv};await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 const auth=require('../../src/domain/postgres-auth-service'),ent=require('../../src/commercial/entitlements');
 let calls=0,revokedInFlight=false,demoteActorId=null;
 const scopes=['read_orders','read_products','read_locations','read_inventory','read_fulfillments','write_products','write_inventory'];
 global.fetch=async(value,options)=>{
  const url=new URL(value);assert([shop,secondShop].includes(url.hostname),'Never contact an actual Shopify store');calls++;
  if(url.pathname==='/admin/oauth/access_token'){
   if(revokedInFlight)process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS='{}';
   if(demoteActorId)await db.query("UPDATE users SET role='staff',access_revision=access_revision+1 WHERE id=$1",[demoteActorId]);
   return Response.json({access_token:'fixture-token-'+calls,scope:scopes.join(',')});
  }
  assert.equal(options.method,'POST');const body=JSON.parse(options.body);
  if(body.query.includes('StockChiefWebhooks'))return Response.json({data:{webhookSubscriptions:{nodes:[]}}});
  if(body.query.includes('AddWebhook')){assert.match(body.variables.input.uri,/^https:\/\/app\.stockchiefhq\.com\/api\/v1\/connections\/shopify\/webhooks\//);return Response.json({data:{webhookSubscriptionCreate:{userErrors:[],webhookSubscription:{id:'gid://shopify/WebhookSubscription/'+calls}}}});}
  throw Error('Unexpected Shopify fixture request');
 };
 async function business(plan,name){
  const password='Pilot!'+crypto.randomUUID(),owner=await auth.createBusiness(db,{name:'Pilot owner',businessName:name,email:crypto.randomUUID()+'@example.test',password});
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[crypto.randomUUID(),owner.accountId,plan]);
  const agent=request.agent(app),login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:owner.email,password});return {owner,agent,password,ctx:{workspaceId:owner.workspaceId,actorId:owner.userId}};
 }
 async function start(f,store=shop,extra={}){const page=await f.agent.get('/settings/connections');return f.agent.post('/settings/connections/shopify/authorize').set('Accept','application/json').type('form').send({_csrf:csrf(page.text),shop:store,...extra});}
 function callback(location){const input=new URL(location),query={shop:input.hostname,state:input.searchParams.get('state'),code:'fixture-code'};return {...query,hmac:crypto.createHmac('sha256',process.env.SHOPIFY_CLIENT_SECRET).update(Object.keys(query).sort().map(k=>k+'='+query[k]).join('&')).digest('hex')};}
 async function complete(f,location){return f.agent.get('/settings/connections/shopify/callback').query(callback(location));}
 async function fillers(f,count,tag){if(!count)return;await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,setup_status,expected_interval_minutes,created_at,updated_at)
  SELECT $1||n::text,$2,$3||n::text,'Capacity fixture','square','connected','[]','[]','{}','CONNECTED',5,$4,$4 FROM generate_series(1,$5) n`,[f.owner.workspaceId+tag,f.owner.workspaceId,tag,new Date().toISOString(),count]);}
 for(const plan of ['starter','growth','pro'])await t.test(plan,async()=>{
  const f=await business(plan,'Shopify '+plan+' pilot'),map=JSON.stringify({[f.owner.workspaceId]:[shop,secondShop]});process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=map;
  const page=await f.agent.get('/settings/connections');assert.equal(page.status,200);assert.match(page.text,/Private pilot/);assert.match(page.text,/Connect Shopify/);
  const before=calls;assert.equal((await start(f,'approved-store.myshopify.com')).status,400);assert.equal(calls,before);assert.equal(Number((await db.query('SELECT count(*) n FROM connection_authorization_states WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n),0);
  const begun=await start(f);assert.equal(begun.status,303);assert.equal(new URL(begun.headers.location).searchParams.get('redirect_uri'),'https://app.stockchiefhq.com/settings/connections/shopify/callback');
  const finished=await complete(f,begun.headers.location);assert.equal(finished.status,303,finished.text);assert.match(finished.headers.location,/\/complete$/);
  const connection=(await db.query("SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='shopify'",[f.owner.workspaceId])).rows[0];assert.equal(connection.provider_account_id,shop);assert.equal(connection.status,'connected');assert(connection.credential_ref);
  assert.equal(Number((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n),0);
  const scope={accountId:f.owner.accountId,workspaceId:f.owner.workspaceId},state=await ent.meterState(db,scope,'connections');assert(Number.isSafeInteger(state.hardLimit)&&state.hardLimit>1&&state.hardLimit<=100);
  await fillers(f,state.hardLimit-state.used-1,'before-race');
  const pending=await start(f,secondShop);assert.equal(pending.status,303);await fillers(f,1,'last-slot');
  const denied=await complete(f,pending.headers.location);assert.equal(denied.status,400);assert.equal((await ent.meterState(db,scope,'connections')).used,state.hardLimit);
  assert.equal(Number((await db.query("SELECT count(*) n FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='shopify'",[f.owner.workspaceId])).rows[0].n),1);
  const stateCount=Number((await db.query('SELECT count(*) n FROM connection_authorization_states WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n);assert.equal((await start(f,secondShop)).status,402);assert.equal(Number((await db.query('SELECT count(*) n FROM connection_authorization_states WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n),stateCount);
  const reconnect=await start(f,shop,{connectorId:connection.id});assert.equal(reconnect.status,303);assert.equal((await complete(f,reconnect.headers.location)).status,303);assert.equal((await ent.meterState(db,scope,'connections')).used,state.hardLimit);
  const credentialBefore=await require('../../src/connections/postgres-credential-store').get(db,f.owner.workspaceId,connection.id,'provider');
  const inFlight=await start(f,shop,{connectorId:connection.id});assert.equal(inFlight.status,303);revokedInFlight=true;const revoked=await complete(f,inFlight.headers.location);revokedInFlight=false;assert.equal(revoked.status,400);assert.deepEqual(await require('../../src/connections/postgres-credential-store').get(db,f.owner.workspaceId,connection.id,'provider'),credentialBefore);
  process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=map;
  const losingOwner=await start(f,shop,{connectorId:connection.id});assert.equal(losingOwner.status,303);demoteActorId=f.owner.userId;const ownerDenied=await complete(f,losingOwner.headers.location);demoteActorId=null;assert.equal(ownerDenied.status,400);assert.match(ownerDenied.text,/no longer has permission/);assert.deepEqual(await require('../../src/connections/postgres-credential-store').get(db,f.owner.workspaceId,connection.id,'provider'),credentialBefore);await db.query("UPDATE users SET role='owner',access_revision=access_revision+1 WHERE id=$1",[f.owner.userId]);
  const foreign=await business(plan,'Unapproved '+plan),foreignCalls=calls;assert.equal((await start(foreign)).status,400);assert.equal(calls,foreignCalls);
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,'Restricted teammate','staff',$4)",[crypto.randomUUID(),f.owner.workspaceId,foreign.owner.accountId,new Date().toISOString()]);await db.query('UPDATE accounts SET last_workspace_id=$2 WHERE id=$1',[foreign.owner.accountId,f.owner.workspaceId]);
  const staff=request.agent(app),login=await staff.get('/login');await staff.post('/login').type('form').send({_csrf:csrf(login.text),email:foreign.owner.email,password:foreign.password});const staffPage=await staff.get('/'),staffCalls=calls;assert.equal(staffPage.status,200);assert(csrf(staffPage.text));const staffDenied=await staff.post('/settings/connections/shopify/authorize').set('Accept','application/json').type('form').send({_csrf:csrf(staffPage.text),shop});assert.equal(staffDenied.status,403);assert.match(staffDenied.text,/owner/i);assert.equal(calls,staffCalls);
  assert.equal(Number((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n),0);
 });
});
