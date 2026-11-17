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
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID(),connectionPublicOrigin:'https://app.stockchiefhq.com'});
 const auth=require('../../src/domain/postgres-auth-service'),ent=require('../../src/commercial/entitlements'),adapter=require('../../src/connections/providers/shopify'),store=require('../../src/connections/postgres-credential-store');
 const calls=[],scopes=['read_orders','read_products','read_locations','read_inventory','read_fulfillments','write_products','write_inventory'];
 global.fetch=async(value,options)=>{
   const url=new URL(value);assert.match(url.hostname,/^(?:browser-)?(starter|growth|pro|legacy|other|denied|full)-fixture\.myshopify\.com$/,'Only synthetic providers are contacted');
   calls.push({path:url.pathname,body:options.body});
   if(url.pathname==='/admin/oauth/access_token'){
     const form=new URLSearchParams(options.body);assert.equal(form.get('client_id'),'public-app');assert.equal(form.get('client_secret'),'public-secret');
     if(form.has('code'))assert.equal(form.get('expiring'),'1');else assert.equal(form.get('grant_type'),'refresh_token');
     return Response.json({access_token:'public-access-'+calls.length,refresh_token:'public-refresh-'+calls.length,expires_in:3600,refresh_token_expires_in:7776000,scope:scopes.join(',')});
   }
   const body=JSON.parse(options.body);
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
   assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[f.owner.workspaceId])).rows[0].n,0,'Authorization does not import starting stock');
   const rawBody=Buffer.from('{"id":42}'),headers={'x-shopify-shop-domain':f.shop,'x-shopify-hmac-sha256':crypto.createHmac('sha256','public-secret').update(rawBody).digest('base64')};
   adapter.verifyWebhook({headers,rawBody,credentials:grant,connection:{...connection,config}});
   assert.throws(()=>adapter.verifyWebhook({headers:{...headers,'x-shopify-hmac-sha256':crypto.createHmac('sha256','legacy-secret').update(rawBody).digest('base64')},rawBody,credentials:grant,connection:{...connection,config}}),/signature verification/);
   const refreshed=await adapter.refreshCredentials({...grant,accessTokenExpiresAt:new Date(Date.now()-1).toISOString()});assert.equal(refreshed.refreshed,true);assert.equal(refreshed.credentials.shopifyClientId,'public-app');
   const beforeReopen=calls.length,reopen=await begin(f);assert.equal(reopen.headers.location,'/integrations/shopify/connect');const opened=await claim(f);assert.equal(opened.headers.location,connected.headers.location);assert.equal(calls.length,beforeReopen,'Reopening does not replace its working token or register duplicate hooks');
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
   const rawBody=Buffer.from('{}'),headers={'x-shopify-shop-domain':grant.shop,'x-shopify-hmac-sha256':crypto.createHmac('sha256','legacy-secret').update(rawBody).digest('base64')};adapter.verifyWebhook({headers,rawBody,credentials:grant});
 });
 await t.test('restricted users and cross-account claims cannot link a store',async()=>{
   const f=fixtures[2];await consent(f,'denied-fixture.myshopify.com');
   assert.equal((await claim(f,fixtures[1].owner.workspaceId)).status,400);
   await db.query("UPDATE users SET role='staff' WHERE id=$1",[f.owner.userId]);const denied=await claim(f);assert.equal(denied.status,400);assert.match(denied.text,/inventory you own|current inventory owner/);await db.query("UPDATE users SET role='owner' WHERE id=$1",[f.owner.userId]);
   await db.query('UPDATE shopify_public_installs SET expires_at=now()-interval \'1 second\' WHERE shop=$1',['denied-fixture.myshopify.com']);assert.equal((await f.agent.get('/integrations/shopify/connect')).status,400);
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

 await t.test('bare Shopify protocol URLs refuse unsigned and expired flows without provider calls',async()=>{
   const before=calls.length,count=(await db.query('SELECT count(*)::int n FROM shopify_public_installs')).rows[0].n;
   for(const url of ['/integrations/shopify/install','/integrations/shopify/callback','/integrations/shopify/connect']){
     const response=await request(app).get(url);assert.equal(response.status,400,url);assert.match(response.headers['cache-control'],/no-store/);assert.match(response.text,/Shopify/);
   }
   assert.equal(calls.length,before);assert.equal((await db.query('SELECT count(*)::int n FROM shopify_public_installs')).rows[0].n,count);
 });

});
