'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');

test('real Chromium connects each inventory to its own Stripe account without retaining merchant secrets',
  {timeout:180000},async(context)=>{
    const priorClient=process.env.STRIPE_CONNECT_CLIENT_ID;const priorSecret=process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_CONNECT_CLIENT_ID='ca_fixture_platform';process.env.STRIPE_SECRET_KEY='sk_test_fixture_platform';
    let accountReady=false;let releasedAccount=null;
    const connect={authorizeEndpoint:null,
      async exchange(code){assert.equal(code,'fixture-stripe-code');return {stripe_user_id:'acct_fixture_owner',
        access_token:'sk_test_merchant_secret_that_must_not_be_stored',livemode:false};},
      async readAccount(accountId){assert.equal(accountId,'acct_fixture_owner');return {id:accountId,
        display_name:'Owner Stripe Sandbox',charges_enabled:accountReady,livemode:false};},
      async deauthorize(accountId){releasedAccount=accountId;return {stripe_user_id:accountId};},
    };
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-payments-connect-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-payment-connect-secret',
      paymentOptions:{connect}});
    app.get('/fixture-stripe-consent',(req,res)=>res.send(`<!doctype html><html><body><main>
      <h1>Stripe test authorization</h1><p>Choose Owner Stripe Sandbox.</p>
      <a href="${req.query.redirect_uri}?code=fixture-stripe-code&amp;state=${encodeURIComponent(req.query.state)}">Authorize Stripe account</a>
      </main></body></html>`));
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    connect.authorizeEndpoint=`http://127.0.0.1:${server.address().port}/fixture-stripe-consent`;
    const browser=await chromium.launch({args:['--disable-popup-blocking']});
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();
      if(priorClient===undefined)delete process.env.STRIPE_CONNECT_CLIENT_ID;else process.env.STRIPE_CONNECT_CLIENT_ID=priorClient;
      if(priorSecret===undefined)delete process.env.STRIPE_SECRET_KEY;else process.env.STRIPE_SECRET_KEY=priorSecret;});
    const browserContext=await browser.newContext();const page=await browserContext.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Stripe Owner Business');
    await page.getByLabel('Your name').fill('Stripe Owner');await page.getByLabel('Work email').fill('stripe-owner@example.test');
    await page.getByLabel('Password').fill('stripe-owner-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/settings/connections#payments`);
    assert.match(await page.locator('main').innerText(),/Each inventory uses the business’s own Stripe account/);
    const popupPromise=browserContext.waitForEvent('page');await page.getByRole('link',{name:'Connect existing Stripe account'}).click();
    const popup=await popupPromise;popup.on('pageerror',(error)=>errors.push(`popup: ${error.message}`));
    await popup.waitForURL(/fixture-stripe-consent/);await popup.waitForLoadState('domcontentloaded');
    await popup.getByRole('heading',{name:'Stripe test authorization'}).waitFor();
    assert.equal(await popup.evaluate(()=>Boolean(window.opener)),true);
    await popup.getByRole('link',{name:'Authorize Stripe account'}).click();
    await popup.waitForURL(/\/settings\/connections\/payments\/return/);
    assert.match(await popup.locator('body').innerText(),/Stripe is connected/);
    await popup.waitForEvent('close');
    await page.getByText('Owner Stripe Sandbox',{exact:true}).waitFor();
    assert.match(await page.locator('main').innerText(),/Owner Stripe Sandbox/);
    assert.match(await page.locator('main').innerText(),/Stripe review pending/);
    const ownerAccount=(await database.query(`SELECT p.*,w.name AS workspace_name FROM payment_connect_accounts p
      JOIN workspaces w ON w.id=p.workspace_id`)).rows[0];
    assert.equal(ownerAccount.provider_account_id,'acct_fixture_owner');assert.equal(ownerAccount.workspace_name,'Stripe Owner Business');
    const serialized=JSON.stringify((await database.query(`SELECT row_to_json(row) AS row FROM
      (SELECT * FROM payment_connect_accounts) row`)).rows);
    assert.doesNotMatch(serialized,/merchant_secret|access_token/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM connection_credentials
      WHERE workspace_id=$1`,[ownerAccount.workspace_id])).rows[0].count,'0');

    accountReady=true;
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Check Stripe status'}).click()]);
    assert.match(await page.locator('main').innerText(),/ready to take payments/);
    assert.match(await page.locator('main').innerText(),/confirmed that this business can accept customer payments/);

    const otherContext=await browser.newContext();const other=await otherContext.newPage();
    await other.goto(`${base}/register`);await other.getByLabel('Business name').fill('Other Business');
    await other.getByLabel('Your name').fill('Other Owner');await other.getByLabel('Work email').fill('other-stripe@example.test');
    await other.getByLabel('Password').fill('other-stripe-password');
    await Promise.all([other.waitForURL(`${base}/onboarding`),other.getByRole('button',{name:'Create account'}).click()]);
    await other.goto(`${base}/settings/connections#payments`);
    assert.equal(await other.getByText('Owner Stripe Sandbox').count(),0);
    assert.equal(await other.getByRole('link',{name:'Connect existing Stripe account'}).count(),1);
    await otherContext.close();

    await page.getByRole('button',{name:'Disconnect Stripe'}).click();
    const confirmation=page.getByRole('dialog');await confirmation.waitFor();
    await Promise.all([page.waitForNavigation(),confirmation.getByRole('button',{name:'Disconnect Stripe'}).click()]);
    assert.equal(releasedAccount,'acct_fixture_owner');
    assert.match(await page.locator('main').innerText(),/No payment credential remains in StockChief|grant was released at Stripe/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM payment_connect_accounts
      WHERE workspace_id=$1`,[ownerAccount.workspace_id])).rows[0].count,'0');
    assert.deepEqual(errors,[]);
  });
