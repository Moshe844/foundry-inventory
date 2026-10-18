'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{chromium}=require('playwright');
test('native Shopify permission handoff persists the request, rejects partial consent and returns after verified consent',
 {timeout:180000},async t=>{
 const savedEnv={...process.env},savedFetch=global.fetch,shop='consent-fixture.myshopify.com',writes=['write_products','write_inventory','write_orders','write_fulfillments','write_merchant_managed_fulfillment_orders'];
 process.env.SHOPIFY_CLIENT_ID='shopify-consent-fixture';process.env.SHOPIFY_CLIENT_SECRET='shopify-consent-secret';
 process.env.SHOPIFY_ACCESS_SCOPES_BY_SHOP=JSON.stringify({[shop]:writes});
 let approved=false,calls=0;global.fetch=async(url,options)=>{
   assert.equal(new URL(url).hostname,shop,'The fixture must never call a real provider');
   assert.equal(new URL(url).pathname,'/admin/oauth/access_token');assert.equal(options.method,'POST');calls++;
   return Response.json({access_token:'encrypted-consent-fixture',scope:(approved?[...writes,'read_locations']:['read_products','read_orders','read_locations','read_inventory','read_fulfillments']).join(',')});
 };
 const native=require('../../src/connections/providers/shopify'),adapter={...native,discover:null,registerWebhooks:null};
 const registry={get:type=>type==='shopify'?adapter:null,catalog:()=>[adapter.metadata()]};
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID(),connectionProviders:registry,publicOrigin:'request'});
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch();
 t.after(async()=>{global.fetch=savedFetch;process.env={...savedEnv};await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();await db.close();cluster.stop();});
 const base='http://127.0.0.1:'+server.address().port,page=await browser.newPage(),email=crypto.randomUUID()+'@example.test',errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/register');await page.getByLabel('Business name').fill('Permission handoff');await page.getByLabel('Your name').fill('Permission owner');await page.getByLabel('Work email').fill(email);await page.locator('[name=password]').fill('Test!'+crypto.randomUUID());if(await page.locator('[name=confirmPassword]').count())await page.locator('[name=confirmPassword]').fill(await page.locator('[name=password]').inputValue());await Promise.all([page.waitForURL(base+'/onboarding'),page.getByRole('button',{name:'Create account'}).click()]);
 const owner=(await db.query("SELECT u.workspace_id,u.id FROM users u JOIN accounts a ON a.id=u.account_id WHERE a.email=$1",[email])).rows[0];
 await page.route('https://'+shop+'/admin/oauth/authorize**',async route=>{
   const authorization=new URL(route.request().url()),query={shop,state:authorization.searchParams.get('state'),code:'consent-fixture-code'};
   assert(writes.every(scope=>authorization.searchParams.get('scope').split(',').includes(scope)));
   const hmac=crypto.createHmac('sha256',process.env.SHOPIFY_CLIENT_SECRET).update(Object.keys(query).sort().map(k=>k+'='+query[k]).join('&')).digest('hex'),callback=new URL(authorization.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({...query,hmac}).toString();
   await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Simulated Shopify consent</title><a href="'+callback.href+'">Approve fixture permissions</a>'});
 });
 async function start(){
   await page.goto(base+'/settings/connections');const csrf=await page.locator('input[name=_csrf]').first().inputValue();
   const response=await page.request.post(base+'/settings/connections/shopify/authorize',{form:{_csrf:csrf,shop},maxRedirects:0});assert.equal(response.status(),303);
   const url=response.headers().location,state=(await db.query("SELECT * FROM connection_authorization_states WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1",[owner.workspace_id])).rows[0];
   assert.equal(state.actor_id,owner.id);const metadata=typeof state.metadata==='string'?JSON.parse(state.metadata):state.metadata;assert(writes.every(s=>metadata.requestedScopes.includes(s)));
   await page.goto(url);await page.getByRole('link',{name:'Approve fixture permissions'}).click();return state.connector_id;
 }
 const rejected=await start();assert.match(await page.locator('body').innerText(),/not approved all requested permissions/);assert.equal((await db.query('SELECT count(*) AS n FROM connection_credentials WHERE workspace_id=$1 AND connector_id=$2',[owner.workspace_id,rejected])).rows[0].n,'0');
 approved=true;const accepted=await start();await page.waitForURL(base+'/settings/connections/'+accepted);
 const connection=(await db.query('SELECT status,capabilities FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[owner.workspace_id,accepted])).rows[0];
 assert.equal(connection.status,'connected');const capabilities=typeof connection.capabilities==='string'?JSON.parse(connection.capabilities):connection.capabilities;assert(writes.every(s=>capabilities.includes(s)));
 assert.equal(calls,2);assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[owner.workspace_id])).rows[0].n,'0');assert.deepEqual(errors,[]);
});
