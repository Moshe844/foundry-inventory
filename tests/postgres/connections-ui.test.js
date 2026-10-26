'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const { chromium }=require('playwright');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');
const credentialStore=require('../../src/connections/postgres-credential-store');

let pushRegistration=null;
let consentOrigin;
const fakeAdapter={
  metadata(){return {type:'fixture_oauth',name:'Fixture Books',mark:'FB',category:'accounting',authMode:'oauth',
    available:true,description:'A test account with read and governed write access.',provides:['accounting evidence']};},
  authorizationUrl({state,input}){const origin=new URL(input.redirectUri).origin;
    return {url:`${consentOrigin}/fixture-provider-consent?callback=${encodeURIComponent(input.redirectUri)}&state=${encodeURIComponent(state)}`,
    metadata:{redirectUri:input.redirectUri}};},
  async exchangeAuthorization({query}){
    assert.equal(query.code,'fixture-code');
    return {credentials:{accessToken:'fixture-secret-token',refreshToken:'fixture-refresh-token'},
      accountId:'fixture-company-1',accountName:'Fixture Company',capabilities:['accounting:read']};
  },
  async registerWebhooks({credentials,webhookUrl}){
    pushRegistration={credentials,webhookUrl};
    return {credentials:{...credentials,deliveryMode:'push',subscriptionId:'fixture-subscription'}};
  },
};
const providers={get(type){return type==='fixture_oauth'?fakeAdapter:null;},catalog(){return [fakeAdapter.metadata()];}};

test('real Chromium qualifies same-tab OAuth return, ownership, encryption, replay safety and disconnect',
  {timeout:180000},async(context)=>{
    const provider=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');res.writeHead(200,{'content-type':'text/html','cross-origin-opener-policy':'same-origin'});res.end(`<!doctype html><main><h1>Fixture Books</h1><p>Authorize StockChief to use Fixture Company.</p><a href="${url.searchParams.get('callback')}?code=fixture-code&amp;state=${encodeURIComponent(url.searchParams.get('state'))}">Authorize Fixture Company</a></main>`);});
    await new Promise(r=>provider.listen(0,'127.0.0.1',r));consentOrigin='http://127.0.0.1:'+provider.address().port;
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-connections-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-connections-secret',
      connectionProviders:providers});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch({args:['--disable-popup-blocking']});
    const browserContext=await browser.newContext();
    context.after(async()=>{
      await browser.close();
      await new Promise((resolve)=>server.close(resolve));
      await new Promise((resolve)=>provider.close(resolve));
      await app.locals.sessionStore.close();
      await database.close();
      cluster.stop();
    });
    const page=await browserContext.newPage();
    await page.setViewportSize({width:1440,height:900});
    const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));
    page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Connection Business');
    await page.getByLabel('Your name').fill('Connection Owner');
    await page.getByLabel('Work email').fill('connection-pg@example.test');
    await page.locator('input[name="password"]').fill('connection-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('connection-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/settings/connections`);
    assert.match(await page.locator('main').innerText(),/Each inventory has its own accounts/);

    const link=page.getByRole('link',{name:'Connect Fixture Books'});
    assert.equal(await link.count(),1);
    const originalLaunch=await link.getAttribute('href');
    assert.notEqual(await link.getAttribute('target'),'_blank','authorization follows the current page');
    await link.click();
    const popup=page;
    await popup.waitForURL(/\/fixture-provider-consent/);
    assert.equal(browserContext.pages().length,1,'ordinary authorization cannot strand a second window');
    assert.match(await popup.locator('main').innerText(),/Authorize StockChief to use Fixture Company/);
    const callbackUrl=await popup.getByRole('link',{name:'Authorize Fixture Company'}).getAttribute('href');
    await popup.getByRole('link',{name:'Authorize Fixture Company'}).click();
    await page.waitForURL(/\/settings\/connections\/con_[a-z0-9]+$/);
    assert.match(await page.locator('main').innerText(),/Fixture Company/);
    assert.match(await page.locator('main').innerText(),/Connected/);

    const connector=(await database.query(`SELECT * FROM workspace_connectors
      WHERE provider_type='fixture_oauth'`)).rows[0];
    assert.ok(connector);
    const savedState=(await database.query('SELECT metadata FROM connection_authorization_states WHERE connector_id=$1',[connector.id])).rows[0];
    assert.equal(JSON.parse(savedState.metadata).popup,false,'same-tab intent survives provider authorization');
    const stored=(await database.query('SELECT * FROM connection_credentials WHERE connector_id=$1',[connector.id])).rows[0];
    assert.ok(stored);
    assert.doesNotMatch(stored.ciphertext,/fixture-secret-token/);
    assert.equal(pushRegistration.credentials.accessToken,'fixture-secret-token');
    assert.equal(pushRegistration.webhookUrl,`${base}/api/v1/connections/fixture_oauth/webhooks/${connector.id}`);
    const decrypted=await credentialStore.get(database,connector.workspace_id,connector.id,'provider');
    assert.equal(decrypted.deliveryMode,'push');assert.equal(decrypted.subscriptionId,'fixture-subscription');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM workspace_connectors
      WHERE provider_type='fixture_oauth'`)).rows[0].count,'1');

    await page.goto(base+originalLaunch);await page.waitForURL(base+'/settings/connections');
    assert.match(await page.locator('[data-flash-stack]').innerText(),/connection link expired/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM workspace_connectors WHERE provider_type='fixture_oauth'`)).rows[0].count,'1','a consumed launch never repeats provider authorization');
    await page.goto(base+'/settings/connections/'+connector.id);

    const replay=await page.request.get(callbackUrl);
    assert.equal(replay.status(),400);
    assert.match(await replay.text(),/expired or was already used/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM workspace_connectors
      WHERE provider_type='fixture_oauth'`)).rows[0].count,'1');

    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Disconnect and remove credentials'}).click()]);
    assert.match(await page.locator('main').innerText(),/Disconnected/);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM connection_credentials WHERE connector_id=$1',
      [connector.id])).rows[0].count,'0');
    assert.deepEqual(errors,[]);
  });
