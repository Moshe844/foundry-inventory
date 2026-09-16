'use strict';

/*
 * StockChief asking a customer for money without being told to.
 *
 * The complaint that produced this was one line: "IT ALL SEEMS MANUAL". It
 * was true. An order shipped and then a person had to remember to go and ask
 * for the money, find the button, press it, find the link, and send it.
 *
 * What is under test is not that StockChief does it, but that what it does
 * follows the authority it was actually given. Customer terms, the workspace
 * mode, authority for this exact job, and a sending mailbox all have to agree.
 * When any one of them does not, StockChief still gets everything
 * ready and says which one stopped it — because a prepared link with no
 * explanation looks like something the owner forgot to do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const automation = require('../../src/sales/payment-automation');
const collection = require('../../src/payments/collection');
const paymentAccounts = require('../../src/payments/accounts');
const providers = require('../../src/payments/provider');
const comms = require('../../src/sales/customer-communications');
const terms = require('../../src/sales/payment-terms');
const modes = require('../../src/autopilot/modes');
const capabilities = require('../../src/autopilot/capabilities');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/inventory-engine');
const connections = require('../../src/connections/service');
const authService = require('../../src/domain/auth-service');
const gmail = require('../../src/connections/providers/gmail');
const credentials = require('../../src/connections/credentials');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

const realSend = gmail.send;
test.before(() => { gmail.send = async () => ({ externalMessageId: 'sent-1', externalThreadId: 'thread-1' }); });
test.after(() => { gmail.send = realSend; });
test.after(cleanupAll);

/* A provider and a mailbox that both simply work, so authority is the variable. */
function fakeProvider(state) {
  return {
    createCustomer: async () => ({ externalCustomerId: 'cus_test' }),
    createInvoice: async () => ({ externalInvoiceId: 'in_test', hostedUrl: 'https://pay.test/1', status: 'open' }),
    getHostedPaymentUrl: async () => 'https://pay.test/1',
    refundPayment: async () => ({ ok: true }),
    verifyEvent: () => true,
    readEvent: () => ({ kind: 'PAID', externalInvoiceId: 'in_test', amountMinor: 0 }),
  };
}

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  // The platform key is StockChief's identity, never this test business's till.
  // Give this business its own test account so the tests isolate automation
  // authority instead of relying on the unsafe platform fallback.
  paymentAccounts.connect(db, workspace.ctx, membership, { secretKey: 'sk_test_riverside_0000' });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '10.00', currency: 'USD' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 100 });
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });

  providers.register('stripe', fakeProvider());
  /*
   * A real sending mailbox, because "can StockChief send" is one of the three
   * permissions under test and a connector that could never send would make
   * every case here pass for the wrong reason.
   */
  const created = connections.create(db, workspace.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(created.connection.id);
  credentials.put(db, workspace.workspaceId, created.connection.id, 'provider', {
    accessToken: 'test-token', refreshToken: 'test-refresh', mailbox: 'shop@example.test',
    expiresAt: Date.now() + 60 * 60_000,
  });
  comms.setPolicy(db, workspace.ctx, { connectorId: created.connection.id });

  const customer = sales.createCustomer(db, workspace.ctx, { name: 'ABC School', email: 'jo@abcschool.test' });
  return { db, workspace, ctx: workspace.ctx, membership, item, customer };
}

/** An order worth $20 that a customer has committed to. */
function order(env) {
  return sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: env.customer.id, lines: [{ skuId: env.item.skuId, quantity: 2 }],
  }).id);
}

const allowed = (env, extra = {}) => terms.setTerms(env.db, env.ctx, {
  customerId: env.customer.id, kind: 'BEFORE_FULFILMENT',
  autoRequestEnabled: 1, autoRequestLimitMinor: 100000, ...extra,
});

test('with nothing agreed, StockChief gets it ready and says what it is waiting on', async () => {
  const env = setup();
  terms.setTerms(env.db, env.ctx, { customerId: env.customer.id, kind: 'BEFORE_FULFILMENT' });

  const done = await automation.onMoneyDue(env.db, env.ctx, order(env).id);

  assert.equal(done.asked, true, 'the link is made, because that is one press saved either way');
  assert.equal(done.sent, false, 'but nothing reaches the customer');
  assert.match(done.because, /Nobody has agreed/);
  assert.equal(done.message.status, 'PREPARED', 'the email is written and waiting');
});

test('permission without a limit is not permission', async () => {
  const env = setup();
  terms.setTerms(env.db, env.ctx, { customerId: env.customer.id, kind: 'BEFORE_FULFILMENT',
    autoRequestEnabled: 1 });

  const done = await automation.onMoneyDue(env.db, env.ctx, order(env).id);
  assert.equal(done.sent, false, 'a switch with no limit is an open cheque');
  assert.match(done.because, /no limit/i);
});

test('over the limit, StockChief stops and quotes both figures', async () => {
  const env = setup();
  allowed(env, { autoRequestLimitMinor: 500 });

  const done = await automation.onMoneyDue(env.db, env.ctx, order(env).id);
  assert.equal(done.sent, false);
  assert.match(done.because, /20\.00 is over the 5\.00/,
    'the owner should not have to work out which number was too big');
});

test('a workspace set to ask first is asked first', async () => {
  const env = setup();
  allowed(env);
  modes.setMode(env.db, env.ctx, env.membership, 'SUPERVISED');

  const done = await automation.onMoneyDue(env.db, env.ctx, order(env).id);
  assert.equal(done.asked, true);
  assert.equal(done.sent, false, 'the customer terms allow it; the workspace does not');
  assert.match(done.because, /ask before acting/);
});

test('watching only means nothing is prepared at all', async () => {
  const env = setup();
  allowed(env);
  modes.setMode(env.db, env.ctx, env.membership, 'OBSERVE');

  const done = await automation.onMoneyDue(env.db, env.ctx, order(env).id);
  assert.equal(done.asked, false, 'a Stripe invoice is a real object in a real account');
  assert.equal(done.sent, false);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payment_requests').get().n, 0);
});

test('when the customer terms, workspace mode, job authority, and mailbox agree, StockChief asks and sends', async () => {
  const env = setup();
  allowed(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  capabilities.set(env.db, env.ctx, env.membership, 'payment_requests', true);

  const done = await automation.onMoneyDue(env.db, env.ctx, order(env).id);
  assert.equal(done.asked, true);
  assert.equal(done.sent, true);
  assert.equal(done.request.amountMinor, 2000, 'what the terms said was due, not a new opinion');
  assert.equal(done.message.status, 'SENT');
  assert.equal(done.message.recipient, 'jo@abcschool.test');
});

test('a paused StockChief does nothing, however much authority it has', async () => {
  const env = setup();
  allowed(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  modes.pause(env.db, env.ctx, env.membership, 'Owner pressed pause.');

  const done = await automation.onMoneyDue(env.db, env.ctx, order(env).id);
  assert.equal(done.asked, false);
  assert.match(done.because, /paused/i);
});

test('asking twice for the same debt cannot happen', async () => {
  const env = setup();
  allowed(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  const placed = order(env);

  await automation.onMoneyDue(env.db, env.ctx, placed.id);
  const again = await automation.onMoneyDue(env.db, env.ctx, placed.id);

  assert.equal(again.asked, false, 'a link is already open on this order');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payment_requests').get().n, 1);
});

test('a customer with no email is reported, not guessed around', async () => {
  const env = setup();
  const nameless = sales.createCustomer(env.db, env.ctx, { name: 'Counter Sale' });
  terms.setTerms(env.db, env.ctx, { customerId: nameless.id, kind: 'BEFORE_FULFILMENT',
    autoRequestEnabled: 1, autoRequestLimitMinor: 100000 });
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  const placed = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: nameless.id, lines: [{ skuId: env.item.skuId, quantity: 2 }],
  }).id);

  const done = await automation.onMoneyDue(env.db, env.ctx, placed.id);
  assert.equal(done.asked, false);
  assert.match(done.because, /no email address for Counter Sale/i);
});

test('a deposit is asked for at confirmation, long before anything ships', async () => {
  /*
   * The case the owner named: payment before fulfilment. Nothing has been
   * picked, no invoice exists, and the money is still due.
   */
  const env = setup();
  terms.setTerms(env.db, env.ctx, { customerId: env.customer.id, kind: 'DEPOSIT', depositPercent: 50,
    autoRequestEnabled: 1, autoRequestLimitMinor: 100000 });
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  const placed = order(env);
  assert.equal(placed.status, 'CONFIRMED', 'nothing has shipped');

  const done = await automation.onMoneyDue(env.db, env.ctx, placed.id);
  assert.equal(done.asked, true);
  assert.equal(done.request.purpose, 'DEPOSIT');
  assert.equal(done.request.amountMinor, 1000, 'half of $20, from the terms');
  assert.equal(done.request.invoiceId, null, 'and no StockChief invoice had to exist first');
});

test('a failure to collect never becomes a failure to ship', async () => {
  /*
   * onMoneyDue is called from the ship route. A provider outage, a mailbox
   * problem, anything at all — the parcel has physically gone and no error
   * here may suggest otherwise.
   */
  const env = setup();
  allowed(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  providers.register('stripe', {
    ...fakeProvider(),
    createInvoice: async () => { throw new Error('Stripe is having a day'); },
  });

  const done = await automation.onMoneyDue(env.db, env.ctx, order(env).id);
  assert.equal(done.asked, false);
  assert.match(done.because, /Stripe is having a day/);
});
