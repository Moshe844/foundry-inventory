'use strict';

/*
 * A shipping account opened without the merchant leaving.
 *
 * Connecting a carrier account already worked — accounts.js has done it since
 * the shipping subsystem existed. What it demanded was that a shop owner go
 * away, create an EasyPost account, set up a wallet, find a keys page and come
 * back with a secret, and most of them will not.
 *
 * So these are the claims that have to hold for the other path. They are not
 * about convenience: three of them are about money, and one of them is the
 * reason the whole thing is worth building rather than faking.
 *
 *   1. The account is the merchant's, and Keeper is never billed for it.
 *   2. A live key is not handed out before there is anything to bill.
 *   3. No card number passes through Foundry, ever.
 *   4. Disconnecting forgets a key. It does not close an account.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const referral = require('../../src/shipping/referral');
const accounts = require('../../src/shipping/accounts');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

/*
 * EasyPost, standing still.
 *
 * The partner API is the only thing under src/shipping that spends real money
 * on a real account, so no test may reach it. This answers in the shapes the
 * adapter reads and remembers what it was asked, which is how "Foundry never
 * sent a card number" becomes something a test can actually check rather than
 * something a comment asserts.
 */
function fakePartner(options = {}) {
  const state = { created: [], attached: [], hasCard: Boolean(options.hasCard), calls: [] };
  return {
    state,
    isPartnerConfigured: () => options.configured !== false,
    async createReferralCustomer(input) {
      state.created.push(input);
      return {
        referralCustomerId: `user_${state.created.length}`,
        name: input.name,
        email: input.email,
        testKey: `EZTK_referral_${state.created.length}_test`,
        liveKey: `EZAK_referral_${state.created.length}_live`,
      };
    },
    async hasPaymentMethod(key) { state.calls.push(key); return state.hasCard; },
    PAYMENT: {
      async beginCardSetup(key) {
        state.calls.push(key);
        return { clientSecret: 'seti_1_secret_abc', publishableKey: 'pk_test_easypost',
          stripeCustomerId: 'cus_merchant' };
      },
      async beginBankSetup() { return { clientSecret: 'seti_bank_secret' }; },
      async attach(key, input) {
        if (/^(?:\d[ -]?){12,19}$/.test(String(input.paymentMethodReference))) {
          throw new Error('a card number reached the partner API');
        }
        state.attached.push(input);
        state.hasCard = true;
        return { attached: true, id: 'pm_recorded' };
      },
    },
  };
}

/*
 * `describe` asks the environment whether Keeper is enrolled at all, so the
 * tests say so rather than depending on whatever is in a developer's .env.
 */
function asPartner(run, enrolled = true) {
  const held = process.env.EASYPOST_PARTNER_KEY;
  if (enrolled) process.env.EASYPOST_PARTNER_KEY = 'ezp_partner_pretend';
  else delete process.env.EASYPOST_PARTNER_KEY;
  try { return run(); } finally {
    if (held === undefined) delete process.env.EASYPOST_PARTNER_KEY;
    else process.env.EASYPOST_PARTNER_KEY = held;
  }
}

function setup(name) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: name || 'HalFi Shoes' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, ctx: workspace.ctx, membership };
}

test('Foundry opens the account, and the merchant never sees the carrier', () => asPartner(async () => {
  const env = setup();
  const partner = fakePartner();

  assert.equal(referral.describe(env.db, env.workspace.workspaceId).opened, false);

  const opened = await referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' }, { partner });

  assert.equal(opened.opened, true);
  assert.equal(opened.referralCustomerId, 'user_1');
  assert.deepEqual(partner.state.created[0],
    { name: 'HalFi Shoes', email: 'owner@halfi.test', phone: null });

  // The account is reachable exactly as a pasted key would be: everything
  // above the seam is unchanged by which path was taken.
  const account = accounts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(account.provider, 'easypost');
  assert.equal(account.source, 'referral', 'and the screen can say which kind it is');
  assert.ok(account.apiKey, 'the adapter gets a key, which is the whole point');

  const described = accounts.describe(env.db, env.workspace.workspaceId);
  assert.ok(!JSON.stringify(described).includes(account.apiKey),
    'the key is never handed back to a screen');
  const connector = accounts.connectorFor(env.db, env.workspace.workspaceId);
  assert.ok(!JSON.stringify(connector).includes(account.apiKey),
    'nor is it sitting on the connector row');
  assert.match(connector.credential_ref, /^credentials:/);
  env.db.close();
}));

test('no live key until there is something to bill', () => asPartner(async () => {
  /*
   * The claim the rest of it rests on. An account with no payment method can
   * buy nothing, so holding its live key would only mean failing at the
   * counter — and quoting its test rates as real prices would be Foundry
   * inventing a number, which is the one thing it must never do.
   */
  const env = setup();
  const partner = fakePartner({ hasCard: false });
  await referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' }, { partner });

  const before = accounts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.match(before.apiKey, /^EZTK/, 'the test key is in force');
  assert.equal(before.billingReady, false);
  assert.match(accounts.describe(env.db, env.workspace.workspaceId).because,
    /no payment method|cannot buy a label/i,
    'and the screen says so rather than showing a green tick');

  const state = await referral.recordPaymentMethod(env.db, env.ctx, env.membership,
    { stripeCustomerId: 'cus_merchant', paymentMethodReference: 'pm_1234' }, { partner });

  assert.equal(state.billingReady, true);
  const after = accounts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.match(after.apiKey, /^EZAK/, 'and only now is the live key in force');
  assert.equal(accounts.describe(env.db, env.workspace.workspaceId).because, null);
  env.db.close();
}));

test('the carrier is asked, not the browser', () => asPartner(async () => {
  /*
   * Stripe saying it stored a card is not EasyPost saying it will bill one.
   * If the second is not true the account stays where it was, because a live
   * key handed out on a promise fails on a real parcel.
   */
  const env = setup();
  const partner = fakePartner();
  partner.PAYMENT.attach = async () => ({ attached: true });   // Stripe says yes
  partner.hasPaymentMethod = async () => false;                 // EasyPost does not

  await referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' }, { partner });
  const state = await referral.recordPaymentMethod(env.db, env.ctx, env.membership,
    { stripeCustomerId: 'cus_merchant', paymentMethodReference: 'pm_1234' }, { partner });

  assert.equal(state.billingReady, false);
  assert.match(accounts.forWorkspace(env.db, env.workspace.workspaceId).apiKey, /^EZTK/);
  env.db.close();
}));

test('a card number is refused rather than forwarded', () => asPartner(async () => {
  /*
   * A guard, not a validation. Nothing should ever put a card number in this
   * argument — but if something upstream ever does, the right response is to
   * stop, not to send it on and log the failure with the number in it.
   */
  const partnerApi = require('../../src/shipping/providers/easypost-partner');
  await assert.rejects(
    () => partnerApi.PAYMENT.attach('EZAK_x', {
      stripeCustomerId: 'cus_merchant', paymentMethodReference: '4242424242424242' }),
    /card number/i);

  // And nothing reached the network to find that out.
  await assert.rejects(
    () => partnerApi.PAYMENT.attach('EZAK_x', {
      stripeCustomerId: 'cus_merchant', paymentMethodReference: '4242 4242 4242 4242' }),
    /card number/i);
}));

test('a card added on the carrier own site is noticed by the sweep', () => asPartner(async () => {
  /*
   * A merchant may finish the form tomorrow, on a phone, or on EasyPost's own
   * page. None of those come back through Foundry, and without the sweep the
   * account would sit in test mode for ever with nothing saying why.
   */
  const env = setup();
  const partner = fakePartner({ hasCard: false });
  await referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' }, { partner });

  assert.deepEqual(await referral.sweep(env.db, { partner }),
    [{ workspaceId: env.workspace.workspaceId, billingReady: false }]);

  partner.state.hasCard = true;   // added somewhere Foundry cannot see
  const checked = await referral.sweep(env.db, { partner });
  assert.equal(checked[0].billingReady, true);
  assert.match(accounts.forWorkspace(env.db, env.workspace.workspaceId).apiKey, /^EZAK/);

  // And a settled account is not asked about again.
  assert.deepEqual(await referral.sweep(env.db, { partner }), []);
  env.db.close();
}));

test('one merchant account never reaches another', () => asPartner(async () => {
  const { db } = makeDatabase();
  const one = seedWorkspace(db, { workspaceName: 'Shop One' });
  const two = seedWorkspace(db, { workspaceName: 'Shop Two' });
  const oneMember = authService.getMembership(db, one.workspaceId, one.accountId);
  const twoMember = authService.getMembership(db, two.workspaceId, two.accountId);
  const partner = fakePartner();

  await referral.enrol(db, one.ctx, oneMember, { name: 'One', email: 'a@one.test' }, { partner });
  await referral.enrol(db, two.ctx, twoMember, { name: 'Two', email: 'b@two.test' }, { partner });

  const first = accounts.forWorkspace(db, one.workspaceId);
  const second = accounts.forWorkspace(db, two.workspaceId);
  assert.notEqual(first.apiKey, second.apiKey);
  assert.equal(first.referralCustomerId, 'user_1');
  assert.equal(second.referralCustomerId, 'user_2');
  assert.equal(accounts.contextFor(db, one.ctx).ctx.easypostApiKey, first.apiKey);
  assert.equal(accounts.contextFor(db, two.ctx).ctx.easypostApiKey, second.apiKey);
  db.close();
}));

test('disconnecting forgets the keys and leaves the account standing', () => asPartner(async () => {
  /*
   * Deliberately not a deletion. The merchant's labels, tracking history and
   * billing records live on that account and are theirs — Keeper closing it
   * because a subscription lapsed would be destroying somebody else's records.
   */
  const env = setup();
  const partner = fakePartner({ hasCard: true });
  await referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' }, { partner });

  const released = referral.release(env.db, env.ctx, env.membership);
  assert.equal(released.referralCustomerId, 'user_1', 'which account it was is still knowable');
  assert.match(released.because, /still exists and still belongs/);

  assert.equal(accounts.forWorkspace(env.db, env.workspace.workspaceId), null);
  assert.equal(referral.describe(env.db, env.workspace.workspaceId).opened, false);

  // Nothing was asked of the carrier. Foundry does not close a merchant's account.
  assert.equal(partner.state.created.length, 1);
  env.db.close();
}));

test('an account Foundry opened is not quietly written over', () => asPartner(async () => {
  /*
   * A merchant who later negotiates their own carrier contract should be able
   * to switch. Pasting a key over the referral account would do it silently —
   * leaving them billed by EasyPost for an account they can no longer see.
   */
  const env = setup();
  const partner = fakePartner();
  await referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' }, { partner });

  assert.throws(() => accounts.connect(env.db, env.ctx, env.membership,
    { provider: 'easypost', apiKey: 'EZAK_their_own_key' }), /Disconnect it first/);

  // But disconnecting and then connecting is an ordinary thing to do.
  accounts.disconnect(env.db, env.ctx, env.membership);
  accounts.connect(env.db, env.ctx, env.membership,
    { provider: 'easypost', apiKey: 'EZAK_their_own_key' });
  const account = accounts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(account.source, 'workspace');
  assert.equal(account.apiKey, 'EZAK_their_own_key');
  env.db.close();
}));

test('opening a second account for the same inventory is refused', () => asPartner(async () => {
  const env = setup();
  const partner = fakePartner();
  await referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' }, { partner });
  await assert.rejects(() => referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' }, { partner }), /already has a shipping account/);
  assert.equal(partner.state.created.length, 1, 'and no account was created before refusing');
  env.db.close();
}));

test('an unreachable email is refused before an account exists', () => asPartner(async () => {
  /*
   * EasyPost sends this merchant their own billing notices. An account nobody
   * can be reached about is one nobody can fix.
   */
  const env = setup();
  const partner = fakePartner();
  await assert.rejects(() => referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'not-an-address' }, { partner }), /real one/);
  assert.equal(partner.state.created.length, 0);
  env.db.close();
}));

test('without an enrolment, Foundry says to connect an account instead', () => asPartner(async () => {
  /*
   * Opening accounts depends on Keeper's own partner agreement, which is a
   * business arrangement rather than a setting. Where there is none, the
   * screen offers the path that does work rather than a button that fails.
   */
  const env = setup();
  const said = referral.describe(env.db, env.workspace.workspaceId);
  assert.equal(said.available, false);
  assert.match(said.because, /existing carrier account has to be connected/);

  await assert.rejects(() => referral.enrol(env.db, env.ctx, env.membership,
    { name: 'HalFi Shoes', email: 'owner@halfi.test' },
    { partner: fakePartner({ configured: false }) }), /not enrolled/);
  env.db.close();
}, false));

/* ------------------------------------------------------- the scheduled work */

test('an account that belongs to a workspace is still swept', () => asPartner(async () => {
  /*
   * The gate that closed on the whole subsystem.
   *
   * The scheduler asked `provider.configured()` — which reads the environment
   * — before doing any shipping work at all. That was the whole story when
   * there was one key for the server. The moment an account could belong to a
   * workspace it stopped being true: an install where every merchant has their
   * own account has no key in the environment, so the gate closed and nothing
   * behind it ever ran. No tracking sweep, no delay notices, no rule ever
   * buying a label — and nothing anywhere saying why.
   *
   * Every sweep behind the gate already resolves its own workspace's account.
   * The only question the gate should ever have asked is whether anybody at
   * all can reach a carrier.
   */
  const shipping = require('../../src/shipping');
  const shipments = require('../../src/sales/shipment-service');
  const sales = require('../../src/sales/sales-order-service');
  const inventory = require('../../src/domain/inventory-engine');
  const prices = require('../../src/pricing/price-service');
  const scheduler = require('../../src/connections/mailbox-scheduler');
  const { makeQuantityItem } = require('../helpers');
  const { fakeCarrier } = require('../helpers/fake-carrier');

  const held = process.env.EASYPOST_API_KEY;
  delete process.env.EASYPOST_API_KEY;

  const env = setup();
  const carrier = fakeCarrier();
  // The real adapter reports itself configured from the environment, and that
  // is the thing under test — a fake that always says yes would open the gate
  // by itself and prove nothing.
  carrier.isConfigured = () => Boolean(process.env.EASYPOST_API_KEY);
  const undo = shipping.provider.register('easypost', carrier);
  try {
    // This inventory's own account, and nothing in the environment.
    accounts.connect(env.db, env.ctx, env.membership,
      { provider: 'easypost', apiKey: 'EZAK_this_shop_only' });
    assert.equal(shipping.provider.configured(), null,
      'the environment knows about no carrier at all, which is the point');

    const item = makeQuantityItem(env.db, env.ctx, { name: 'moc toe slip in', baseCode: '7L665-3-36' });
    prices.setPrice(env.db, env.ctx, { skuId: item.skuId, amount: '80.00', currency: 'USD' });
    env.db.prepare('UPDATE skus SET weight_grams = 900 WHERE id = ?').run(item.skuId);
    env.db.prepare('UPDATE locations SET address = ? WHERE id = ?')
      .run('12 Depot Road, Monroe, NY 10950', env.workspace.main.id);
    inventory.receive(env.db, env.ctx,
      { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });

    const customer = sales.createCustomer(env.db, env.ctx, {
      name: 'Moshe Ekstein', email: 'motty@example.test',
      shippingAddress: '13 Austra Pkwy, Monroe, NY 10950',
    });
    const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
      customerId: customer.id, neededBy: '2026-09-14',
      lines: [{ skuId: item.skuId, quantity: 2 }],
    }).id);
    const box = shipments.startPicking(env.db, env.ctx, order.id, {});
    shipments.markPacked(env.db, env.ctx, box.id, {});

    /*
     * A parcel in flight that has gone quiet — the one case the scheduled
     * fallback exists for. Written straight onto the shipment because what is
     * under test is the gate in front of the sweep, not the buying that
     * usually puts it in this state.
     */
    env.db.prepare(`UPDATE sales_shipments
      SET status = 'SHIPPED', tracking_number = ?, carrier = 'ups',
          shipped_at = '2026-09-01T00:00:00.000Z', tracked_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?`).run('1Z999AA10123456784', box.id);

    let asked = 0;
    carrier.track = async () => { asked += 1; return null; };

    await scheduler.runDue(env.db, {});
    assert.ok(asked > 0, 'the carrier was asked where the parcel is, which the gate used to prevent');
  } finally {
    undo();
    if (held !== undefined) process.env.EASYPOST_API_KEY = held;
    env.db.close();
  }
}));
