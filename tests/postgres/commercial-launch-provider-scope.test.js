'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {LAUNCH_BLOCKERS}=require('../../src/commercial/release');
const {createPostgresApp}=require('../../src/postgres-app');
const {chromium}=require('playwright');

test('monthly plans preserve native workflows and public checkout isolates private provider access',
 {timeout:120000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 for(const plan of ['starter','growth','pro']){
  const result=await db.query(`SELECT entitlements FROM commercial_plan_versions
   WHERE plan_id=$1 AND status='ACTIVE'`,[plan]);
  assert.equal(result.rows.length,1);
  const grants=new Map(result.rows[0].entitlements.map(row=>[row.capability,Boolean(row.enabled)]));
  assert.equal(grants.get('accounting.core'),true,`${plan} native accounting`);
  assert.equal(grants.get('shipping.workflow'),true,`${plan} manual shipping`);
 }
 const warnings=(await db.query(`SELECT code,status,detail FROM commercial_critical_warnings
  WHERE code=ANY($1::text[])`,[LAUNCH_BLOCKERS])).rows;
 for(const warning of warnings){
  if(['UNVERIFIED_INTUIT_PLATFORM_FEES','UNVERIFIED_XERO_PLATFORM_FEES'].includes(warning.code)){
   assert.equal(warning.status,'RESOLVED');
   assert.equal(warning.detail.disposition,'DISABLED_NOT_MARKETED_AT_LAUNCH');
   assert.equal(warning.detail.costVerified,false,'exclusion must not masquerade as a verified zero rate');
  }
 }
 const priorCheckout=process.env.STOCKCHIEF_CHECKOUT_ENABLED;
 const priorTax=process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX;
 const priorStripeAccount=process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID;
 const priorRuntime=process.env.STOCKCHIEF_RUNTIME_ENV;
 const priorOutlook=process.env.STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES;
 try{
  process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX='false';
  process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID='acct_1UBFTdIjKuQgOJD6';
  await db.query(`UPDATE commercial_release_control SET checkout_enabled=true,
   economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true`);
  await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE code=ANY($1::text[])",
   [LAUNCH_BLOCKERS]);
  process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID='acct_other';
  assert.equal(await require('../../src/commercial/release').isOpen(db),false,
   'account-specific fee evidence must not authorize a different billing account');
  process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID='acct_1UBFTdIjKuQgOJD6';
  assert.equal(await require('../../src/commercial/release').isOpen(db),true,
   'isolated fixture proves the unqualified-connector query is valid when every gate is satisfied');
  async function outlookFixture(email){
   const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,
    {name:'Outlook owner',businessName:'Outlook fixture',email,password:'Outlook-fixture!test2026'});
   await db.query(`INSERT INTO workspace_connectors
    (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,created_at,updated_at)
    VALUES($1,$2,$1,'Outlook fixture','microsoft365','[]','{}','connected',now(),now())`,
    ['outlook:'+owner.workspaceId,owner.workspaceId]);
   return owner.workspaceId;
  }
  process.env.STOCKCHIEF_RUNTIME_ENV='production';
  process.env.STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES=await outlookFixture('release-pilot@example.test');
  assert.equal(await require('../../src/commercial/release').isOpen(db),true,
   'the approved production Outlook pilot remains isolated from public signup');
  const outside=await outlookFixture('outside-release-pilot@example.test');
  assert.equal(await require('../../src/commercial/release').isOpen(db),false,
   'an Outlook connection outside the production pilot still blocks checkout');
  await db.query("UPDATE workspace_connectors SET paused_at=now() WHERE workspace_id=$1",[outside]);
  assert.equal(await require('../../src/commercial/release').isOpen(db),true);
  await db.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
   VALUES('cost-gate-fixture',NULL,'cost-gate-fixture','MISSING_COST_RATE','{}')`);
  assert.equal(await require('../../src/commercial/release').isOpen(db),false,
   'a newly encountered unpriced provider blocks any future checkout activation');
 }finally{
  if(priorCheckout===undefined)delete process.env.STOCKCHIEF_CHECKOUT_ENABLED;
  else process.env.STOCKCHIEF_CHECKOUT_ENABLED=priorCheckout;
  if(priorTax===undefined)delete process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX;
  else process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX=priorTax;
  if(priorStripeAccount===undefined)delete process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID;
  else process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID=priorStripeAccount;
  if(priorRuntime===undefined)delete process.env.STOCKCHIEF_RUNTIME_ENV;
  else process.env.STOCKCHIEF_RUNTIME_ENV=priorRuntime;
  if(priorOutlook===undefined)delete process.env.STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES;
  else process.env.STOCKCHIEF_PRODUCTION_MICROSOFT365_WORKSPACES=priorOutlook;
 }
});

test('PostgreSQL connection page shows excluded providers as unavailable and uses customer shipping accounts',
 {timeout:120000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 await migratePostgres(db);
 const app=createPostgresApp({database:db,env:'test',sessionSecret:'provider-launch-scope-secret'});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const browser=await chromium.launch();
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));
  await app.locals.sessionStore.close();await db.close();cluster.stop();});
 const base=`http://127.0.0.1:${server.address().port}`;const page=await browser.newPage();
 await page.goto(`${base}/register`);
 await page.getByLabel('Business name').fill('Launch Scope Business');
 await page.getByLabel('Your name').fill('Launch Scope Owner');
 await page.getByLabel('Work email').fill('launch-scope@example.test');
 await page.locator('input[name="password"]').fill('launch-scope-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('launch-scope-password');
 await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
 await page.goto(`${base}/settings/connections`);const body=await page.locator('main').innerText();
 assert.match(body,/QuickBooks Online\s+Unavailable/);
 assert.match(body,/Xero\s+Unavailable/);
 assert.match(body,/Shopify\s+Unavailable/);
 assert.match(body,/Clover\s+Unavailable/);
 assert.match(body,/Microsoft 365 \(Outlook\)\s+Unavailable/);
 assert.doesNotMatch(body,/Set up Stripe for this business/);
 assert.doesNotMatch(body,/Set up shipping for me/);
 assert.match(body,/Rates, labels and tracking with your own shipping accounts/);
 assert.match(body,/WooCommerce/);
});
