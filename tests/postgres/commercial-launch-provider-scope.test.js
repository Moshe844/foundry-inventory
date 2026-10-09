'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {LAUNCH_BLOCKERS}=require('../../src/commercial/release');
const {createPostgresApp}=require('../../src/postgres-app');
const {chromium}=require('playwright');

test('initial monthly self-service snapshots exclude external accounting and merchant payments, not native accounting',
 {timeout:120000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 for(const plan of ['starter','growth','pro']){
  const result=await db.query(`SELECT entitlements FROM commercial_plan_versions
   WHERE plan_id=$1 AND status='ACTIVE'`,[plan]);
  assert.equal(result.rows.length,1);
  const grants=new Map(result.rows[0].entitlements.map(row=>[row.capability,Boolean(row.enabled)]));
  for(const capability of ['connections.accounting','accounting.sync','accounting.post_connected',
   'payments.customer'])assert.equal(grants.get(capability),false,`${plan} ${capability}`);
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
 }
});

test('PostgreSQL launch connection page does not market excluded providers or shared-key shipping',
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
 assert.doesNotMatch(body,/QuickBooks|Xero|Shopify|Clover|Microsoft 365|Set up Stripe for this business/);
 assert.doesNotMatch(body,/Set up shipping for me/);
 assert.match(body,/Connect my carrier accounts/);
 assert.match(body,/StockChief does not buy postage or labels on a shared account/);
 assert.match(body,/WooCommerce/);
});
