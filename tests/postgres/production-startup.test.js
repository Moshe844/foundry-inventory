'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { startCluster }=require('../helpers/postgres-cluster');
const { startPostgresWeb,validateProductionEnvironment }=require('../../src/postgres-web-server');

test('production PostgreSQL startup fails closed without stable shared secrets and an HTTPS origin',()=>{
  const production={env:'production',publicOrigin:'https://stockchief.test',sessionSecret:'s'.repeat(32),
    encryptionKey:'e'.repeat(32),releaseRef:'release-1',billingSecretKey:'sk_live_contract',
    billingWebhookSecret:'whsec_contract',emailApiKey:'re_contract',fromEmail:'StockChief <operations@stockchief.test>',
    supportEmail:'support@stockchief.test'};
  assert.throws(()=>validateProductionEnvironment({env:'production',publicOrigin:'http://stockchief.test',
    sessionSecret:'short',encryptionKey:'short',releaseRef:'release-1'}),/HTTPS FOUNDRY_PUBLIC_URL/);
  assert.throws(()=>validateProductionEnvironment({...production,sessionSecret:'short'}),/SESSION_SECRET/);
  assert.throws(()=>validateProductionEnvironment({...production,encryptionKey:'short'}),/CONNECTION_ENCRYPTION_KEY/);
  assert.throws(()=>validateProductionEnvironment({...production,releaseRef:'development'}),/RELEASE_REF/);
  assert.throws(()=>validateProductionEnvironment({...production,billingSecretKey:null}),/BILLING_STRIPE_SECRET_KEY/);
  assert.throws(()=>validateProductionEnvironment({...production,billingWebhookSecret:null}),/BILLING_STRIPE_WEBHOOK_SECRET/);
  assert.throws(()=>validateProductionEnvironment({...production,emailApiKey:null}),/RESEND_API_KEY/);
  assert.throws(()=>validateProductionEnvironment({...production,fromEmail:null}),/FOUNDRY_FROM_EMAIL/);
  assert.throws(()=>validateProductionEnvironment({...production,supportEmail:null}),/FOUNDRY_SUPPORT_EMAIL/);
  assert.doesNotThrow(()=>validateProductionEnvironment(production));
  assert.doesNotThrow(()=>validateProductionEnvironment({...production,sessionSecret:null,requireSession:false}));
  assert.doesNotThrow(()=>validateProductionEnvironment({...production,requirePaidWorkspace:false,
    billingSecretKey:null,billingWebhookSecret:null}));
});

test('production launcher migrates PostgreSQL and serves shared multi-writer readiness',{timeout:120000},async(context)=>{
  const cluster=await startCluster();
  const runtime=await startPostgresWeb({connectionString:cluster.connectionString,env:'test',port:0,host:'127.0.0.1',
    sessionSecret:'postgres-startup-secret',installSignalHandlers:false});
  context.after(async()=>{await runtime.close('test');cluster.stop();});
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const health=await fetch(`${base}/healthz`);assert.equal(health.status,200);
  assert.equal((await health.json()).database,'postgresql');
  const readiness=await fetch(`${base}/readyz`);assert.equal(readiness.status,200);
  const payload=await readiness.json();
  assert.equal(payload.ok,true);assert.equal(payload.database,'postgresql');
  assert.equal(payload.shared,true);assert.equal(payload.multiWriter,true);
  assert.equal(payload.migrations,Number((await runtime.database.query(
    'SELECT COUNT(*) AS n FROM stockchief_postgres_migrations')).rows[0].n));
  assert.ok(payload.migrations>=41);assert.equal(payload.deadJobs,0);assert.equal(payload.staleJobs,0);
  assert.equal(payload.commercialTelemetry.persistenceFailures,0);
});

test('private production pilot closes self-registration and requires a real plan without billing credentials',
  {timeout:120000}, async t=>{
    const f=await require('../helpers/agent-workflow-fixture').fixture(t);
    const {db,browser}=f;
    const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_PRIVATE_PRODUCTION_PILOT','STOCKCHIEF_CHECKOUT_ENABLED','STOCKCHIEF_REQUIRE_PAID_WORKSPACE'];
    const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
    t.after(()=>{
      for(const key of keys){
        if(prior[key]===undefined)delete process.env[key];
        else process.env[key]=prior[key];
      }
    });
    Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',STOCKCHIEF_PRIVATE_PRODUCTION_PILOT:'1',
      STOCKCHIEF_CHECKOUT_ENABLED:'false',STOCKCHIEF_REQUIRE_PAID_WORKSPACE:'true'});
    const production={env:'production',publicOrigin:'https://app.example.test',sessionSecret:'s'.repeat(32),
      encryptionKey:'e'.repeat(32),releaseRef:'release-1',billingSecretKey:null,billingWebhookSecret:null,emailApiKey:'re_fixture',
      fromEmail:'notifications@example.test',supportEmail:'support@example.test'};
    assert.doesNotThrow(()=>validateProductionEnvironment(production));
    assert.throws(()=>validateProductionEnvironment({...production,requirePaidWorkspace:false}),/normal plan enforcement/);
    process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';
    assert.throws(()=>validateProductionEnvironment(production),/closed checkout/);
    process.env.STOCKCHIEF_CHECKOUT_ENABLED='false';
    assert.equal(await require('../../src/commercial/release').isSubscriptionCheckoutOpen(db),false);
    const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'pilot-fixture-secret'});
    t.after(()=>app.locals.sessionStore.close());
    const guest=require('supertest').agent(app);
    const login=await guest.get('/login').expect(200),csrf=f.csrf(login.text);
    const denied=await guest.get('/register?plan=starter').expect(403);
    assert.match(denied.text,/StockChief is in a private pilot/);
    const rejectedEmail='uninvited-production@example.test';
    await guest.post('/register').set('Accept','application/json').type('form').send({_csrf:csrf,email:rejectedEmail,name:'Uninvited',businessName:'Uninvited',
      password:'Strong-fixture-secret-41!',planId:'starter'}).expect(403);
    assert.equal((await db.query('SELECT 1 FROM accounts WHERE email=$1',[rejectedEmail])).rowCount,0);

    await f.subscribe('starter');
    await browser.get('/inventory').expect(200);
    const form=await browser.get('/settings/billing').expect(200);
    await browser.post('/complete-signup/trial').set('Accept','application/json').type('form').send({_csrf:f.csrf(form.text)}).expect(403);

    const pilot=require('../../scripts/provision-private-production-pilot');
    const entitlements=require('../../src/commercial/entitlements');
    const expires=new Date(Date.now()+30*86400000).toISOString();
    for(const plan of ['starter','growth','pro','enterprise']){
      const input={plan,expires,email:`pilot-${plan}@example.test`,name:`Pilot ${plan}`,
        business:`Pilot ${plan} inventory`,reason:'Verified private-pilot test'};
      const created=await pilot.provision(db,input);
      const subscription=await entitlements.subscriptionFor(db,created.accountId);
      assert.equal(subscription.plan_id,plan);
      const state=await require('../../src/commercial/agent-plan').accountState(db,created.workspaceId);
      assert.equal(state.plan,plan);
      assert.equal(require('../../src/commercial/agent-plan').usesAgentTerms(state),true);
      assert.equal(subscription.stripe_subscription_id,null);
      assert.equal(entitlements.operationalAccess(subscription).canOperate,true);
      assert.equal(entitlements.operationalAccess(subscription,new Date(Date.parse(expires)+1000)).canOperate,false);
      const account=(await db.query('SELECT plan,email_verified_at FROM accounts WHERE id=$1',[created.accountId])).rows[0];
      assert.equal(account.plan,'paid');
      assert.equal(account.email_verified_at,null);
      assert.equal((await db.query('SELECT 1 FROM users WHERE workspace_id=$1 AND account_id=$2 AND role=$3',
        [created.workspaceId,created.accountId,'owner'])).rowCount,1);
      await assert.rejects(pilot.provision(db,input),/already uses that email/);
    }
    process.env.STOCKCHIEF_RUNTIME_ENV='staging';
    await assert.rejects(pilot.provision(db,{}),/private production pilot/);
    assert.throws(()=>validateProductionEnvironment(production),/BILLING_STRIPE_SECRET_KEY/);
    await guest.get('/register?plan=starter').expect(200);
  });
