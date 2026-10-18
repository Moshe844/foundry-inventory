'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http');
const {chromium}=require('playwright');

test('native OAuth returns to the original browser window after the provider severs opener',
 {timeout:180000},async t=>{
 let rejectConsent=false,exchanges=0;
 const provider=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const callback=new URL(url.searchParams.get('redirect_uri'));
  callback.search=new URLSearchParams({state:url.searchParams.get('state'),code:'fixture-consent'}).toString();
  res.writeHead(200,{'content-type':'text/html','cross-origin-opener-policy':'same-origin'});
  res.end('<!doctype html><title>Isolated provider consent</title><a href="'+callback.href+'">Approve fixture connection</a>');
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const adapter={metadata:()=>({type:'shopify',name:'Shopify',available:true,authMode:'oauth',category:'selling',provides:[]}),
  authorizationUrl:({state,input})=>({url:'http://localhost:'+provider.address().port+'/?'+new URLSearchParams({state,redirect_uri:input.redirectUri}),metadata:{}}),
  exchangeAuthorization:async({query})=>{
   assert.equal(query.code,'fixture-consent');exchanges++;
   if(rejectConsent)throw new Error('Fixture consent was not granted.');
   return {credentials:{accessToken:'fixture-token'},capabilities:['read_products'],accountId:crypto.randomUUID(),accountName:'Fixture store'};
  }};
 const registry={get:type=>type==='shopify'?adapter:null,catalog:()=>[adapter.metadata()]};
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID(),connectionProviders:registry,publicOrigin:'request'});
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 const browser=await chromium.launch(),context=await browser.newContext();
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await new Promise(r=>provider.close(r));await app.locals.sessionStore.close();await db.close();cluster.stop();});
 const base='http://127.0.0.1:'+server.address().port,page=await context.newPage(),email=crypto.randomUUID()+'@example.test',errors=[];
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/register');await page.getByLabel('Business name').fill('Popup return fixture');await page.getByLabel('Your name').fill('Fixture owner');await page.getByLabel('Work email').fill(email);
 const password='Test!'+crypto.randomUUID();await page.locator('[name=password]').fill(password);if(await page.locator('[name=confirmPassword]').count())await page.locator('[name=confirmPassword]').fill(password);
 await Promise.all([page.waitForURL(base+'/onboarding'),page.getByRole('button',{name:'Create account'}).click()]);
 const owner=(await db.query('SELECT u.id,u.workspace_id FROM users u JOIN accounts a ON a.id=u.account_id WHERE a.email=$1',[email])).rows[0];
 await page.goto(base+'/settings/connections');
 // Neither a different workspace nor an unsafe return destination may move the host.
 await page.evaluate(workspace=>{
  const c=new BroadcastChannel('foundry:connection-return:'+workspace);
  for(const value of [{workspaceId:'another-workspace',returnPath:'/settings/connections'},
   {workspaceId:workspace,returnPath:'//outside.example.test/'},{workspaceId:workspace,returnPath:'/settings/connections/../logout'}]){
   c.postMessage({type:'foundry:connection-return',connected:true,eventId:'invalid',...value});
  }
  c.close();
 },owner.workspace_id);
 await page.waitForTimeout(250);assert.equal(page.url(),base+'/settings/connections');
 const form=page.locator('form[data-oauth-connect="shopify"]');await form.locator('[name=shop]').fill('popup-fixture.myshopify.com');
 const popupPromise=context.waitForEvent('page');await form.locator('button[type=submit]').click();const popup=await popupPromise;
 await popup.waitForURL('http://localhost:'+provider.address().port+'/**');await popup.waitForLoadState('domcontentloaded');
 assert.equal(await popup.evaluate(()=>window.opener),null,'Real COOP provider must sever the opener');
 const state=(await db.query('SELECT * FROM connection_authorization_states WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[owner.workspace_id])).rows[0];
 assert.equal(JSON.parse(state.metadata).popup,true);assert.equal(state.actor_id,owner.id);
 const completionRequests=[];popup.on('request',r=>{if(r.url().includes('/complete'))completionRequests.push(r.url());});
 const closed=popup.waitForEvent('close');await popup.getByRole('link',{name:'Approve fixture connection'}).click();
 await Promise.all([closed,page.waitForURL(base+'/settings/connections/'+state.connector_id)]);
 assert(completionRequests.some(u=>u.endsWith('/complete?popup=1')),'Persisted popup intent must survive the callback redirect');
 const saved=(await db.query('SELECT status,authorized_by_user_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[owner.workspace_id,state.connector_id])).rows[0];
 assert.equal(saved.status,'connected');assert.equal(saved.authorized_by_user_id,owner.id);assert.equal(exchanges,1);
 // Reloading completion is a saved-state GET, never another token exchange.
 await page.goto(base+'/settings/connections/'+state.connector_id+'/complete');await page.waitForURL(base+'/settings/connections/'+state.connector_id);assert.equal(exchanges,1);
 // A browser that refuses closure must retain a small success card, not load the app in the popup.
 await page.goto(base+'/settings/connections');
 const fallback=await context.newPage();await fallback.addInitScript(()=>{window.close=()=>{};});
 await fallback.goto(base+'/settings/connections/'+state.connector_id+'/complete?popup=1');
 await page.waitForURL(base+'/settings/connections/'+state.connector_id);await fallback.waitForTimeout(2100);
 assert(fallback.url().endsWith('/complete?popup=1'));assert.match(await fallback.locator('[role=status]').innerText(),/You can close this window/);await fallback.close();
 // Declined authorization must stay visible, without redirecting or marking it connected.
 rejectConsent=true;await page.goto(base+'/settings/connections');await form.locator('[name=shop]').fill('popup-fixture.myshopify.com');
 const declinedPromise=context.waitForEvent('page');await form.locator('button[type=submit]').click();const declined=await declinedPromise;
 await declined.waitForURL('http://localhost:'+provider.address().port+'/**');await declined.getByRole('link',{name:'Approve fixture connection'}).click();
 await declined.locator('[data-connected="false"]').waitFor();await declined.waitForTimeout(800);
 assert.equal(page.url(),base+'/settings/connections');assert.equal(declined.isClosed(),false);assert.match(await declined.locator('body').innerText(),/not granted/);await declined.close();
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[owner.workspace_id])).rows[0].n,'0');assert.deepEqual(errors,[]);
});
