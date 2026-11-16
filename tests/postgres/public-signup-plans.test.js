'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {startCluster} = require('../helpers/postgres-cluster');
const {openPostgres} = require('../../src/db/postgres');
const {migratePostgres} = require('../../src/db/migrate-postgres');
const {createPostgresApp} = require('../../src/postgres-app');
const commercial = require('../../src/commercial/service');
const release = require('../../src/commercial/release');
const entitlements = require('../../src/commercial/entitlements');
const email = require('../../src/operations/email');
const {accountId: stripeAccountId} = require('../../src/commercial/stripe-live-fee-evidence');

test('public pricing sends all monthly and yearly plans through verified paid signup',
  {timeout: 180000}, async t => {
    const env = {
      STOCKCHIEF_RUNTIME_ENV: 'production',
      STOCKCHIEF_PRIVATE_PRODUCTION_PILOT: '0',
      STOCKCHIEF_CHECKOUT_ENABLED: 'true',
      STOCKCHIEF_REQUIRE_PAID_WORKSPACE: 'true',
      STOCKCHIEF_BILLING_AUTOMATIC_TAX: 'false',
      STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID: stripeAccountId,
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    const cluster = await startCluster();
    const db = openPostgres(cluster.connectionString);
    let app, server, browser;
    t.after(async () => {
      try {
        await browser?.close();
        if (server) await new Promise(resolve => server.close(resolve));
        await app?.locals.sessionStore.close();
      } finally {
        await db.close();
        await cluster.stop();
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
    await migratePostgres(db);

    const tiers = [['starter', 'Starter', 199], ['growth', 'Growth', 499], ['pro', 'Pro', 999]];
    for (const [id] of tiers) {
      await db.query(`UPDATE commercial_plans SET stripe_monthly_price_id=$2, stripe_annual_price_id=$3
        WHERE id=$1`, [id, `price_${id}_monthly_fixture`, `price_${id}_annual_fixture`]);
    }
    await db.query(`UPDATE commercial_release_control SET checkout_enabled=true,
      economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true`);
    await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE code=ANY($1::text[])", [release.LAUNCH_BLOCKERS]);
    assert.equal(await release.isOpen(db), true);

    const sessions = new Map();
    const provider = {
      async retrievePrice(id) {
        for (const [plan, _name, monthly] of tiers) {
          if (id === `price_${plan}_monthly_fixture`) return {id, active: true, type: 'recurring',
            currency: 'usd', unit_amount: monthly * 100, recurring: {interval: 'month'}};
          if (id === `price_${plan}_annual_fixture`) return {id, active: true, type: 'recurring',
            currency: 'usd', unit_amount: monthly * 1000, recurring: {interval: 'year'}};
        }
        throw new Error('Unexpected Stripe price in signup rehearsal');
      },
      async createCheckout(input) {
        const id = `cs_${input.accountId}`;
        const now = Math.floor(Date.now() / 1000);
        const interval = input.priceId.includes('_annual_') ? 'year' : 'month';
        const subscription = {
          id: `sub_${input.accountId}`, customer: `cus_${input.accountId}`, status: 'active',
          current_period_start: now, current_period_end: now + (interval === 'year' ? 365 : 30) * 86400,
          metadata: {stockchief_account_id: input.accountId},
          items: {data: [{price: {id: input.priceId, recurring: {interval}}}]},
        };
        sessions.set(id, {id, input, subscription, status: 'complete', payment_status: 'paid',
          metadata: {stockchief_account_id: input.accountId, stockchief_plan_id: input.planId}});
        await commercial.handleBillingEvent(db, {id: `evt_${input.accountId}`, type: 'customer.subscription.created', created: now,
          data: {object: subscription}});
        return {id, url: input.successUrl.replace('{CHECKOUT_SESSION_ID}', id)};
      },
      retrieveCheckout: async id => sessions.get(id),
      listInvoices: async () => ({data: []}),
    };
    app = createPostgresApp({database: db, env: 'test', sessionSecret: 'public-plan-browser-fixture',
      commercialOptions: {billingProvider: provider, loadInvoices: false, publicOrigin: 'request'}});
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    browser = await chromium.launch();
    const base = `http://127.0.0.1:${server.address().port}`;

    for (const [plan, name, monthly] of tiers) {
      for (const interval of ['monthly', 'annual']) {
        await t.test(`${name} ${interval} signup and activation`, async subtest => {
          const session = await browser.newContext({viewport: interval === 'annual'
            ? {width: 390, height: 900} : {width: 1440, height: 950}});
          subtest.after(() => session.close());
          const page = await session.newPage();
          page.setDefaultTimeout(8000);
          page.setDefaultNavigationTimeout(15000);
          const price = monthly * (interval === 'annual' ? 10 : 1);
          const priceText = '$' + price.toLocaleString('en-US');
          const address = `${plan}-${interval}@example.test`;
          await page.goto(`${base}/pricing?interval=${interval}`);
          const link = page.getByRole('link', {name: `Choose ${name}`, exact: true});
          assert.equal(await link.getAttribute('href'), `/register?plan=${plan}&interval=${interval}`);
          assert.equal(await page.locator(`#${plan} .plan-price strong`).innerText(), priceText);
          assert.equal(await page.getByRole('link', {name: /request pilot access/i}).count(), 0);
          await link.click();
          assert.equal(await page.locator('input[name="planId"]:checked').inputValue(), plan);
          assert.equal(await page.locator('select[name="interval"]').inputValue(), interval);
          await page.getByLabel('Business name').fill(`${name} signup rehearsal`);
          await page.getByLabel('Your name').fill('Launch test owner');
          await page.getByLabel('Work email').fill(address);
          await page.getByLabel('Business time zone').fill('America/New_York');
          const password = `Browser-${plan}-${interval}-fixture!48`;
          await page.locator('#password').fill(password);
          await page.locator('#confirmPassword').fill(password);
          await Promise.all([page.waitForURL(`${base}/verify-email/pending`),
            page.getByRole('button', {name: 'Create account and verify email'}).click()]);
          const account = (await db.query('SELECT id,email_verified_at FROM accounts WHERE email=$1', [address])).rows[0];
          assert.ok(account);
          assert.equal(account.email_verified_at, null);
          const workspaceCount = async () => (await db.query('SELECT count(*)::int n FROM workspaces WHERE owner_account_id=$1', [account.id])).rows[0].n;
          assert.equal(await workspaceCount(), 0);
          const receipt = (await db.query(`SELECT job.payload FROM stockchief_runtime.jobs job
            JOIN account_email_verifications verification ON job.idempotency_key='email-verification:'||verification.id
            WHERE job.kind='system.email-send' AND verification.account_id=$1 AND verification.used_at IS NULL`, [account.id])).rows[0];
          assert.ok(receipt, 'account verification must use the transactional email queue');
          const token = new URL(email.unseal(receipt.payload).text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
          assert.ok(token);
          await page.goto(`${base}/verify-email?token=${encodeURIComponent(token)}`);
          await page.getByRole('button', {name: 'Verify and continue'}).click();
          assert.equal(await page.locator('select[name="planId"]').inputValue(), plan);
          assert.equal(await page.locator('select[name="interval"]').inputValue(), interval);
          assert.equal(await workspaceCount(), 0);
          await Promise.all([page.waitForURL(`${base}/onboarding`),
            page.getByRole('button', {name: 'Continue to secure checkout'}).click()]);
          const checkout = sessions.get(`cs_${account.id}`);
          assert.equal(checkout.input.planId, plan);
          assert.equal(checkout.input.priceId, `price_${plan}_${interval}_fixture`);
          const subscription = await entitlements.subscriptionFor(db, account.id);
          assert.equal(subscription.status, 'ACTIVE');
          assert.equal(subscription.plan_id, plan);
          assert.equal(subscription.billing_interval, interval.toUpperCase());
          assert.equal(await workspaceCount(), 1);
        });
      }
    }
  });
