'use strict';

/*
 * Collecting money through somebody else's payment page.
 *
 * The claim under test is the one that matters most: a card payment and a
 * reported cheque end in the same place. Same receipt, same allocation, same
 * invoice balance, same fulfilment hold lifting. If online payments had their
 * own path into the books there would be two definitions of paid.
 *
 * The second claim is that a provider can retry a webhook as many times as it
 * likes and the customer is charged once and credited once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../../src/payments/provider');
const collection = require('../../src/payments/collection');
const stripe = require('../../src/payments/providers/stripe');
const terms = require('../../src/sales/payment-terms');
const shipments = require('../../src/sales/shipment-service');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const receivables = require('../../src/accounting/receivables');
const prices = require('../../src/pricing/price-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

/**
 * A provider that behaves, so the tests are about Foundry rather than Stripe.
 */
function fakeProvider() {
  const state = { customers: [], invoices: [] };
  return {
    state,
    async createCustomer(ctx, { name, email }) {
      state.customers.push({ name, email });
      return { externalCustomerId: `cus_${state.customers.length}` };
    },
    async createInvoice(ctx, input) {
      state.invoices.push(input);
      const id = `in_${state.invoices.length}`;
      return { externalInvoiceId: id, hostedUrl: `https://pay.test/${id}`, status: 'open' };
    },
    async getHostedPaymentUrl(ctx, { externalInvoiceId }) { return `https://pay.test/${externalInvoiceId}`; },
    async refundPayment() { return { externalRefundId: 're_1' }; },
    verifyEvent(raw) { return raw; },
    readEvent(event) {
      if (event.type === 'paid') {
        return { kind: 'PAID', externalInvoiceId: event.invoice, externalPaymentId: event.pi,
          amountMinor: event.amount, currency: 'USD', method: 'card' };
      }
      if (event.type === 'failed') {
        return { kind: 'FAILED', externalInvoiceId: event.invoice, reason: 'The card was declined.' };
      }
      return { kind: 'IGNORED' };
    },
  };
}

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '15.00', currency: 'USD' });
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  const ctx = { ...workspace.ctx, membership };
  return { db, workspace, ctx, membership, item };
}

function invoicedOrder(env, quantity = 100) {
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School', email: 'orders@abcschool.test' });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: quantity * 2 });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity }],
  }).id);
  const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
    customerId: customer.id, salesOrderId: order.id, issueDate: '2026-09-02',
    lines: [{ description: 'Shirts', quantity, unitPriceMinor: 1500 }],
  });
  receivables.open(env.db, env.ctx, env.membership, invoice.id);
  return { customer, order, invoiceId: invoice.id };
}

const balance = (env, invoiceId) => Number(env.db
  .prepare('SELECT balance_minor FROM accounting_customer_invoices WHERE id = ?').get(invoiceId).balance_minor);

test('the registry refuses a provider that cannot do the job', () => {
  assert.throws(() => registry.register('half', { createCustomer() {} }), /missing: createInvoice/);
  assert.throws(() => registry.get('nobody'), /No payment provider called "nobody"/);
  const undo = registry.register('fake', fakeProvider());
  assert.equal(registry.has('fake'), true);
  undo();
  assert.equal(registry.has('fake'), false);
});

test('a deposit is requested for what the terms said, and the link is kept', async () => {
  const env = setup();
  const provider = fakeProvider();
  const undo = registry.register('fake', provider);
  try {
    const { customer, order } = invoicedOrder(env);
    terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'DEPOSIT', depositPercent: 30 });

    const asked = await collection.request(env.db, env.ctx, order.id, { provider: 'fake', purpose: 'DEPOSIT' });
    assert.equal(asked.amountMinor, 45000, '30% of $1,500, from the terms rather than from here');
    assert.equal(asked.status, 'OPEN');
    assert.match(asked.hostedUrl, /^https:\/\/pay\.test\//);
    assert.equal(provider.state.customers.length, 1);
    assert.equal(provider.state.invoices[0].amountMinor, 45000);

    // A second request reuses the customer rather than making another one.
    await collection.request(env.db, env.ctx, order.id, { provider: 'fake', purpose: 'BALANCE' });
    assert.equal(provider.state.customers.length, 1, 'two customers would be two payment histories');
    assert.equal(collection.openLinkForOrder(env.db, env.workspace.workspaceId, order.id).status, 'OPEN');
  } finally { undo(); }
});

test('a paid event becomes an ordinary receipt, and lifts the hold it was blocking', async () => {
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const { customer, order, invoiceId } = invoicedOrder(env);
    terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'DEPOSIT', depositPercent: 30, holdShipping: true });
    const asked = await collection.request(env.db, env.ctx, order.id, { provider: 'fake', purpose: 'DEPOSIT' });

    assert.throws(() => shipments.startPicking(env.db, env.ctx, order.id), /deposit of \$450\.00 is due/);

    const result = collection.receiveEvent(env.db, env.ctx, 'fake',
      { id: 'evt_1', type: 'paid', invoice: asked.externalInvoiceId, pi: 'pi_1', amount: 45000 });
    assert.equal(result.applied, true);
    assert.equal(balance(env, invoiceId), 105000, 'the invoice moved, through the ordinary engine');

    const position = terms.positionForOrder(env.db, env.workspace.workspaceId,
      env.db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(order.id));
    assert.equal(position.paidMinor, 45000);
    assert.equal(position.blocksPicking, false, 'the deposit arrived, so the warehouse may start');
    assert.equal(position.blocksShipping, true, 'and the balance still holds the parcel');

    const box = shipments.startPicking(env.db, env.ctx, order.id);
    assert.equal(box.units, 100);
  } finally { undo(); }
});

test('a webhook delivered five times charges the books once', async () => {
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const { order, invoiceId } = invoicedOrder(env);
    const asked = await collection.request(env.db, env.ctx, order.id, { provider: 'fake' });
    const event = { id: 'evt_same', type: 'paid', invoice: asked.externalInvoiceId, pi: 'pi_9', amount: 150000 };

    const first = collection.receiveEvent(env.db, env.ctx, 'fake', event);
    assert.equal(first.applied, true);
    for (let n = 0; n < 4; n += 1) {
      const again = collection.receiveEvent(env.db, env.ctx, 'fake', event);
      assert.equal(again.applied, false);
      assert.equal(again.replayed, true);
    }
    assert.equal(balance(env, invoiceId), 0, 'paid once');
    const receipts = env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_payments
      WHERE workspace_id = ? AND direction = 'CUSTOMER_RECEIPT'`).get(env.workspace.workspaceId).n;
    assert.equal(receipts, 1, 'one receipt, however many times the provider tried to tell us');
  } finally { undo(); }
});

test('an event about something Foundry never asked for is recorded and not acted on', async () => {
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const stranger = collection.receiveEvent(env.db, env.ctx, 'fake',
      { id: 'evt_stranger', type: 'paid', invoice: 'in_not_ours', amount: 999999 });
    assert.equal(stranger.applied, false);
    assert.match(stranger.outcome, /No payment request in this inventory matches/);

    const ignored = collection.receiveEvent(env.db, env.ctx, 'fake', { id: 'evt_noise', type: 'customer.updated' });
    assert.equal(ignored.applied, false);

    const receipts = env.db.prepare("SELECT COUNT(*) AS n FROM accounting_payments").get().n;
    assert.equal(receipts, 0, 'nothing was written into the books');
    const kept = env.db.prepare('SELECT COUNT(*) AS n FROM payment_provider_events').get().n;
    assert.equal(kept, 2, 'but both events were kept, so the silence is explainable');
  } finally { undo(); }
});

test('a failed payment is reported on the request, and pays nothing', async () => {
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const { order, invoiceId } = invoicedOrder(env);
    const asked = await collection.request(env.db, env.ctx, order.id, { provider: 'fake' });
    const result = collection.receiveEvent(env.db, env.ctx, 'fake',
      { id: 'evt_fail', type: 'failed', invoice: asked.externalInvoiceId });
    assert.equal(result.applied, false);
    assert.match(result.request.lastError, /card was declined/);
    assert.equal(result.request.status, 'OPEN', 'still open, because they can try again');
    assert.equal(balance(env, invoiceId), 150000, 'nothing was paid');
  } finally { undo(); }
});

test('Foundry will not ask for money it is not owed, or from somebody it cannot reach', async () => {
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const customer = sales.createCustomer(env.db, env.ctx, { name: 'No Email Co' });
    inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20 });
    const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
      customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 5 }],
    }).id);

    await assert.rejects(() => collection.request(env.db, env.ctx, order.id, { provider: 'fake' }),
      /no invoice on this order yet/);

    const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
      customerId: customer.id, salesOrderId: order.id, issueDate: '2026-09-02',
      lines: [{ description: 'Shirts', quantity: 5, unitPriceMinor: 1500 }],
    });
    receivables.open(env.db, env.ctx, env.membership, invoice.id);

    await assert.rejects(() => collection.request(env.db, env.ctx, order.id, { provider: 'fake' }),
      /no email address for No Email Co/);
  } finally { undo(); }
});

test('Stripe events are translated into the four facts Foundry acts on', () => {
  const paid = stripe.readEvent({
    type: 'invoice.payment_succeeded',
    data: { object: { id: 'in_1', payment_intent: 'pi_1', amount_paid: 45000, amount_due: 150000,
      currency: 'usd', status_transitions: { paid_at: 1788000000 } } },
  });
  assert.equal(paid.kind, 'PAID');
  assert.equal(paid.externalInvoiceId, 'in_1');
  assert.equal(paid.amountMinor, 45000, 'what actually arrived, not what was billed');
  assert.equal(paid.currency, 'USD');

  assert.equal(stripe.readEvent({ type: 'invoice.payment_failed', data: { object: { id: 'in_2' } } }).kind, 'FAILED');
  assert.equal(stripe.readEvent({ type: 'charge.refunded', data: { object: { invoice: 'in_3' } } }).kind, 'REFUNDED');
  assert.equal(stripe.readEvent({ type: 'customer.subscription.updated', data: { object: {} } }).kind, 'IGNORED');
});

test('an event that did not come from Stripe is refused', () => {
  const crypto = require('node:crypto');
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const timestamp = Math.floor(Date.now() / 1000);
  const good = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  assert.doesNotThrow(() => stripe.verifyEvent(body,
    { 'stripe-signature': `t=${timestamp},v1=${good}` }, { webhookSecret: secret }));

  assert.throws(() => stripe.verifyEvent(body,
    { 'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}` }, { webhookSecret: secret }),
  /did not come from Stripe/);

  assert.throws(() => stripe.verifyEvent(body, {}, { webhookSecret: secret }),
    /without a Stripe signature/);

  const old = timestamp - 3600;
  const oldSignature = crypto.createHmac('sha256', secret).update(`${old}.${body}`).digest('hex');
  assert.throws(() => stripe.verifyEvent(body,
    { 'stripe-signature': `t=${old},v1=${oldSignature}` }, { webhookSecret: secret }),
  /too old to accept/);
});
