'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),request=require('supertest');
const store=require('../../src/connections/postgres-credential-store'),vault=require('../../src/connections/credentials'),inbox=require('../../src/connections/postgres-webhook-inbox'),adapter=require('../../src/connections/providers/shopify');
const life=require('../../src/connections/shopify-token-lifecycle'),install=require('../../src/connections/postgres-shopify-public-install');
const id=()=>crypto.randomUUID(),iso=offset=>new Date(Date.now()+offset).toISOString();

test('Shopify uninstall revokes only its app/store before refresh and preserves replacement consent and business history',{timeout:240000},async t=>{
 const env={...process.env},oldFetch=global.fetch;
 Object.assign(process.env,{SHOPIFY_CLIENT_ID:'uninstall-legacy',SHOPIFY_CLIENT_SECRET:'uninstall-legacy-secret',SHOPIFY_PUBLIC_CLIENT_ID:'uninstall-public',SHOPIFY_PUBLIC_CLIENT_SECRET:'uninstall-public-secret',SHOPIFY_PUBLIC_APP_ID:'991',STOCKCHIEF_RUNTIME_ENV:'test'});
 let calls=0,refreshCalls=0;const probes=new Map(),refreshFamilies=new Map();
 global.fetch=async(value,options)=>{
  const url=new URL(value);assert.match(url.hostname,/^[a-z0-9-]+\.myshopify\.com$/,'Synthetic Shopify only');calls++;
  if(url.pathname==='/admin/oauth/access_token'){
   refreshCalls++;const form=new URLSearchParams(options.body),family=refreshFamilies.get(form.get('refresh_token'));
   assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('client_id'),process.env.SHOPIFY_PUBLIC_CLIENT_ID);assert.equal(form.get('client_secret'),process.env.SHOPIFY_PUBLIC_CLIENT_SECRET);
   if(family?.mode==='valid')return Response.json({access_token:family.accessToken,refresh_token:family.refreshToken,expires_in:3600,refresh_token_expires_in:86400});
   if(family?.mode==='invalid_grant')return Response.json({error:'invalid_grant'},{status:400});
   if(family?.mode==='invalid_client')return Response.json({error:'invalid_client'},{status:401});
   if(family?.mode==='network')throw new Error('Synthetic refresh transport failure');
   return Response.json({error:'temporarily_unavailable'},{status:503});
  }
  assert.equal(url.pathname,'/admin/api/2026-07/graphql.json');assert.equal(JSON.parse(options.body).query,adapter.UNINSTALL_IDENTITY_QUERY);
  const probe=probes.get(options.headers['x-shopify-access-token']);
  if(probe?.mode==='network')throw new Error('Synthetic network failure');
  if(probe?.mode==='forbidden')return Response.json({errors:'Forbidden'},{status:403});
  if(probe?.mode==='ip_blocked')return new Response('<html>IP address not permitted</html>',{status:403});
  if(probe?.mode==='unavailable')return Response.json({errors:'Unavailable'},{status:503});
  if(probe?.mode==='unknown_401')return new Response('<html>Unauthorized proxy</html>',{status:401});
  if(probe?.mode==='valid'||probe?.mode==='wrong_identity')return Response.json({data:{shop:{id:'gid://shopify/Shop/91',myshopifyDomain:probe.mode==='valid'?url.hostname:'wrong-store.myshopify.com'},currentAppInstallation:{app:{apiKey:probe.clientId}}}});
  return Response.json({errors:'[API] Invalid API key or access token (unrecognized login or wrong password)'},{status:401});
 };
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 let app;t.after(async()=>{global.fetch=oldFetch;process.env={...env};if(app)await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Owner',businessName:'Uninstall inventory',email:id()+'@example.test',password:'Uninstall!'+id()}),other=await auth.createBusiness(db,{name:'Other',businessName:'Other inventory',email:id()+'@example.test',password:'Other!'+id()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Stock',kind:'warehouse'}),item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Preserved item',baseCode:'UNINSTALL',trackingMode:'quantity'});
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{startDate:iso(-86400000).slice(0,10),currency:'USD'});
 const received=await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:5,reference:'PRESERVE',idempotencyKey:'uninstall-opening'});
 await db.transaction(c=>require('../../src/accounting/postgres-costing').receiveInTransaction(c,ctx,{movementId:received.movementId,unitCostMinor:125,sourceType:'opening_inventory',sourceRecordId:received.movementId}));
 async function connector({shop='uninstall-fixture.myshopify.com',profile='public',identity=owner,authorizedAt=iso(-120000),paused=false,shopifyShopId,expiresAt=iso(3600000)}={}){
  const cid=id(),clientId=profile==='public'?process.env.SHOPIFY_PUBLIC_CLIENT_ID:process.env.SHOPIFY_CLIENT_ID,config={shop,shopifyProfile:profile,shopifyClientId:clientId};
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at,paused_at)
   VALUES($1,$2,$1,'Uninstall fixture','shopify','connected','[]','[]',$3,5,'CONNECTED',$4,$5,$6,$6,$7)`,[cid,identity.workspaceId,JSON.stringify(config),identity.userId,shop,iso(-180000),paused?iso(-10000):null]);
  const grant={shop,shopifyProfile:profile,shopifyClientId:clientId,authorizedAt,...(shopifyShopId?{shopifyShopId}:{}),accessToken:'synthetic-'+cid,refreshToken:'revoked-'+cid,accessTokenExpiresAt:expiresAt,refreshTokenExpiresAt:iso(86400000)};
  await store.put(db,identity.workspaceId,cid,'provider',grant);return {id:cid,workspaceId:identity.workspaceId,shop,profile,clientId,grant};
 }
 const original=await connector(),legacy=await connector({profile:'legacy',identity:other}),another=await connector({shop:'another-fixture.myshopify.com',identity:other});
 app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:id()});
 function signed(f,{delivery=id(),topic='app/uninstalled',triggeredAt=iso(-30000),secret=f.profile==='public'?process.env.SHOPIFY_PUBLIC_CLIENT_SECRET:process.env.SHOPIFY_CLIENT_SECRET,body={id:91,myshopify_domain:f.shop},headerShop=f.shop}={}){
  const rawBody=Buffer.from(JSON.stringify(body));return {body,rawBody,headers:{'content-type':'application/json','x-shopify-topic':topic,'x-shopify-shop-domain':headerShop,'x-shopify-triggered-at':triggeredAt,'x-shopify-webhook-id':delivery,'x-shopify-hmac-sha256':crypto.createHmac('sha256',secret).update(rawBody).digest('base64')}};
 }
 const send=(f,input)=>request(app).post('/api/v1/connections/shopify/webhooks/'+f.id).set(input.headers).send(input.rawBody.toString());
 const row=async f=>(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[f.workspaceId,f.id])).rows[0];
 async function history(){const result={};for(const table of ['balances','movements','accounting_journal_entries','accounting_journal_lines'])result[table]=(await db.query('SELECT * FROM '+table+' WHERE workspace_id=$1 ORDER BY 1',[ctx.workspaceId])).rows;return result;}
 const before=await history();
 await t.test('wrong signatures, app secrets and signed-body store identities cannot revoke another grant',async()=>{
  assert.equal((await send(original,signed(original,{secret:process.env.SHOPIFY_CLIENT_SECRET}))).status,401);
  assert.equal((await send(another,signed(original,{headerShop:another.shop}))).status,401);
  assert.equal((await send(original,signed(original,{triggeredAt:'invalid'}))).status,400);
  assert.equal((await row(original)).status,'connected');assert.equal((await row(another)).status,'connected');
  assert.equal((await db.query('SELECT count(*)::int n FROM connection_webhook_receipts')).rows[0].n,0);
 });
 await t.test('uninstall acknowledges without a paid plan, provider refresh or commerce normalization and permits fresh OAuth',async()=>{
  const sealed=vault.encrypt({credentials:original.grant}),handoff='sinstall_'+crypto.randomBytes(12).toString('hex');
  await db.query(`INSERT INTO shopify_public_installs(id,state_hash,browser_hash,shop,client_id,metadata,status,ciphertext,iv,auth_tag,expires_at,created_at)
   VALUES($1,$2,$3,$4,$5,'{}','AUTHORIZED',$6,$7,$8,now()+interval '1 hour',now()-interval '2 minutes')`,[handoff,id(),id(),original.shop,original.clientId,sealed.ciphertext,sealed.iv,sealed.authTag]);
  const replacement='sinstall_'+crypto.randomBytes(12).toString('hex'),replacementSealed=vault.encrypt({credentials:{...original.grant,authorizedAt:iso(-10000)}});
  await db.query(`INSERT INTO shopify_public_installs(id,state_hash,browser_hash,shop,client_id,metadata,status,ciphertext,iv,auth_tag,expires_at,created_at)
   VALUES($1,$2,$3,$4,$5,'{}','AUTHORIZED',$6,$7,$8,now()+interval '1 hour',now()-interval '2 minutes')`,[replacement,id(),id(),original.shop,original.clientId,replacementSealed.ciphertext,replacementSealed.iv,replacementSealed.authTag]);
  const input=signed(original),response=await send(original,input);assert.equal(response.status,200,response.text);
  const saved=await row(original);assert.equal(saved.status,'disconnected');assert.equal(saved.setup_status,'REAUTHORIZATION_REQUIRED');assert(saved.paused_at);assert.equal(saved.credential_ref,null);
  assert.equal(await store.get(db,original.workspaceId,original.id,'provider'),null);
  assert.equal((await row(legacy)).status,'connected');assert.deepEqual(await store.get(db,legacy.workspaceId,legacy.id,'provider'),legacy.grant);
  assert.equal((await row(another)).status,'connected');assert.deepEqual(await history(),before);
  assert.equal((await db.query('SELECT status,ciphertext FROM shopify_public_installs WHERE id=$1',[handoff])).rows[0].status,'FAILED');
  assert.equal((await db.query('SELECT status FROM shopify_public_installs WHERE id=$1',[replacement])).rows[0].status,'AUTHORIZED','Consent exchanged after the uninstall survives even if its browser started earlier');
  const receipt=(await db.query('SELECT * FROM connection_webhook_receipts WHERE id=$1',[response.body.receiptId])).rows[0];assert.equal(receipt.status,'COMPLETED');assert.equal(receipt.result.revoked,true);
  assert.equal((await send(original,input)).status,200,'Replay is acknowledged after credentials are erased');
  assert.equal((await send(original,signed(original,{secret:'wrong-secret'}))).status,401,'A disconnected connector still checks its original app signature');
  assert.equal((await db.query("SELECT count(*)::int n FROM domain_events WHERE event_type='connection.authorization_revoked' AND source_record_id=$1",[original.id])).rows[0].n,1);
  const query={shop:original.shop,timestamp:String(Math.floor(Date.now()/1000))};query.hmac=crypto.createHmac('sha256',process.env.SHOPIFY_PUBLIC_CLIENT_SECRET).update(Object.keys(query).sort().map(key=>key+'='+query[key]).join('&')).digest('hex');
  const started=await install.begin(db,query,'https://app.stockchiefhq.com');assert.match(started.redirectUrl,/\/admin\/oauth\/authorize\?/);assert.equal(new URL(started.redirectUrl).searchParams.get('client_id'),original.clientId);
  assert.equal(refreshCalls,0);
 });
 await t.test('a paused legacy installation can revoke its own grant without touching the public app',async()=>{
  await db.query('UPDATE workspace_connectors SET paused_at=now() WHERE id=$1',[legacy.id]);
  assert.equal((await send(legacy,signed(legacy))).status,200);assert.equal((await row(legacy)).status,'disconnected');assert.equal(await store.get(db,legacy.workspaceId,legacy.id,'provider'),null);assert.equal((await row(another)).status,'connected');
 });
 await t.test('a delayed uninstall and a retry after lifecycle contention preserve a newer grant',async()=>{
  const f=await connector({shop:'replacement-fixture.myshopify.com',authorizedAt:iso(-10000)}),input=signed(f,{triggeredAt:iso(-30000)}),connection=await row(f);
  probes.set(f.grant.accessToken,{mode:'valid',clientId:f.clientId});
  await db.withSessionLock(life.key(f.clientId,f.shop),async()=>{const blocked=await send(f,input);assert(blocked.status>=400);assert.equal((await row(f)).status,'connected');});
  const response=await send(f,input);assert.equal(response.status,200,response.text);const receipt=(await db.query('SELECT result FROM connection_webhook_receipts WHERE id=$1',[response.body.receiptId])).rows[0];assert.equal(receipt.result.ignored,'current_grant_valid');
  assert.deepEqual(await store.get(db,f.workspaceId,f.id,'provider'),f.grant);assert.equal((await row(f)).status,'connected');assert.deepEqual(await history(),before);assert.equal(connection.provider_account_id,f.shop);
 });
 await t.test('nullable Shop domains require a trusted signed numeric Shop ID and remain replayable',async()=>{
  const f=await connector({shop:'nullable-fixture.myshopify.com',shopifyShopId:'gid://shopify/Shop/91'});
  assert.equal((await send(f,signed(f,{body:{id:92,myshopify_domain:null}}))).status,401);
  const input=signed(f,{body:{id:91,myshopify_domain:null}});assert.equal((await send(f,input)).status,200);assert.equal((await row(f)).status,'disconnected');assert.equal((await send(f,input)).status,200);
  const unknown=await connector({shop:'unknown-id-fixture.myshopify.com'}),rejected=await send(unknown,signed(unknown,{body:{id:91,myshopify_domain:null}}));assert.equal(rejected.status,400);assert.match(rejected.text,/stored.*verified store identity/);assert.deepEqual(await store.get(db,unknown.workspaceId,unknown.id,'provider'),unknown.grant);
 });
 await t.test('an existing server-verified billing Shop ID can bind a nullable-domain uninstall',async()=>{
  const f=await connector({shop:'billing-id-fixture.myshopify.com'});
  await db.query("INSERT INTO commercial_shopify_subscriptions(account_id,app_id,shop_id,shop,app_handle,development_store) VALUES($1,'gid://shopify/App/991','gid://shopify/Shop/91',$2,'uninstall-fixture',true)",[owner.accountId,f.shop]);
  assert.equal((await send(f,signed(f,{body:{id:91,myshopify_domain:null}}))).status,200);assert.equal((await row(f)).status,'disconnected');
 });
 await t.test('an already retained uninstall bypasses refresh even when it reaches the worker',async()=>{
  const f=await connector({shop:'retained-fixture.myshopify.com'}),input=signed(f),sealed=vault.encrypt({headers:input.headers,rawBody:input.rawBody.toString('base64')}),rid=id();
  await db.query(`INSERT INTO connection_webhook_receipts(id,workspace_id,connector_id,delivery_id,payload_hash,ciphertext,iv,auth_tag,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'NEEDS_REVIEW')`,[rid,f.workspaceId,f.id,input.headers['x-shopify-webhook-id'],'verified-predeployment-receipt',sealed.ciphertext,sealed.iv,sealed.authTag]);
  const providers={get(){throw new Error('Uninstall processing does not use a commerce adapter.');}};
  const out=await inbox.processReceipt(db,f.workspaceId,rid,providers);assert.equal(out.revoked,true);assert.equal(out.processingStatus,'COMPLETED');assert.equal((await row(f)).status,'disconnected');
  assert.deepEqual(await inbox.processReceipt(db,f.workspaceId,rid,providers),out);assert.equal(refreshCalls,0);
 });
 await t.test('canonical reconnect preserves only same-app/store verified Shop identity and fresh token metadata',async()=>{
  const identity=await auth.createBusiness(db,{name:'Reconnect owner',businessName:'Reconnect fixture',email:id()+'@example.test',password:'Reconnect!'+id()});
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,source) SELECT $1,$2,'pro',id,'COMP','ISOLATED_TEST' FROM commercial_plan_versions WHERE plan_id='pro' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1",[id(),identity.accountId]);
  const f=await connector({shop:'reconnect-fixture.myshopify.com',identity,shopifyShopId:'gid://shopify/Shop/91'}),service=require('../../src/connections/postgres-provider-service');
  const fresh={...f.grant,accessToken:'fresh-oauth-token',refreshToken:'fresh-refresh-token',authorizedAt:iso(-10000),tokenMetadata:{generation:'new'}};delete fresh.shopifyShopId;
  // Resolve the canonical row before entering the store lock, as Settings does.
  async function reconnect(f,grant){const connection=await row(f);return life.run(db,grant.shopifyClientId,grant.shop,session=>service.finishAuthorization(session,connection,identity.userId,{credentials:grant,accountId:grant.shop,accountName:'Reconnected store',capabilities:['read_orders'],expiresAt:iso(3600000)}));}
  await reconnect(f,fresh);
  assert.deepEqual(await store.get(db,f.workspaceId,f.id,'provider'),{...fresh,shopifyShopId:'gid://shopify/Shop/91'});assert.equal(fresh.shopifyShopId,undefined,'Preservation does not mutate the provider result');
  assert.equal(JSON.parse((await row(f)).config).shopifyShopId,'gid://shopify/Shop/91','Persist verified identity outside the replaceable OAuth token record');
  await db.query("DELETE FROM connection_credentials WHERE workspace_id=$1 AND connector_id=$2 AND credential_kind='provider'",[f.workspaceId,f.id]);
  const afterRemoval={...fresh,accessToken:'oauth-after-removal',authorizedAt:iso(-5000)};await reconnect(f,afterRemoval);
  assert.deepEqual(await store.get(db,f.workspaceId,f.id,'provider'),{...afterRemoval,shopifyShopId:'gid://shopify/Shop/91'});
  assert.equal((await send(f,signed(f,{triggeredAt:iso(-1000),body:{id:91,myshopify_domain:null}}))).status,200);assert.equal((await row(f)).status,'disconnected');
  assert.equal((await send(f,signed(f,{body:{id:92,myshopify_domain:null}}))).status,401,'Persistent identity still checks new deliveries after token deletion');
  const changedStore=await connector({shop:'old-store-fixture.myshopify.com',identity,shopifyShopId:'gid://shopify/Shop/91'}),differentStore={...changedStore.grant,shop:'different-store-fixture.myshopify.com',authorizedAt:iso(-5000)};delete differentStore.shopifyShopId;
  await reconnect(changedStore,differentStore);assert.equal((await store.get(db,changedStore.workspaceId,changedStore.id,'provider')).shopifyShopId,undefined);assert.equal(JSON.parse((await row(changedStore)).config).shopifyShopId,undefined,'A different store cannot inherit a previous store ID');
  const changedApp=await connector({shop:'changed-app-fixture.myshopify.com',identity,shopifyShopId:'gid://shopify/Shop/91'}),differentApp={...changedApp.grant,shopifyProfile:'legacy',shopifyClientId:process.env.SHOPIFY_CLIENT_ID,authorizedAt:iso(-5000)};delete differentApp.shopifyShopId;
  await reconnect(changedApp,differentApp);assert.equal((await store.get(db,changedApp.workspaceId,changedApp.id,'provider')).shopifyShopId,undefined);assert.equal(JSON.parse((await row(changedApp)).config).shopifyShopId,undefined,'A different app cannot inherit a previous app grant identity');assert.equal(refreshCalls,0);
 });
 await t.test('unidentified disconnected acknowledgments cannot revoke a replacement grant',async()=>{
  const f=await connector({shop:'inactive-fixture.myshopify.com'});await db.query("UPDATE workspace_connectors SET status='disconnected' WHERE id=$1",[f.id]);await db.query('DELETE FROM connection_credentials WHERE connector_id=$1',[f.id]);
  const input=signed(f,{body:{id:999,myshopify_domain:null}}),state=async()=>({connectors:(await db.query('SELECT id,status,config,credential_ref,paused_at,last_error FROM workspace_connectors ORDER BY id')).rows,events:(await db.query("SELECT id FROM domain_events WHERE event_type='connection.authorization_revoked' ORDER BY id")).rows,handoffs:(await db.query('SELECT id,status FROM shopify_public_installs ORDER BY id')).rows}),beforeAck=await state();
  const response=await send(f,input);assert.equal(response.status,200);assert.deepEqual(await state(),beforeAck,'An unbound disconnected acknowledgment makes no revocation, handoff, or history change');
  const receipt=(await db.query('SELECT result FROM connection_webhook_receipts WHERE id=$1',[response.body.receiptId])).rows[0];assert.equal(receipt.result.alreadyRevoked,true);assert.equal(receipt.result.revoked,false);
  assert.equal((await send(f,signed(f,{secret:'forged',body:{id:999,myshopify_domain:null}}))).status,401);
  const replacement={...f.grant,authorizedAt:iso(-10000),accessToken:'active-replacement-token'};await store.put(db,f.workspaceId,f.id,'provider',replacement);await db.query("UPDATE workspace_connectors SET status='connected' WHERE id=$1",[f.id]);
  assert.equal((await send(f,input)).status,200,'The exact previously acknowledged receipt is replayed without applying it to new credentials');
  assert.equal((await send(f,signed(f,{body:{id:999,myshopify_domain:null}}))).status,400,'A new unbound delivery fails closed against an active grant');assert.deepEqual(await store.get(db,f.workspaceId,f.id,'provider'),replacement);assert.equal((await row(f)).status,'connected');
 });
 await t.test('a captured body cannot revoke a valid replacement by changing unsigned topic, delivery ID and timestamp',async()=>{
  const f=await connector({shop:'modified-headers-fixture.myshopify.com',shopifyShopId:'gid://shopify/Shop/91',authorizedAt:iso(-10000)}),captured=signed(f,{topic:'shop/update',triggeredAt:iso(-60000)});
  probes.set(f.grant.accessToken,{mode:'valid',clientId:f.clientId});
  const beforeGrant=await store.get(db,f.workspaceId,f.id,'provider'),beforeConnector=await row(f),beforeCalls=calls;
  captured.headers['x-shopify-topic']='app/uninstalled';captured.headers['x-shopify-webhook-id']=id();captured.headers['x-shopify-triggered-at']=iso(60000);
  const accepted=await send(f,captured);assert.equal(accepted.status,200,accepted.text);
  assert.equal((await db.query('SELECT result FROM connection_webhook_receipts WHERE id=$1',[accepted.body.receiptId])).rows[0].result.ignored,'current_grant_valid');
  assert.deepEqual(await store.get(db,f.workspaceId,f.id,'provider'),beforeGrant);assert.deepEqual(await row(f),beforeConnector);assert.equal(calls,beforeCalls+1);
  assert.equal((await send(f,captured)).status,200);assert.equal(calls,beforeCalls+1,'An exact completed replay needs no second probe');assert.equal(refreshCalls,0);
 });
 await t.test('expired token 401, forbidden/IP blocked, network failure and invalid identity defer without revocation',async()=>{
  for(const mode of ['expired','forbidden','ip_blocked','network','unavailable','unknown_401','wrong_identity']){
   const f=await connector({shop:mode.replaceAll('_','-')+'-probe-fixture.myshopify.com',shopifyShopId:'gid://shopify/Shop/91',expiresAt:mode==='expired'?iso(-1000):iso(3600000)});
   probes.set(f.grant.accessToken,{mode,clientId:f.clientId});const beforeGrant=await store.get(db,f.workspaceId,f.id,'provider'),beforeConnector=await row(f),beforeCalls=calls;
   const response=await send(f,signed(f,{triggeredAt:iso(60000)}));assert.equal(response.status,503,mode+': '+response.text);assert.equal(response.body.error.code,'shopify_uninstall_unconfirmed');
   assert.deepEqual(await store.get(db,f.workspaceId,f.id,'provider'),beforeGrant,mode);assert.deepEqual(await row(f),beforeConnector,mode);assert.equal(calls,beforeCalls+(mode==='expired'?2:1),'Only expired-token 401 may also verify its known refresh family, with no HTTP retry');
  }
  assert.equal(refreshCalls,1);assert.deepEqual(await history(),before);
 });
 await t.test('expired access with a valid current refresh family rotates once and commits fresh credentials without another probe',async()=>{
  const f=await connector({shop:'refresh-valid-fixture.myshopify.com',shopifyShopId:'gid://shopify/Shop/91',expiresAt:iso(-1000)}),saved={...f.grant,extraMetadata:{preserved:true}};
  await store.put(db,f.workspaceId,f.id,'provider',saved);refreshFamilies.set(saved.refreshToken,{mode:'valid',accessToken:'rotated-current-access',refreshToken:'rotated-current-refresh'});
  probes.set('rotated-current-access',{mode:'network',clientId:f.clientId});
  const input=signed(f,{topic:'shop/update'});input.headers['x-shopify-topic']='app/uninstalled';input.headers['x-shopify-webhook-id']=id();input.headers['x-shopify-triggered-at']=iso(60000);
  const warningsBefore=(await db.query("SELECT count(*)::int n FROM commercial_critical_warnings WHERE status='OPEN'")).rows[0].n;
  const beforeCalls=calls,beforeRefresh=refreshCalls,response=await send(f,input);assert.equal(response.status,200,response.text);
  const receipt=(await db.query('SELECT result FROM connection_webhook_receipts WHERE id=$1',[response.body.receiptId])).rows[0];assert.equal(receipt.result.ignored,'current_refresh_family_valid');assert.equal(receipt.result.refreshed,true);
  const rotated=await store.get(db,f.workspaceId,f.id,'provider');assert.equal(rotated.accessToken,'rotated-current-access');assert.equal(rotated.refreshToken,'rotated-current-refresh');assert.equal(rotated.authorizedAt,saved.authorizedAt);assert.equal(rotated.shopifyShopId,saved.shopifyShopId);assert.deepEqual(rotated.extraMetadata,saved.extraMetadata);assert(Date.parse(rotated.accessTokenExpiresAt)>Date.now());assert.equal((await row(f)).status,'connected');
  assert.equal(calls,beforeCalls+2,'One raw identity probe and one authenticated refresh, never a post-rotation probe');assert.equal(refreshCalls,beforeRefresh+1);
  const costs=(await db.query("SELECT amount_minor FROM commercial_cost_events WHERE workspace_id=$1 AND detail->>'requestId'=ANY($2::text[])",[f.workspaceId,['shopify-uninstall-probe:'+response.body.receiptId,'shopify-uninstall-refresh:'+response.body.receiptId]])).rows;assert.equal(costs.length,2);assert(costs.every(c=>Number(c.amount_minor)===0),'Probe and refresh are recorded with verified zero incremental HTTP request cost');assert.equal((await db.query("SELECT count(*)::int n FROM commercial_critical_warnings WHERE status='OPEN'")).rows[0].n,warningsBefore,'Security verification must not invent an unknown-cost warning');
  assert.equal((await send(f,input)).status,200);assert.equal(calls,beforeCalls+2,'Completed replay cannot rotate the single-use family again');assert.deepEqual(await history(),before);
 });
 await t.test('expired access revokes only on explicit invalid_grant for the current unexpired refresh family',async()=>{
  const f=await connector({shop:'refresh-revoked-fixture.myshopify.com',shopifyShopId:'gid://shopify/Shop/91',expiresAt:iso(-1000)});refreshFamilies.set(f.grant.refreshToken,{mode:'invalid_grant'});
  const response=await send(f,signed(f));assert.equal(response.status,200,response.text);assert.equal((await row(f)).status,'disconnected');assert.equal(await store.get(db,f.workspaceId,f.id,'provider'),null);
  const event=(await db.query("SELECT payload FROM domain_events WHERE event_type='connection.authorization_revoked' AND source_record_id=$1",[f.id])).rows[0];assert.equal(JSON.parse(event.payload).verification,'CURRENT_REFRESH_FAMILY_REJECTED');
 });
 await t.test('missing, expired, misconfigured or unreachable refresh families preserve the saved grant for review',async()=>{
  for(const mode of ['missing','expired_family','invalid_client','network','unknown']){
   const f=await connector({shop:mode.replaceAll('_','-')+'-family-fixture.myshopify.com',shopifyShopId:'gid://shopify/Shop/91',expiresAt:iso(-1000)}),grant={...f.grant};
   if(mode==='missing')delete grant.refreshToken;if(mode==='expired_family')grant.refreshTokenExpiresAt=iso(-1000);await store.put(db,f.workspaceId,f.id,'provider',grant);if(grant.refreshToken)refreshFamilies.set(grant.refreshToken,{mode});
   const beforeRefresh=refreshCalls,response=await send(f,signed(f));assert.equal(response.status,503,mode+': '+response.text);assert.deepEqual(await store.get(db,f.workspaceId,f.id,'provider'),grant);assert.equal((await row(f)).status,'connected');assert.equal(refreshCalls,beforeRefresh+(['missing','expired_family'].includes(mode)?0:1));
  }
 });
 await t.test('new OAuth timestamps the authorization generation and refresh preserves it',async()=>{
  const scopes=['read_orders','read_products','read_locations','read_inventory','read_fulfillments','write_products','write_inventory'];
  global.fetch=async()=>Response.json({access_token:'new-token',refresh_token:'new-refresh',expires_in:3600,refresh_token_expires_in:86400,scope:scopes.join(',')});
  const query={shop:another.shop,code:'synthetic-code',timestamp:String(Math.floor(Date.now()/1000))};query.hmac=crypto.createHmac('sha256',process.env.SHOPIFY_PUBLIC_CLIENT_SECRET).update(Object.keys(query).sort().map(key=>key+'='+query[key]).join('&')).digest('hex');
  const result=await adapter.exchangeAuthorization({query,metadata:{shop:another.shop,shopifyProfile:'public',shopifyClientId:another.clientId,requestedScopes:scopes}});assert(Number.isFinite(Date.parse(result.credentials.authorizedAt)));
  const refreshed=await adapter.refreshCredentials({...result.credentials,shopifyShopId:'gid://shopify/Shop/91',accessTokenExpiresAt:iso(-1000)});assert.equal(refreshed.credentials.authorizedAt,result.credentials.authorizedAt);assert.equal(refreshed.credentials.shopifyShopId,'gid://shopify/Shop/91');
 });
});
