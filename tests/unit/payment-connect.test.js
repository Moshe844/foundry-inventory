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
 *   1. Foundry ends up holding an account id and no secret — and the access
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
 * Foundry is handed one and does not keep it.
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
   * it is the thing a pasted key never allowed. Foundry finds out by being
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
    'so the business dashboard stops listing Foundry too');
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

test('a code without a state Foundry issued is not acted on', () => asPlatform(async () => {
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

test('without a platform registration, Foundry says to paste a key instead', () => asPlatform(() => {
  const env = setup();
  const said = connect.describe(env.db, env.workspace.workspaceId);
  assert.equal(said.available, false);
  assert.match(said.because, /secret key has to be pasted/);
  assert.throws(() => connect.authorizeUrl(env.db, env.ctx, env.membership, {}),
    /no Stripe Connect client id/);
  env.db.close();
}, false));
