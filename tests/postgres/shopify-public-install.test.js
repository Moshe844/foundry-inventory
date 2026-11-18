'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),request=require('supertest');
const csrf=html=>html.match(/name="_csrf" value="([^"]+)"/)?.[1];
const signed=(query,secret=process.env.SHOPIFY_PUBLIC_CLIENT_SECRET)=>({...query,hmac:crypto.createHmac('sha256',secret).update(Object.keys(query).sort().map(k=>k+'='+query[k]).join('&')).digest('hex')});
const timestamp=()=>String(Math.floor(Date.now()/1000));
test('public Shopify installation authenticates before sign-in and preserves paid plans, old grants and capacity',{timeout:360000},async t=>{
 const env={...process.env},oldFetch=global.fetch,cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 process.env.STOCKCHIEF_RUNTIME_ENV='production';process.env.SHOPIFY_CLIENT_ID='legacy-app';process.env.SHOPIFY_CLIENT_SECRET='legacy-secret';
 process.env.SHOPIFY_PUBLIC_CLIENT_ID='public-app';process.env.SHOPIFY_PUBLIC_CLIENT_SECRET='public-secret';process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS='{}';
 process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID=require('../../src/commercial/stripe-live-fee-evidence').accountId;
 await db.query('UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true');
 await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID(),connectionPublicOrigin:'https://app.stockchiefhq.com'});
 const auth=require('../../src/domain/postgres-auth-service'),ent=require('../../src/commercial/entitlements'),adapter=require('../../src/connections/providers/shopify'),store=require('../../src/connections/postgres-credential-store');
 const calls=[],scopes=['read_orders','read_products','read_locations','read_inventory','read_fulfillments','write_products','write_inventory'];
 global.fetch=async(value,options)=>{
   const url=new URL(value);assert.match(url.hostname,/^(?:browser-)?(starter|growth|pro|legacy|other|denied|full|lifecycle|diagnostic|review)-fixture\.myshopify\.com$/,'Only synthetic providers are contacted');
   calls.push({path:url.pathname,body:options.body});
   if(url.pathname==='/admin/oauth/access_token'){
     const form=new URLSearchParams(options.body);assert.equal(form.get('client_id'),'public-app');assert.equal(form.get('client_secret'),'public-secret');
     if(form.has('code'))assert.equal(form.get('expiring'),'1');else assert.equal(form.get('grant_type'),'refresh_token');
     return Response.json({access_token:'public-access-'+calls.length,refresh_token:'public-refresh-'+calls.length,expires_in:3600,refresh_token_expires_in:7776000,scope:scopes.join(',')});
   }
   const body=JSON.parse(options.body);
   if(body.query.includes('CatalogBootstrap'))return Response.json({data:{shop:{currencyCode:'USD'},productVariants:{nodes:[{id:'gid://shopify/ProductVariant/1',title:'Default Title',sku:'FIXTURE-1',price:'5.00',selectedOptions:[],product:{id:'gid://shopify/Product/1',title:'Fixture product',status:'ACTIVE',isGiftCard:false},inventoryItem:{id:'gid://shopify/InventoryItem/1',tracked:true,requiresShipping:true,inventoryLevels:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}],pageInfo:{hasNextPage:false,endCursor:null}}}});
   if(body.query.includes('query Locations'))return Response.json({data:{locations:{nodes:[{id:'gid://shopify/Location/1',name:'Fixture warehouse',isActive:true}],pageInfo:{hasNextPage:false,endCursor:null}}}});
   if(body.query.includes('StockChiefWebhooks'))return Response.json({data:{webhookSubscriptions:{nodes:[]}}});
   if(body.query.includes('AddWebhook'))return Response.json({data:{webhookSubscriptionCreate:{userErrors:[],webhookSubscription:{id:'gid://shopify/WebhookSubscription/'+calls.length}}}});
   throw Error('Unexpected provider operation: '+url.pathname);
 };
 t.after(async()=>{global.fetch=oldFetch;process.env={...env};await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 async function business(plan){
   const password='Public!'+crypto.randomUUID(),owner=await auth.createBusiness(db,{name:'Owner',businessName:'Shopify '+plan,email:crypto.randomUUID()+'@example.test',password});
   await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[crypto.randomUUID(),owner.accountId,plan]);
   return {owner,password,agent:request.agent(app),shop:plan+'-fixture.myshopify.com'};
 }
 async function begin(f,shop=f.shop){return f.agent.get('/integrations/shopify/install').query(signed({shop,timestamp:timestamp()}));}
 function callback(location,shop){const url=new URL(location);return signed({shop:shop||url.hostname,state:url.searchParams.get('state'),code:'fixture-code',timestamp:timestamp()});}
 async function consent(f,shop=f.shop){const start=await begin(f,shop);assert.equal(start.status,303,start.text);const query=callback(start.headers.location);const done=await f.agent.get('/integrations/shopify/callback').query(query);assert.equal(done.status,303,done.text);return {start,query};}
 async function login(f){const page=await f.agent.get('/login?next=%2Fintegrations%2Fshopify%2Fconnect');const result=await f.agent.post('/login').type('form').send({_csrf:csrf(page.text),email:f.owner.email,password:f.password,next:'/integrations/shopify/connect'});assert.equal(result.status,302,result.text);assert.equal(result.headers.location,'/integrations/shopify/connect');}
 async function claim(f,workspaceId=f.owner.workspaceId){const page=await f.agent.get('/integrations/shopify/connect');assert.equal(page.status,200,page.text);const token=csrf(page.text)||f.lastCsrf;f.lastCsrf=token;return f.agent.post('/integrations/shopify/connect').type('form').send({_csrf:token,workspaceId});}
 const fixtures=[];
 for(const plan of ['starter','growth','pro'])fixtures.push(await business(plan));
 const map=Object.fromEntries(fixtures.map(f=>[f.owner.workspaceId,[f.shop,'legacy-fixture.myshopify.com','full-fixture.myshopify.com','denied-fixture.myshopify.com']]));process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=JSON.stringify(map);
 await t.test('production lists Stripe on every plan without enabling an unconfigured merchant connection',async()=>{
  for(const fixture of fixtures){const f={...fixture,agent:request.agent(app)};await login(f);const page=await f.agent.get('/settings/connections');assert.equal(page.status,200);assert.match(page.text,/data-integration-card="stripe"/);assert.match(page.text,/disabled data-stripe-production-pending/);assert(!/data-provider-type="stripe"/.test(page.text),'Unconfigured live authorization must not be offered');assert.match(page.text,/data-integration-card="cardknox"/);}
 });
 for(const f of fixtures)await t.test(f.shop,async()=>{
   const before=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows;
   const start=await begin(f);assert.equal(start.status,303,start.text);const url=new URL(start.headers.location);
   assert.equal(url.searchParams.get('client_id'),'public-app');assert.equal(url.searchParams.get('redirect_uri'),'https://app.stockchiefhq.com/integrations/shopify/callback');
   assert(start.headers['set-cookie'].some(c=>/stockchief_shopify_install=.*HttpOnly.*SameSite=Lax/.test(c)));
   assert.equal((await db.query('SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n,0);
   const query=callback(start.headers.location),attempts=calls.length;
   assert.equal((await request(app).get('/integrations/shopify/callback').query(query)).status,400);assert.equal(calls.length,attempts,'Another browser cannot exchange the code');
   assert.equal((await f.agent.get('/integrations/shopify/callback').query({...query,hmac:'0'.repeat(64)})).status,400);assert.equal(calls.length,attempts);
   const accepted=await f.agent.get('/integrations/shopify/callback').query(query);assert.equal(accepted.status,303,accepted.text);
   const ready=await f.agent.get('/integrations/shopify/connect');assert.match(ready.text,/Sign in to StockChief/);assert(!ready.text.includes('public-access-'));
   const attemptsAfter=calls.length;assert.equal((await f.agent.get('/integrations/shopify/callback').query(query)).status,400);assert.equal(calls.length,attemptsAfter,'Replays do not exchange a code twice');
   await login(f);const connected=await claim(f);assert.equal(connected.status,303,connected.text);
   assert.match(connected.headers.location,/^\/settings\/connections\/con_/);
   const connection=(await db.query("SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='shopify'",[f.owner.workspaceId])).rows[0];
   const config=JSON.parse(connection.config),grant=await store.get(db,f.owner.workspaceId,connection.id,'provider');
   assert.equal(config.shopifyProfile,'public');assert.equal(config.shopifyClientId,'public-app');assert.equal(grant.shopifyClientId,'public-app');assert(grant.refreshToken);
   const handoff=(await db.query('SELECT * FROM shopify_public_installs WHERE linked_connector_id=$1',[connection.id])).rows[0];assert.equal(handoff.ciphertext,null,'Successful linking erases temporary credentials');
   assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,before,'Stripe subscription and selected plan are unchanged');
   const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
   const firstSync=await queue.processOne(db,handlers,{kinds:['provider.catalog-sync'],workspaceId:f.owner.workspaceId,owner:'public-shopify-worker-fixture'});
   assert.equal(firstSync?.status,'COMPLETED',JSON.stringify(firstSync?.lastError));
   assert.equal((await db.query("SELECT count(*)::int n FROM connection_external_records WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sku'",[f.owner.workspaceId,connection.id])).rows[0].n,1,'The actual background worker reads and retains the Shopify product');
   const afterSync=(await db.query('SELECT last_synced_at,last_error FROM workspace_connectors WHERE id=$1',[connection.id])).rows[0];assert(afterSync.last_synced_at);assert.equal(afterSync.last_error,null);
   assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,before,'The first background update preserves the subscription and plan');
   assert.equal(await require('../../src/commercial/release').isOpen(db),true,'An approved private Shopify connection must preserve public checkout');
   const event={eventId:'shipping-observation-'+f.owner.workspaceId,type:'fulfillment.reported',data:{}};
   const eventAuth={workspaceId:f.owner.workspaceId,connectorId:connection.id,actorId:f.owner.userId};
   const events=require('../../src/connections/postgres-event-ingestion');
   assert.equal((await events.ingest(db,eventAuth,event)).status,'IGNORED');
   assert.equal((await events.ingest(db,eventAuth,event)).replayed,true);
   const eventCosts=(await db.query("SELECT amount_minor,detail FROM commercial_cost_events WHERE workspace_id=$1 AND provider='shopify' AND operation='event_ingestion'",[f.owner.workspaceId])).rows;
   assert.equal(eventCosts.length,1,'A replay cannot count an event twice');
   assert.equal(Number(eventCosts[0].amount_minor),0);assert.equal(eventCosts[0].detail.costBasis,'NO_EXTRA_SHOPIFY_EVENT_INGESTION_FEE');
   assert.equal(await require('../../src/commercial/release').isOpen(db),true,'Receiving a private Shopify event must preserve public checkout');
   assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n,0,'Authorization does not import starting stock');
   const rawBody=Buffer.from('{"id":42}'),headers={'x-shopify-shop-domain':f.shop,'x-shopify-hmac-sha256':crypto.createHmac('sha256','public-secret').update(rawBody).digest('base64')};
   adapter.verifyWebhook({headers,rawBody,credentials:grant,connection:{...connection,config}});
   assert.throws(()=>adapter.verifyWebhook({headers:{...headers,'x-shopify-hmac-sha256':crypto.createHmac('sha256','legacy-secret').update(rawBody).digest('base64')},rawBody,credentials:grant,connection:{...connection,config}}),/signature verification/);
   const refreshed=await adapter.refreshCredentials({...grant,accessTokenExpiresAt:new Date(Date.now()-1).toISOString()});assert.equal(refreshed.refreshed,true);assert.equal(refreshed.credentials.shopifyClientId,'public-app');
   const beforeReopen=calls.length,reopen=await begin(f);assert.equal(reopen.headers.location,'/integrations/shopify/connect');const opened=await claim(f);assert.equal(opened.headers.location,connected.headers.location);assert.equal(calls.length,beforeReopen,'Reopening does not replace its working token or register duplicate hooks');
   const reconnect=await require('../../src/connections/postgres-provider-service').beginAuthorization(db,{workspaceId:f.owner.workspaceId,actorId:f.owner.userId},{providerType:'shopify',shop:f.shop,connectorId:connection.id,shopifyProfile:'legacy'},'https://app.stockchiefhq.com');
   assert.equal(new URL(reconnect.redirectUrl).searchParams.get('client_id'),'public-app','Public reconnects cannot be switched to the old app by caller input');
   assert.deepEqual(await store.get(db,f.owner.workspaceId,connection.id,'provider'),grant,'Starting reconnect preserves the working token');
 });
 await t.test('checkout exception requires both the configured inventory and exact store',async()=>{
  const release=require('../../src/commercial/release'),f=fixtures[0],connection=(await db.query("SELECT id,provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='shopify'",[f.owner.workspaceId])).rows[0];
  assert.equal(await release.isOpen(db),true);
  try{await db.query('UPDATE workspace_connectors SET provider_account_id=$2 WHERE id=$1',[connection.id,'unapproved-fixture.myshopify.com']);assert.equal(await release.isOpen(db),false,'A foreign store in a pilot inventory remains unqualified');}
  finally{await db.query('UPDATE workspace_connectors SET provider_account_id=$2 WHERE id=$1',[connection.id,connection.provider_account_id]);}
  const original=process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS;
  try{const changed={...map};delete changed[f.owner.workspaceId];process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=JSON.stringify(changed);assert.equal(await release.isOpen(db),false);process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS='{invalid';assert.equal(await release.isOpen(db),false);}
  finally{process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=original;}
  assert.equal(await release.isOpen(db),true);
 });
 await t.test('Settings starts every new paid-plan connection with the public app',async()=>{
  for(const plan of ['starter','growth','pro']){
   const f=await business(plan);f.shop='settings-'+plan+'-fixture.myshopify.com';map[f.owner.workspaceId]=[f.shop];process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=JSON.stringify(map);
   const before=calls.length,started=await require('../../src/connections/postgres-provider-service').beginAuthorization(db,{workspaceId:f.owner.workspaceId,actorId:f.owner.userId},{providerType:'shopify',shop:f.shop,shopifyProfile:'legacy'},'https://app.stockchiefhq.com'),url=new URL(started.redirectUrl);
   assert.equal(url.searchParams.get('client_id'),'public-app');assert.equal(url.searchParams.get('redirect_uri'),'https://app.stockchiefhq.com/settings/connections/shopify/callback');assert.equal(calls.length,before);
  }
 });
 await t.test('the actual sign-in and owner-link screens work on desktop and phone for all three plans',async()=>{
   const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base='http://127.0.0.1:'+server.address().port;
   const browser=await require('playwright').chromium.launch(),path=require('node:path'),folder=path.join(process.cwd(),'data','shopify-public-install');require('node:fs').mkdirSync(folder,{recursive:true});
   try{for(const plan of ['starter','growth','pro']){
     const f=await business(plan);f.shop='browser-'+plan+'-fixture.myshopify.com';map[f.owner.workspaceId]=[f.shop];process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=JSON.stringify(map);
     for(const width of [1440,390]){
       const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(20000);
       await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
       // Shopify consent is a provider fixture. Keep its redirect unfollowed;
       // the fresh browser and its shared request context own the real cookie,
       // callback, StockChief sign-in, plan check and inventory-link UI.
       const start=await context.request.get(base+'/integrations/shopify/install?'+new URLSearchParams(signed({shop:f.shop,timestamp:timestamp()})),{maxRedirects:0});assert.equal(start.status(),303);
       const target=new URL(start.headers().location,base);
       if(target.origin===base)await page.goto(target.href);else{
         assert.equal(target.hostname,f.shop);assert.equal(target.searchParams.get('client_id'),'public-app');
         await page.goto(base+'/integrations/shopify/callback?'+new URLSearchParams(callback(target.href)));
       }
       assert.equal(await page.getByRole('link',{name:'Sign in to StockChief',exact:true}).count(),1,await page.locator('body').innerText());
       await page.getByRole('link',{name:'Sign in to StockChief',exact:true}).click();await page.getByLabel('Work email').fill(f.owner.email);await page.locator('[name=password]').fill(f.password);
       await Promise.all([page.waitForURL(base+'/integrations/shopify/connect'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
       await page.getByLabel('Your inventory',{exact:true}).selectOption(f.owner.workspaceId);
       assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),plan+' at '+width+' has no sideways scroll');
       await page.screenshot({path:path.join(folder,plan+'-'+width+'.png'),fullPage:true});
       await Promise.all([page.waitForURL('**/settings/connections/con_*'),page.getByRole('button',{name:width===1440?'Connect Shopify':'Open connection',exact:true}).click()]);
       assert(await page.getByRole('heading',{name:/Shopify/}).first().isVisible());await context.close();
     }
   }}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 });
 await t.test('pre-sign-in authorization cannot permit business API calls or another app',async()=>{
   const gate=require('../../src/connections/shopify-install-authorization'),context=require('../../src/commercial/context'),row={id:'synthetic-install',shop:'starter-fixture.myshopify.com',client_id:'public-app'};
   await gate.run(db,row,async()=>{
     const current=context.current(),token={method:'POST',body:new URLSearchParams({client_id:'public-app',client_secret:'public-secret',code:'fixture-code',expiring:'1'}).toString()};
     assert.equal(gate.admit(current,'https://starter-fixture.myshopify.com/admin/api/2026-07/graphql.json',token),false);
     assert.equal(gate.admit(current,'https://other-fixture.myshopify.com/admin/oauth/access_token',token),false);
     assert.equal(gate.admit(current,'https://starter-fixture.myshopify.com/admin/oauth/access_token',{...token,body:token.body.replace('public-app','legacy-app')}),false);
     assert.equal(gate.admit(current,'https://starter-fixture.myshopify.com/admin/oauth/access_token',token),true);
     assert.equal(gate.admit(current,'https://starter-fixture.myshopify.com/admin/oauth/access_token',token),false,'The code exchange is one-use');
   });
 });
 await t.test('callback failures preserve their reason and log only fixed diagnostic categories',async()=>{
   const configuredKeys=['SHOPIFY_PARTNER_ID','SHOPIFY_PUBLIC_APP_ID','SHOPIFY_PARTNER_ACCESS_TOKEN'];
   const previous=Object.fromEntries(configuredKeys.map(key=>[key,process.env[key]]));
   Object.assign(process.env,{SHOPIFY_PARTNER_ID:'5146412',SHOPIFY_PUBLIC_APP_ID:'448446889985',SHOPIFY_PARTNER_ACCESS_TOKEN:'fixture-partner-token'});
   const providerFetch=global.fetch,warn=console.warn,diagnostics=[];
   const f={agent:request.agent(app),shop:'diagnostic-fixture.myshopify.com'};
   const before={subscriptions:(await db.query('SELECT * FROM account_subscriptions ORDER BY account_id')).rows,
     connections:(await db.query('SELECT id,status FROM workspace_connectors ORDER BY id')).rows};
   console.warn=(...values)=>{if(String(values[0]).startsWith('SHOPIFY_INSTALLATION_FAILED '))diagnostics.push(values[0]);else warn(...values);};
   try{
     for(const fixture of [
       {kind:'token',phase:'TOKEN_EXCHANGE',reason:'OPERATION_REJECTED',message:'Fixture permission exchange was rejected.'},
       {kind:'identity-query',phase:'STORE_IDENTITY',reason:'IDENTITY_QUERY_REJECTED',message:'Shopify could not verify this billing installation.'},
       {kind:'identity',phase:'STORE_IDENTITY',reason:'IDENTITY_MISMATCH',message:'Shopify billing belongs to another app or store. No subscription was changed.'}
     ]){
       global.fetch=async(value,options)=>{
         const url=new URL(value);
         assert.equal(url.hostname,f.shop,'Only the synthetic review fixture may be contacted');
         if(url.pathname==='/admin/oauth/access_token')return fixture.kind==='token'
           ?Response.json({error_description:fixture.message},{status:403}):providerFetch(value,options);
         assert.equal(url.pathname,'/admin/api/2026-07/graphql.json');
         assert.match(JSON.parse(options.body).query,/StockChiefBillingIdentity/);
         if(fixture.kind==='identity-query')return Response.json({errors:[{message:'Fixture access denied'}]});
         return Response.json({data:{shop:{id:'gid://shopify/Shop/123456',myshopifyDomain:f.shop,plan:{partnerDevelopment:false}},
           currentAppInstallation:{app:{id:fixture.kind==='identity'?'gid://shopify/App/999':'gid://shopify/App/448446889985',apiKey:'public-app',handle:'stockchief'}}}});
       };
       const start=await begin(f);assert.equal(start.status,303,start.text);
       const response=await f.agent.get('/integrations/shopify/callback').query(callback(start.headers.location));
       assert.equal(response.status,400);assert(response.text.includes(fixture.message),response.text);
       const row=(await db.query('SELECT status,ciphertext FROM shopify_public_installs WHERE shop=$1 ORDER BY created_at DESC LIMIT 1',[f.shop])).rows[0];
       assert.equal(row.status,'FAILED');assert.equal(row.ciphertext,null);
       const diagnostic=JSON.parse(diagnostics.at(-1).slice('SHOPIFY_INSTALLATION_FAILED '.length));
       assert.equal(diagnostic.phase,fixture.phase);assert.equal(diagnostic.reason,fixture.reason);
       if(fixture.kind==='identity')assert.deepEqual(diagnostic.identityChecks,{domainMatches:true,validShopId:true,appMatches:false,clientMatches:true,validHandle:true});
     }
     assert.equal(diagnostics.length,3);
     assert(!/public-secret|public-access-|public-refresh-|fixture-code|fixture-partner-token|hmac|state=|myshopify/.test(diagnostics.join('\n')),'Diagnostics must contain no provider secrets, URLs, or browser proofs');
     assert.deepEqual((await db.query('SELECT * FROM account_subscriptions ORDER BY account_id')).rows,before.subscriptions);
     assert.deepEqual((await db.query('SELECT id,status FROM workspace_connectors ORDER BY id')).rows,before.connections);
   }finally{
     global.fetch=providerFetch;console.warn=warn;
     for(const key of configuredKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
   }
 });
 await t.test('verified non-development review stores reach sign-in while activation and billing stay gated',async()=>{
   const keys=['SHOPIFY_PARTNER_ID','SHOPIFY_PUBLIC_APP_ID','SHOPIFY_PARTNER_ACCESS_TOKEN','STOCKCHIEF_SHOPIFY_PUBLIC_APPROVED'];
   const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]])),providerFetch=global.fetch;
   Object.assign(process.env,{SHOPIFY_PARTNER_ID:'5146412',SHOPIFY_PUBLIC_APP_ID:'448446889985',SHOPIFY_PARTNER_ACCESS_TOKEN:'fixture-partner-token',STOCKCHIEF_SHOPIFY_PUBLIC_APPROVED:'0'});
   const f={...fixtures[0],agent:request.agent(app),shop:'review-fixture.myshopify.com'},stripe=await business('growth');
   await db.query("UPDATE account_subscriptions SET stripe_subscription_id='sub_review_preserved',stripe_customer_id='cus_review_preserved' WHERE account_id=$1",[stripe.owner.accountId]);
   const before={subscriptions:(await db.query('SELECT * FROM account_subscriptions ORDER BY account_id')).rows,
     connections:(await db.query('SELECT id,status FROM workspace_connectors ORDER BY id')).rows,
     checkouts:(await db.query('SELECT * FROM commercial_checkout_attempts ORDER BY id')).rows,
     credentials:(await db.query('SELECT count(*)::int n FROM connection_credentials')).rows[0].n};
   let tokenExchanges=0,identityReads=0;
   global.fetch=async(value,options)=>{
     const url=new URL(value);assert.equal(url.hostname,f.shop,'The reviewer handoff cannot contact another store or a billing provider');
     if(url.pathname==='/admin/oauth/access_token'){tokenExchanges++;return providerFetch(value,options);}
     assert.equal(url.pathname,'/admin/api/2026-07/graphql.json');assert.match(JSON.parse(options.body).query,/StockChiefBillingIdentity/);identityReads++;
     return Response.json({data:{shop:{id:'gid://shopify/Shop/987654',myshopifyDomain:f.shop,plan:{partnerDevelopment:false}},
       currentAppInstallation:{app:{id:'gid://shopify/App/448446889985',apiKey:'public-app',handle:'stockchief'}}}});
   };
   try{
     const start=await begin(f);assert.equal(start.status,303,start.text);
     const token=start.headers['set-cookie'].find(c=>c.startsWith('stockchief_shopify_install=')).split(';')[0].split('=')[1];
     const response=await f.agent.get('/integrations/shopify/callback').query(callback(start.headers.location));
     assert.equal(response.status,303,response.text);assert.equal(response.headers.location,'/integrations/shopify/connect');
     const ready=await f.agent.get(response.headers.location);assert.equal(ready.status,200,ready.text);assert.match(ready.text,/Sign in to StockChief/);
     assert(!ready.text.includes('public-access-'));assert(!ready.text.includes('public-refresh-'));
     const service=require('../../src/connections/postgres-shopify-public-install'),billing=require('../../src/commercial/postgres-shopify-billing');
     const installation=await service.read(db,token);assert.equal(installation.status,'AUTHORIZED');assert.equal(installation.activationPending,true);
     const account=(await db.query('SELECT * FROM accounts WHERE id=$1',[f.owner.accountId])).rows[0];
     const stripeAccount=(await db.query('SELECT * FROM accounts WHERE id=$1',[stripe.owner.accountId])).rows[0];
     await assert.rejects(service.attach(db,account,token,f.owner.workspaceId),/Shopify approval/);
     await assert.rejects(billing.startInstallation(db,account,installation),/Shopify approval/);
     await assert.rejects(billing.startInstallation(db,stripeAccount,installation),/billed through Stripe/);
     await login(f);const pending=await f.agent.get('/integrations/shopify/connect');assert.equal(pending.status,200,pending.text);
     assert.match(pending.text,/New live-store connections will be available after Shopify approves StockChief/);
     assert(!pending.text.includes('action="/integrations/shopify/connect"'));assert(!pending.text.includes('action="/integrations/shopify/billing/start"'));
     process.env.STOCKCHIEF_SHOPIFY_PUBLIC_APPROVED='1';
     assert.equal((await service.read(db,token)).activationPending,false);
     const admitted=await f.agent.get('/integrations/shopify/connect');assert.equal(admitted.status,200,admitted.text);
     assert.match(admitted.text,/action="\/integrations\/shopify\/connect"/);assert(!admitted.text.includes('Choose a plan in Shopify'),'Existing paid access must not request another subscription');
     assert.equal(tokenExchanges,1);assert.equal(identityReads,1,'Viewing and signing in cannot call catalog, inventory, billing or reauthorize the store');
     assert.deepEqual((await db.query('SELECT * FROM account_subscriptions ORDER BY account_id')).rows,before.subscriptions);
     assert.deepEqual((await db.query('SELECT id,status FROM workspace_connectors ORDER BY id')).rows,before.connections);
     assert.deepEqual((await db.query('SELECT * FROM commercial_checkout_attempts ORDER BY id')).rows,before.checkouts);
     assert.equal((await db.query('SELECT count(*)::int n FROM connection_credentials')).rows[0].n,before.credentials);
   }finally{
     global.fetch=providerFetch;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
   }
 });
 await t.test('invalid entry points cannot create a handoff or call a provider',async()=>{
   const before=calls.length,count=(await db.query('SELECT count(*)::int n FROM shopify_public_installs')).rows[0].n,f=fixtures[0];
   for(const query of [{shop:f.shop,timestamp:timestamp(),hmac:'bad'},signed({shop:f.shop,timestamp:'1000000000'}),signed({shop:'other-fixture.myshopify.com',timestamp:timestamp()}),signed({shop:'starter-fixture.myshopify.com.attacker.test',timestamp:timestamp()})]){
     const response=await request(app).get('/integrations/shopify/install').query(query);assert(response.status>=400,response.text);
   }
   assert.equal(calls.length,before);assert.equal((await db.query('SELECT count(*)::int n FROM shopify_public_installs')).rows[0].n,count);
 });
 await t.test('a full Starter allowance blocks linking without changing the grant or billing',async()=>{
   const f=fixtures[0];await consent(f,'full-fixture.myshopify.com');
   const meter=await ent.meterState(db,{accountId:f.owner.accountId,workspaceId:f.owner.workspaceId},'connections');
   for(let i=meter.used;i<meter.hardLimit;i++)await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,setup_status,expected_interval_minutes,created_at,updated_at) VALUES($1,$2,$1,'Existing channel','square','connected','[]','[]','{}','CONNECTED',5,now(),now())",[crypto.randomUUID(),f.owner.workspaceId]);
   const before=(await db.query('SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n;
   const rejected=await claim(f);assert.equal(rejected.status,400);assert.match(rejected.text,/limit|allowance|capacity/i);
   assert.equal((await db.query('SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n,before);
   assert.equal((await db.query("SELECT status FROM shopify_public_installs WHERE shop='full-fixture.myshopify.com' ORDER BY created_at DESC LIMIT 1")).rows[0].status,'AUTHORIZED','A rejected claim can be retried after its allowance is fixed');
 });
 await t.test('an older custom-app connection is never overwritten by public consent',async()=>{
   const f=fixtures[1],id='legacy-'+crypto.randomUUID();
   await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provider_account_id,status,capabilities,provides,config,setup_status,expected_interval_minutes,created_at,updated_at) VALUES($1,$2,$1,'Working old app','shopify','legacy-fixture.myshopify.com','connected','[]','[]','{\"shopifyClientId\":\"legacy-app\"}','CONNECTED',5,now(),now())",[id,f.owner.workspaceId]);
   const grant={shop:'legacy-fixture.myshopify.com',accessToken:'old-working-token'};await store.put(db,f.owner.workspaceId,id,'provider',grant);
   await consent(f,'legacy-fixture.myshopify.com');const rejected=await claim(f);assert.equal(rejected.status,400);assert.match(rejected.text,/older Shopify app/);
   assert.deepEqual(await store.get(db,f.owner.workspaceId,id,'provider'),grant);assert.equal((await db.query('SELECT status FROM workspace_connectors WHERE id=$1',[id])).rows[0].status,'connected');
   const reconnect=await require('../../src/connections/postgres-provider-service').beginAuthorization(db,{workspaceId:f.owner.workspaceId,actorId:f.owner.userId},{providerType:'shopify',shop:'legacy-fixture.myshopify.com',connectorId:id,shopifyProfile:'public'},'https://app.stockchiefhq.com');
   assert.equal(new URL(reconnect.redirectUrl).searchParams.get('client_id'),'legacy-app','An existing custom grant keeps its app even when public credentials exist');
   const repeated=await require('../../src/connections/postgres-provider-service').beginAuthorization(db,{workspaceId:f.owner.workspaceId,actorId:f.owner.userId},{providerType:'shopify',shop:'legacy-fixture.myshopify.com'},'https://app.stockchiefhq.com');
   assert.equal(repeated.connectorId,id);assert.equal(new URL(repeated.redirectUrl).searchParams.get('client_id'),'legacy-app','Adding the same store again also preserves its original app');
   const rawBody=Buffer.from('{}'),headers={'x-shopify-shop-domain':grant.shop,'x-shopify-hmac-sha256':crypto.createHmac('sha256','legacy-secret').update(rawBody).digest('base64')};adapter.verifyWebhook({headers,rawBody,credentials:grant});
 });
 await t.test('restricted users and cross-account claims cannot link a store',async()=>{
   const f=fixtures[2];await consent(f,'denied-fixture.myshopify.com');
   assert.equal((await claim(f,fixtures[1].owner.workspaceId)).status,400);
   await db.query("UPDATE users SET role='staff' WHERE id=$1",[f.owner.userId]);const denied=await claim(f);assert.equal(denied.status,400);assert.match(denied.text,/inventory you own|current inventory owner/);await db.query("UPDATE users SET role='owner' WHERE id=$1",[f.owner.userId]);
   await db.query('UPDATE shopify_public_installs SET expires_at=now()-interval \'1 second\' WHERE shop=$1',['denied-fixture.myshopify.com']);
   const beforeRecovery=calls.length,expired=await f.agent.get('/integrations/shopify/connect');assert.equal(expired.status,303);assert.equal(expired.headers.location,'https://admin.shopify.com/store/denied-fixture/apps/stockchief');assert.equal(calls.length,beforeRecovery,'Expired proof only restarts authentication; it cannot exchange a grant or link a store');
   assert((await require('../../src/connections/postgres-shopify-public-install').purge(db))>0);
 });
 await t.test('two browsers cannot exchange competing grants or retire an owner-claimed connection',async()=>{
   const f=fixtures[2],shop='denied-fixture.myshopify.com',first=request.agent(app),second=request.agent(app);
   const start=await first.get('/integrations/shopify/install').query(signed({shop,timestamp:timestamp()}));assert.equal(start.status,303);
   const firstCallback=callback(start.headers.location);
   const done=await first.get('/integrations/shopify/callback').query(firstCallback);assert.equal(done.status,303);
   const pending=(await db.query("SELECT id FROM shopify_public_installs WHERE shop=$1 AND status='AUTHORIZED'",[shop])).rows[0];assert(pending);
   await db.query("UPDATE shopify_public_installs SET status='EXCHANGING' WHERE id=$1",[pending.id]);
   const before=calls.length,blocked=await second.get('/integrations/shopify/install').query(signed({shop,timestamp:timestamp()}));
   assert.equal(blocked.status,400);assert.match(blocked.text,/finishing/);assert.equal(calls.length,before);
   await db.query("UPDATE shopify_public_installs SET status='AUTHORIZED' WHERE id=$1",[pending.id]);
   const restart=await second.get('/integrations/shopify/install').query(signed({shop,timestamp:timestamp()}));assert.equal(restart.status,303);
   const retired=(await db.query('SELECT status,ciphertext FROM shopify_public_installs WHERE id=$1',[pending.id])).rows[0];assert.equal(retired.status,'FAILED');assert.equal(retired.ciphertext,null);
   const replay=await first.get('/integrations/shopify/callback').query(firstCallback);assert.equal(replay.status,400);assert.equal(calls.length,before,'The retired browser cannot mint another token');
 });

 await t.test('a new Settings authorization cannot replace another inventory connection',async()=>{
  const f=await business('growth');map[f.owner.workspaceId]=[fixtures[0].shop];process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=JSON.stringify(map);
  const before=calls.length;
  await assert.rejects(require('../../src/connections/postgres-provider-service').beginAuthorization(db,{workspaceId:f.owner.workspaceId,actorId:f.owner.userId},{providerType:'shopify',shop:fixtures[0].shop},'https://app.stockchiefhq.com'),/different inventory/);
  assert.equal(calls.length,before);
 });
 await t.test('an unclaimed handoff cannot overwrite a newer completed connection',async()=>{
  const f=await business('growth');f.shop='other-fixture.myshopify.com';map[f.owner.workspaceId]=[f.shop];process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=JSON.stringify(map);
  await consent(f);await login(f);
  const row=(await db.query("SELECT * FROM shopify_public_installs WHERE shop=$1 AND status='AUTHORIZED'",[f.shop])).rows[0],result=require('../../src/connections/credentials').decrypt(row);
  result.credentials.accessToken='newer-working-grant';
  const pending=require('../../src/connections/authorization-intent').draft(f.owner.workspaceId,f.owner.userId,'shopify',{name:'Shopify',provides:scopes,config:{shopifyProfile:'public',shopifyClientId:'public-app',autoImportCatalog:false,autoImportOpeningStock:false}});
  const id=await require('../../src/connections/postgres-provider-service').finishAuthorization(db,pending,f.owner.userId,result,null,{enforceLaunchPolicy:true}),before=await store.get(db,f.owner.workspaceId,id,'provider');
  const refused=await claim(f);assert.equal(refused.status,400);assert.match(refused.text,/working credentials have been kept/);assert.deepEqual(await store.get(db,f.owner.workspaceId,id,'provider'),before);
 });

 await t.test('public consent, Settings reconnect and refresh use the same store lock',async()=>{
  const f=await business('growth');f.shop='lifecycle-fixture.myshopify.com';map[f.owner.workspaceId]=[f.shop];process.env.STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS=JSON.stringify(map);
  const lifecycle=require('../../src/connections/shopify-token-lifecycle'),service=require('../../src/connections/postgres-provider-service'),lock=lifecycle.key('public-app',f.shop),start=await begin(f),query=callback(start.headers.location),before=calls.length;
  await db.withSessionLock(lock,async()=>{
   const busy=await f.agent.get('/integrations/shopify/callback').query(query);assert.equal(busy.status,400);assert.match(busy.text,/finishing/);assert.equal(calls.length,before);
   assert.equal((await db.query("SELECT status FROM shopify_public_installs WHERE shop=$1",[f.shop])).rows[0].status,'AUTHORIZING','A busy callback remains retryable');
  });
  assert.equal((await f.agent.get('/integrations/shopify/callback').query(query)).status,303);await login(f);assert.equal((await claim(f)).status,303);
  let connection=await require('../../src/connections/postgres-service').get(db,f.owner.workspaceId,(await db.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='shopify'",[f.owner.workspaceId])).rows[0].id);
  const started=await service.beginAuthorization(db,{workspaceId:f.owner.workspaceId,actorId:f.owner.userId},{providerType:'shopify',shop:f.shop,connectorId:connection.id},'https://app.stockchiefhq.com'),reconnectQuery=callback(started.redirectUrl),saved=await store.get(db,f.owner.workspaceId,connection.id,'provider'),callsBefore=calls.length;
  await db.withSessionLock(lock,async()=>{
   await assert.rejects(service.completeOAuth(db,'shopify',reconnectQuery,'https://app.stockchiefhq.com'),/finishing/);assert.equal(calls.length,callsBefore);assert.deepEqual(await store.get(db,f.owner.workspaceId,connection.id,'provider'),saved);
  });
  connection=await service.completeOAuth(db,'shopify',reconnectQuery,'https://app.stockchiefhq.com');
  const expired={...await store.get(db,f.owner.workspaceId,connection.id,'provider'),accessTokenExpiresAt:new Date(Date.now()-1000).toISOString()};await store.put(db,f.owner.workspaceId,connection.id,'provider',expired);
  const refreshBefore=calls.length;
  await db.withSessionLock(lock,async()=>{await assert.rejects(service.loadProviderCredentials(db,connection,adapter),/finishing/);assert.equal(calls.length,refreshBefore);});
  const renewed=await service.loadProviderCredentials(db,connection,adapter);assert.notEqual(renewed.accessToken,expired.accessToken);const refreshedCalls=calls.length;
  assert.deepEqual(await service.loadProviderCredentials(db,connection,adapter),renewed);assert.equal(calls.length,refreshedCalls,'A second read reuses the committed current token');
 });

 await t.test('bare Shopify protocol URLs refuse unsigned and expired flows without provider calls',async()=>{
   const before=calls.length,count=(await db.query('SELECT count(*)::int n FROM shopify_public_installs')).rows[0].n;
   for(const url of ['/integrations/shopify/install','/integrations/shopify/callback','/integrations/shopify/connect']){
     const response=await request(app).get(url);assert([400,401].includes(response.status),url+' must refuse a missing authorization request');assert(!response.text.includes('public-access-'),'An unsigned response must not expose credentials');
   }
   assert.equal(calls.length,before);assert.equal((await db.query('SELECT count(*)::int n FROM shopify_public_installs')).rows[0].n,count);
 });

});
