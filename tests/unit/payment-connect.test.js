'use strict';

/*
 * A business connects its Stripe account without handing over a key.
 *
 * The form beside this one works and is staying, but what it asks for is a
 * Stripe secret key — total access to somebody else's account: refunds,
 * payouts, every customer record, for as long as the key lives, with no way
 * for them to see what used it. That is far more than making an invoice needs,
 * and the merchants who understand what is being asked will refuse.
 *
 * These are the claims that make the other path worth having:
 *
 *   1. StockChief ends up holding an account id and no secret — and the access
 *      token Stripe hands over in the exchange is deliberately thrown away.
 *   2. The invoice is still made on the merchant's account, through the
 *      platform key and Stripe's own act-on-behalf-of header.
 *   3. One business's account never reaches another's order.
 *   4. Connected but unable to take charges is said out loud, not hidden
 *      behind a tick.
 *   5. Access withdrawn at Stripe is noticed here rather than failing later.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const connect = require('../../src/payments/connect');
const accounts = require('../../src/payments/accounts');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

const PLATFORM_KEY = 'sk_test_platform_0000';

/*
 * The platform's registration is an environment fact, and a developer's own
 * .env is not part of the test either way.
 */
function asPlatform(run, enrolled = true) {
  const held = { id: process.env.STRIPE_CONNECT_CLIENT_ID, key: process.env.STRIPE_SECRET_KEY };
  if (enrolled) {
    process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_pretend_platform';
    process.env.STRIPE_SECRET_KEY = PLATFORM_KEY;
  } else {
    delete process.env.STRIPE_CONNECT_CLIENT_ID;
    delete process.env.STRIPE_SECRET_KEY;
  }
  const restore = () => {
    for (const [name, value] of [['STRIPE_CONNECT_CLIENT_ID', held.id], ['STRIPE_SECRET_KEY', held.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    const out = run();
    return out && typeof out.then === 'function' ? out.finally(restore) : (restore(), out);
  } catch (error) { restore(); throw error; }
}

function setup(name) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: name || 'HalFi Shoes' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, ctx: workspace.ctx, membership };
}

/*
 * Stripe, standing still. `granted` is the OAuth token response, and it
 * carries an access token on purpose: the point of the first test is that
 * StockChief is handed one and does not keep it.
 */
function stripeStub(options = {}) {
  const state = { exchanged: [], deauthorized: [], read: [] };
  return {
    state,
    async exchange(input) {
      state.exchanged.push(input);
      return {
        stripe_user_id: options.accountId || 'acct_merchant_1',
        access_token: 'sk_live_a_working_key_for_their_account',
        refresh_token: 'rt_should_never_be_stored',
        livemode: options.liveMode !== false,
        scope: 'read_write',
      };
    },
    async readAccount(id) {
      state.read.push(id);
      if (options.readThrows) throw options.readThrows;
      return {
        id,
        charges_enabled: options.chargesEnabled !== false,
        livemode: options.liveMode !== false,
        business_profile: { name: options.name || 'HalFi Shoes' },
      };
    },
    async deauthorize(id) { state.deauthorized.push(id); },
  };
}

/** Walk the merchant through Stripe and back, as the routes do. */
async function grantAccess(env, stripe, options = {}) {
  const begun = connect.authorizeUrl(env.db, env.ctx, env.membership,
    { returnUri: 'https://foundry.test/settings/connections/payments/return' });
  return { begun, done: await connect.complete(env.db,
    { code: options.code || 'ac_from_stripe', state: begun.state },
    { exchange: stripe.exchange, readAccount: stripe.readAccount }) };
}

test('the key Stripe hands over is thrown away, and an account id is kept', () => asPlatform(async () => {
  const env = setup();
  const stripe = stripeStub();

  assert.equal(connect.describe(env.db, env.workspace.workspaceId).connected, false);

  const { begun, done } = await grantAccess(env, stripe);
  assert.match(begun.url, /^https:\/\/connect\.stripe\.com\/oauth\/authorize\?/);
  assert.match(begun.url, /client_id=ca_pretend_platform/);
  assert.match(begun.url, /scope=read_write/);
  assert.ok(!new URL(begun.url).searchParams.has('stripe_user[email]'),
    'StockChief does not prefill a local/test login address into Stripe');
  assert.equal(done.connected, true);
  assert.equal(done.accountId, 'acct_merchant_1');

  /*
   * The claim the whole feature rests on. The exchange returned a working key
   * for this merchant's account, and it is nowhere.
   */
  const everything = env.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
    .map((row) => row.name)
    .map((table) => JSON.stringify(env.db.prepare(`SELECT * FROM "${table}"`).all()))
    .join('');
  assert.ok(!everything.includes('sk_live_a_working_key_for_their_account'),
    'the access token Stripe handed over is not stored anywhere in the database');
  assert.ok(!everything.includes('rt_should_never_be_stored'),
    'and neither is the refresh token');

  const described = accounts.describe(env.db, env.workspace.workspaceId);
  assert.equal(described.source, 'connect');
  assert.equal(described.connected, true);
  assert.equal(described.chargesEnabled, true);
  env.db.close();
}));

test('the invoice is made on their account, through permission rather than a key', () => asPlatform(async () => {
  /*
   * The adapter is given the platform's key and the merchant's account id, and
   * turns that into Stripe's act-on-behalf-of header — which is what puts the
   * customer, the invoice and the money on their account.
   */
  const env = setup();
  await grantAccess(env, stripeStub());

  const ctx = accounts.contextFor(env.db, env.ctx);
  assert.equal(ctx.stripeSecretKey, PLATFORM_KEY, 'the platform key does the talking');
  assert.equal(ctx.stripeAccountId, 'acct_merchant_1', 'on the merchant\'s behalf');

  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers });
    return { ok: true, status: 200, json: async () => ({ id: 'cus_1' }) };
  };
  try {
    await require('../../src/payments/providers/stripe')
      .createCustomer(ctx, { name: 'Moshe Ekstein', email: 'motty@example.test' });
  } finally { global.fetch = realFetch; }

  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['Stripe-Account'], 'acct_merchant_1');
  assert.match(sent[0].headers.Authorization, new RegExp(PLATFORM_KEY));
  env.db.close();
}));

test('one business account never reaches another business order', () => asPlatform(async () => {
  const { db } = makeDatabase();
  const one = seedWorkspace(db, { workspaceName: 'Shop One' });
  const two = seedWorkspace(db, { workspaceName: 'Shop Two' });
  const oneEnv = { db, ctx: one.ctx, workspace: one,
    membership: authService.getMembership(db, one.workspaceId, one.accountId) };
  const twoEnv = { db, ctx: two.ctx, workspace: two,
    membership: authService.getMembership(db, two.workspaceId, two.accountId) };

  await grantAccess(oneEnv, stripeStub({ accountId: 'acct_one', name: 'Shop One' }));
  await grantAccess(twoEnv, stripeStub({ accountId: 'acct_two', name: 'Shop Two' }));

  assert.equal(accounts.contextFor(db, one.ctx).stripeAccountId, 'acct_one');
  assert.equal(accounts.contextFor(db, two.ctx).stripeAccountId, 'acct_two');

  /*
   * And an event about one account is placed by the account it names, which is
   * how Stripe delivers every connected business to one endpoint.
   */
  const { inventoryForEvent } = require('../../src/web/routes/payments');
  assert.equal(inventoryForEvent(db, 'stripe', { id: 'evt_1', account: 'acct_two' }, null),
    two.workspaceId);
  assert.equal(inventoryForEvent(db, 'stripe', { id: 'evt_2', account: 'acct_one' }, null),
    one.workspaceId);
  db.close();
}));

test('connected but not taking charges is said, not hidden behind a tick', () => asPlatform(async () => {
  /*
   * Stripe often connects an account before it will accept a payment on it —
   * details outstanding, a verification pending. A payment link made against
   * that account fails in front of a customer, which is the worst place to
   * find out.
   */
  const env = setup();
  const { done } = await grantAccess(env, stripeStub({ chargesEnabled: false }));
  assert.equal(done.connected, true);
  assert.equal(done.chargesEnabled, false);
  assert.match(done.because, /not accepting charges/i);
  assert.match(accounts.describe(env.db, env.workspace.workspaceId).because, /not accepting charges/i);

  // And it stops saying so once Stripe is satisfied.
  const settled = await connect.refresh(env.db, env.workspace.workspaceId,
    { readAccount: stripeStub().readAccount });
  assert.equal(settled.chargesEnabled, true);
  assert.equal(settled.because, null);
  env.db.close();
}));

test('access withdrawn at Stripe is noticed here rather than failing later', () => asPlatform(async () => {
  /*
   * The merchant can revoke from their own dashboard, and should be able to —
   * it is the thing a pasted key never allowed. StockChief finds out by being
   * refused, and the honest answer is to stop claiming a connection.
   */
  const env = setup();
  await grantAccess(env, stripeStub());

  const gone = Object.assign(new Error('No such account'), { status: 401 });
  const after = await connect.refresh(env.db, env.workspace.workspaceId,
    { readAccount: async () => { throw gone; } });

  assert.equal(after.connected, false);
  assert.equal(connect.rowFor(env.db, env.workspace.workspaceId), null);
  env.db.close();
}));

test('disconnecting hands the grant back to Stripe', () => asPlatform(async () => {
  const env = setup();
  const stripe = stripeStub();
  await grantAccess(env, stripe);

  const released = await accounts.disconnect(env.db, env.ctx, env.membership,
    { deauthorize: stripe.deauthorize });
  assert.deepEqual(stripe.state.deauthorized, ['acct_merchant_1'],
    'so the business dashboard stops listing StockChief too');
  assert.equal(released.connected, false);
  env.db.close();
}));

test('the platform key is not quietly a till for every unconnected inventory', () => asPlatform(() => {
  /*
   * The bug this test exists for was never written by anybody. It followed
   * from two reasonable things being true at once.
   *
   * The server key was a fallback for a single-tenant install: one key, one
   * shop, nothing to click through. Connect then makes that same key the
   * platform's own identity — it has to be set for any business to connect at
   * all — and at that moment the fallback silently means "every inventory that
   * has not connected yet takes its customers' money into Keeper's bank".
   *
   * The first anybody would know is a shop's takings arriving somewhere else.
   */
  const env = setup();
  assert.ok(process.env.STRIPE_SECRET_KEY, 'the platform key is set, as Connect requires');

  const account = accounts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(account, null, 'and it is not offered as this inventory own account');

  const said = accounts.describe(env.db, env.workspace.workspaceId);
  assert.equal(said.connected, false);
  assert.match(said.because, /connect its own Stripe/);
  env.db.close();
}));

test('a granted account is not quietly written over by a pasted key', () => asPlatform(async () => {
  const env = setup();
  await grantAccess(env, stripeStub());

  assert.throws(() => accounts.connect(env.db, env.ctx, env.membership,
    { secretKey: 'sk_test_pasted_over_1234' }), /Disconnect it first/);

  // Disconnecting and then pasting is an ordinary thing to do.
  await connect.disconnect(env.db, env.ctx, env.membership,
    { deauthorize: async () => {} });
  accounts.connect(env.db, env.ctx, env.membership, { secretKey: 'sk_test_pasted_over_1234' });
  assert.equal(accounts.forWorkspace(env.db, env.workspace.workspaceId).source, 'workspace');
  env.db.close();
}));

test('a code without a state StockChief issued is not acted on', () => asPlatform(async () => {
  /*
   * The state is what says which inventory a returning browser belongs to. A
   * code arriving without one is somebody else's request or a forgery, and
   * either way there is nothing to do with it but refuse.
   */
  const env = setup();
  const stripe = stripeStub();
  await assert.rejects(() => connect.complete(env.db,
    { code: 'ac_from_stripe', state: 'not-one-we-issued' },
    { exchange: stripe.exchange, readAccount: stripe.readAccount }), /expired|start again/i);
  assert.equal(stripe.state.exchanged.length, 0, 'and nothing was exchanged to find that out');

  // A state is single use, so a replayed return is refused as well.
  const begun = connect.authorizeUrl(env.db, env.ctx, env.membership, {});
  await connect.complete(env.db, { code: 'ac_1', state: begun.state },
    { exchange: stripe.exchange, readAccount: stripe.readAccount });
  await assert.rejects(() => connect.complete(env.db, { code: 'ac_1', state: begun.state },
    { exchange: stripe.exchange, readAccount: stripe.readAccount }), /expired|start again/i);
  env.db.close();
}));

test('a merchant who declines is told, not shown the form again', () => asPlatform(async () => {
  const env = setup();
  const begun = connect.authorizeUrl(env.db, env.ctx, env.membership, {});
  const said = await connect.complete(env.db,
    { state: begun.state, error: 'access_denied', error_description: 'The user denied the request.' });
  assert.equal(said.connected, false);
  assert.match(said.because, /denied/i);
  const connector = env.db.prepare(`SELECT setup_status, last_error FROM workspace_connectors
    WHERE workspace_id = ?`).get(env.workspace.workspaceId);
  assert.equal(connector.setup_status, 'AUTHORIZATION_FAILED');
  env.db.close();
}));

test('without an OAuth registration, StockChief reports that account sign-in is not configured', () => asPlatform(() => {
  const env = setup();
  const said = connect.describe(env.db, env.workspace.workspaceId);
  assert.equal(said.available, false);
  assert.match(said.because, /existing-account sign-in is not configured/);
  assert.throws(() => connect.authorizeUrl(env.db, env.ctx, env.membership, {}),
    /existing-account sign-in is not configured/);
  env.db.close();
}, false));

test('normal Stripe account sign-in wins when OAuth and hosted onboarding are both configured',
  () => asPlatform(() => {
    const held = process.env.STRIPE_CONNECT_ENABLED;
    process.env.STRIPE_CONNECT_ENABLED = 'true';
    try {
      assert.equal(connect.usesOauth(), true);
      assert.equal(connect.usesHostedOnboarding(), true);
      assert.equal(connect.preferredFlow(), 'oauth');
    } finally {
      if (held === undefined) delete process.env.STRIPE_CONNECT_ENABLED;
      else process.env.STRIPE_CONNECT_ENABLED = held;
    }
  }));

/* ------------------------------------------------ the road without a client id */

/*
 * The second way to Stripe, and the one that actually works on a dashboard
 * made today.
 *
 * OAuth needs a client id, and Stripe no longer issues one to every new
 * platform — a sandbox created this morning has none, and the setting a
 * developer is told to go and find simply is not there. Hosted onboarding
 * needs nothing but the platform key that has to be set anyway: StockChief makes
 * the account and Stripe shows the merchant its own form.
 *
 * What matters is that everything after the merchant comes back is the same.
 * The account id, the no-key rule, charges_enabled honesty, disconnect — all
 * of it is shared, which is why this lives in one module rather than two.
 */
function asHostedPlatform(run) {
  const held = { id: process.env.STRIPE_CONNECT_CLIENT_ID, key: process.env.STRIPE_SECRET_KEY,
    on: process.env.STRIPE_CONNECT_ENABLED };
  delete process.env.STRIPE_CONNECT_CLIENT_ID;      // the whole point: there is none
  process.env.STRIPE_SECRET_KEY = PLATFORM_KEY;
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  const restore = () => {
    for (const [name, value] of [['STRIPE_CONNECT_CLIENT_ID', held.id],
      ['STRIPE_SECRET_KEY', held.key], ['STRIPE_CONNECT_ENABLED', held.on]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    const out = run();
    return out && typeof out.then === 'function' ? out.finally(restore) : (restore(), out);
  } catch (error) { restore(); throw error; }
}

function hostedStripe(options = {}) {
  const state = { created: [], links: [], read: [] };
  return {
    state,
    async createAccount(input) {
      state.created.push(input);
      return { id: options.accountId || 'acct_hosted_1', charges_enabled: false, livemode: false,
        business_profile: { name: input.name } };
    },
    async createLink(input) {
      state.links.push(input);
      return { url: 'https://connect.stripe.com/setup/s/pretend', expires_at: 1799999999 };
    },
    async readAccount(id) {
      state.read.push(id);
      return { id, charges_enabled: options.chargesEnabled === true, livemode: false,
        business_profile: { name: 'HalFi Shoes' } };
    },
  };
}

test('hosted onboarding remains an internal capability but is not substituted for account sign-in',
  () => asHostedPlatform(async () => {
  const env = setup();
  const stripe = hostedStripe();

  assert.equal(connect.usesOauth(), false, 'there is no client id, which is the situation');
  assert.equal(connect.usesHostedOnboarding(), true);
  assert.equal(connect.preferredFlow(), null);
  assert.equal(connect.available(), false, 'the existing-account button is not falsely offered');

  const begun = await connect.openOnboarding(env.db, env.ctx, env.membership, {
    businessName: 'HalFi Shoes', email: 'owner@halfi.test',
    returnUrl: 'https://foundry.test/settings/connections/payments/return',
    refreshUrl: 'https://foundry.test/settings/connections/payments/refresh',
    createAccount: stripe.createAccount, createLink: stripe.createLink,
  });

  assert.match(begun.url, /^https:\/\/connect\.stripe\.com\/setup\//);
  assert.equal(begun.accountId, 'acct_hosted_1');
  assert.deepEqual(stripe.state.created, [{ name: 'HalFi Shoes', email: 'owner@halfi.test' }]);

  /*
   * The account exists and cannot take a payment, and StockChief says exactly
   * that. Half a signup is the ordinary result of closing the tab, and a green
   * tick over it is how a merchant finds out from a customer.
   */
  const said = accounts.describe(env.db, env.workspace.workspaceId);
  assert.equal(said.source, 'connect');
  assert.equal(said.chargesEnabled, false);
  assert.match(said.because, /not accepting charges/i);

  // And still no secret of theirs anywhere, which was the point of all of it.
  assert.equal(accounts.contextFor(env.db, env.ctx).stripeAccountId, 'acct_hosted_1');
  assert.equal(accounts.contextFor(env.db, env.ctx).stripeSecretKey, PLATFORM_KEY);

  // Once OAuth is configured, the unfinished onboarding row must not trap the
  // owner. A successful OAuth return replaces it atomically with the account
  // they actually chose.
  process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_pretend_platform';
  try {
    const replacement = connect.authorizeUrl(env.db, env.ctx, env.membership,
      { returnUri: 'https://foundry.test/settings/connections/payments/return' });
    assert.match(replacement.url, /^https:\/\/connect\.stripe\.com\/oauth\/authorize/);
  } finally {
    delete process.env.STRIPE_CONNECT_CLIENT_ID;
  }
  env.db.close();
}));

test('a business with no Stripe connection can never fall through to the developer account', () => asPlatform(() => {
  const env = setup('Not Connected');
  try {
    assert.equal(accounts.forWorkspace(env.db, env.workspace.workspaceId), null);
    assert.throws(() => accounts.contextFor(env.db, env.ctx, 'stripe'),
      /never put a business's customer payment through the developer account/);
  } finally { env.db.close(); }
}));

test('the newer OAuth account_id response completes the same existing-account connection',
  () => asPlatform(async () => {
    const env = setup();
    const begun = connect.authorizeUrl(env.db, env.ctx, env.membership, {});
    const result = await connect.complete(env.db, { code: 'ac_new_oauth', state: begun.state }, {
      exchange: async () => ({ account_id: 'acct_new_oauth', livemode: false }),
      readAccount: async (accountId) => ({
        id: accountId,
        business_profile: { name: 'Existing Stripe Business' },
        charges_enabled: true,
      }),
    });

    assert.equal(result.connected, true);
    assert.equal(result.accountId, 'acct_new_oauth');
    assert.equal(result.displayName, 'Existing Stripe Business');
    env.db.close();
  }));

test('an expired onboarding link is replaced, not reported', () => asHostedPlatform(async () => {
  /*
   * Stripe calls the refresh address when somebody opens a link that has
   * lapsed. They did nothing wrong except take longer than the link lasted, so
   * the answer is another link rather than an error.
   */
  const env = setup();
  const stripe = hostedStripe();
  await connect.openOnboarding(env.db, env.ctx, env.membership,
    { businessName: 'HalFi Shoes', createAccount: stripe.createAccount, createLink: stripe.createLink });

  const again = await connect.relink(env.db, env.ctx, { createLink: stripe.createLink });
  assert.match(again.url, /^https:\/\/connect\.stripe\.com\/setup\//);
  assert.equal(stripe.state.created.length, 1, 'and no second account was made to do it');
  assert.equal(stripe.state.links.length, 2);
  env.db.close();
}));

test('coming back is settled by asking Stripe, not by the redirect', () => asHostedPlatform(async () => {
  /*
   * Hosted onboarding returns the browser and says nothing about whether the
   * merchant finished. Believing the redirect would mean claiming an account
   * can take money because somebody navigated back to a page.
   */
  const env = setup();
  const started = hostedStripe();
  await connect.openOnboarding(env.db, env.ctx, env.membership,
    { businessName: 'HalFi Shoes', createAccount: started.createAccount, createLink: started.createLink });

  const stillUnfinished = await connect.refresh(env.db, env.workspace.workspaceId,
    { readAccount: hostedStripe({ chargesEnabled: false }).readAccount });
  assert.equal(stillUnfinished.chargesEnabled, false);

  const finished = await connect.refresh(env.db, env.workspace.workspaceId,
    { readAccount: hostedStripe({ chargesEnabled: true }).readAccount });
  assert.equal(finished.chargesEnabled, true);
  assert.equal(finished.because, null);
  env.db.close();
}));

test('the platform key is not a till here either', () => asHostedPlatform(() => {
  // The same hazard as with OAuth, and it must not depend on which road is in
  // use — a platform key is a platform key.
  const env = setup();
  assert.equal(accounts.forWorkspace(env.db, env.workspace.workspaceId), null);
  assert.match(accounts.describe(env.db, env.workspace.workspaceId).because,
    /No payment account is connected/);
  env.db.close();
}));

test('a restricted account is not a ready one, in either Stripe vocabulary', () => asHostedPlatform(async () => {
  /*
   * v1 said charges_enabled. v2 says the merchant configuration's card_payments
   * capability is "active", and says "restricted" while it still wants the
   * business to finish its form — which is the state every account is in for
   * the first few minutes of its life.
   *
   * Reading only the v1 word against a v2 account would mean every newly
   * created account reporting false for ever, and reading the presence of the
   * capability rather than its status would mean reporting true immediately.
   * Both are wrong in the same place: in front of a customer.
   */
  const env = setup();
  const v2 = (status) => async () => ({
    id: 'acct_hosted_1', livemode: false, display_name: 'HalFi Shoes',
    configuration: { merchant: { capabilities: { card_payments: { requested: true, status } } } },
  });

  await connect.openOnboarding(env.db, env.ctx, env.membership, {
    businessName: 'HalFi Shoes',
    createAccount: v2('restricted'),
    createLink: async () => ({ url: 'https://connect.stripe.com/setup/s/x' }),
  });
  assert.equal(connect.describe(env.db, env.workspace.workspaceId).chargesEnabled, false,
    'requested but restricted is not ready');

  assert.equal((await connect.refresh(env.db, env.workspace.workspaceId,
    { readAccount: v2('active') })).chargesEnabled, true);
  assert.equal((await connect.refresh(env.db, env.workspace.workspaceId,
    { readAccount: v2('restricted') })).chargesEnabled, false,
    'and an account that loses the capability again stops claiming it');
  env.db.close();
}));

/* ------------------------------------------- the form, without the handoff */

function asEmbeddedPlatform(run) {
  const held = { key: process.env.STRIPE_SECRET_KEY, on: process.env.STRIPE_CONNECT_ENABLED,
    pub: process.env.STRIPE_PUBLISHABLE_KEY, id: process.env.STRIPE_CONNECT_CLIENT_ID };
  delete process.env.STRIPE_CONNECT_CLIENT_ID;
  process.env.STRIPE_SECRET_KEY = PLATFORM_KEY;
  process.env.STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_platform_public';
  const restore = () => {
    for (const [name, value] of [['STRIPE_SECRET_KEY', held.key],
      ['STRIPE_CONNECT_ENABLED', held.on], ['STRIPE_PUBLISHABLE_KEY', held.pub],
      ['STRIPE_CONNECT_CLIENT_ID', held.id]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    const out = run();
    return out && typeof out.then === 'function' ? out.finally(restore) : (restore(), out);
  } catch (error) { restore(); throw error; }
}

test('the form runs here, and no page is asked for that nobody will open', () => asEmbeddedPlatform(async () => {
  /*
   * The questions are Stripe's and cannot be shortened by anybody — they are
   * what has to be answered before money may be moved into a bank. What the
   * embedded form removes is the handoff, which is most of what makes the
   * process feel long.
   */
  const env = setup();
  const stripe = hostedStripe();
  let linksAsked = 0;

  assert.equal(connect.usesEmbedded(), true);

  await connect.openOnboarding(env.db, env.ctx, env.membership, {
    businessName: 'HalFi Shoes', link: false,
    createAccount: stripe.createAccount,
    createLink: async () => { linksAsked += 1; return { url: 'x' }; },
  });
  assert.equal(linksAsked, 0, 'no hosted page was requested for a form shown here');

  const session = await connect.embeddedSession(env.db, env.ctx, {
    createSession: async (input) => {
      assert.equal(input.account, 'acct_hosted_1');
      return { client_secret: 'accs_secret_pretend' };
    },
  });
  assert.equal(session.clientSecret, 'accs_secret_pretend');
  assert.equal(session.publishableKey, 'pk_test_platform_public',
    'the browser gets the public key, which is what it is for');
  assert.ok(!JSON.stringify(session).includes(PLATFORM_KEY),
    'and never the secret one');
  env.db.close();
}));

test('without a publishable key the form still opens, on Stripe', () => asHostedPlatform(async () => {
  /*
   * The embedded form needs a public key in the browser. Where there is none,
   * the answer is the hosted page — never a merchant stranded in front of a
   * panel that cannot render.
   */
  const env = setup();
  const held = process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  try {
    assert.equal(connect.usesEmbedded(), false);
    assert.equal(connect.usesHostedOnboarding(), true, 'so the hosted road is still open');

    const stripe = hostedStripe();
    const begun = await connect.openOnboarding(env.db, env.ctx, env.membership, {
      businessName: 'HalFi Shoes',
      createAccount: stripe.createAccount, createLink: stripe.createLink,
    });
    assert.match(begun.url, /^https:\/\/connect\.stripe\.com\/setup\//);

    await assert.rejects(() => connect.embeddedSession(env.db, env.ctx),
      /no Stripe publishable key/);
  } finally {
    if (held !== undefined) process.env.STRIPE_PUBLISHABLE_KEY = held;
    env.db.close();
  }
}));
