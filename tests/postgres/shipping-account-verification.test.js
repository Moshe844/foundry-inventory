'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('the real shipping connection route verifies test keys inside the tenant commercial scope',{timeout:180000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster();
  const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const email=randomUUID()+'@example.test',password='Fixture!'+randomUUID();
  const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Account access',email,password});
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'shipping-verification-fixture'});
  const server=await new Promise(resolve=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
  const browser=await require('playwright').chromium.launch();
  const originalFetch=global.fetch,originalDatabase=process.env.FOUNDRY_DATABASE_URL;
  t.after(async()=>{global.fetch=originalFetch;if(originalDatabase===undefined)delete process.env.FOUNDRY_DATABASE_URL;else process.env.FOUNDRY_DATABASE_URL=originalDatabase;
    await browser.close();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();await db.close();await cluster.stop();});
  process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
  const calls=[];
  global.fetch=async(url,input={})=>{
    const parsed=new URL(String(url)),context=require('../../src/commercial/context').current();
    assert.equal(context?.scope?.workspaceId,owner.workspaceId);assert.equal(context?.funded,true);
    assert.equal(String(input.method||'GET'),'GET');
    assert(['api.easypost.com','api.shipstation.com','api.goshippo.com'].includes(parsed.hostname));
    const allowed={ 'api.easypost.com':'/v2/shipments','api.shipstation.com':'/v2/carriers','api.goshippo.com':'/carrier_accounts/'};
    assert.equal(parsed.pathname,allowed[parsed.hostname],'verification uses a test-compatible read endpoint');
    calls.push({host:parsed.hostname,workspace:context.scope.workspaceId});
    return new Response(JSON.stringify({shipments:[],carriers:[],results:[]}),{status:200,headers:{'content-type':'application/json'}});
  };
  const page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;
  await page.goto(base+'/login');await page.locator('input[name=email]').fill(email);await page.locator('input[name=password]').fill(password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  for(const [provider,key]of [['easypost','EZTK_account_fixture'],['shipstation','TEST_account_fixture'],['shippo','shippo_test_account_fixture']]){
    await page.goto(base+'/settings/shipping');await page.locator('#existing-carrier-connection > summary').click();
    await page.getByLabel('Shipping platform',{exact:true}).selectOption(provider);await page.getByLabel('API key',{exact:true}).fill(key);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Verify and connect',exact:true}).click()]);
    const connected=await require('../../src/shipping/postgres-accounts').describe(db,owner.workspaceId,{provider});
    assert.equal(connected.connected,true,provider+' must connect through the actual provider verifier');assert.equal(connected.testMode,true);
    assert(!((await page.locator('main').innerText()).includes(key)));
  }
  assert.equal(calls.length,3);assert.equal((await require('../../src/shipping/postgres-accounts').describeAll(db,owner.workspaceId)).length,3);
  assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[owner.workspaceId])).rows[0].n,0);
  t.diagnostic('Real local browser/PostgreSQL and actual adapter HTTP code; external HTTP responses simulated.');
});
