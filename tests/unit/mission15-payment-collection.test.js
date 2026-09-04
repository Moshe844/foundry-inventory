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
const payments = require('../../src/accounting/payments');
const prices = require('../../src/pricing/price-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

// The books open the day the test runs; a date before that is refused, so fixtures are dated today.
const TODAY = new Date().toISOString().slice(0, 10);

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
    customerId: customer.id, salesOrderId: order.id, issueDate: TODAY,
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

    // An invoice is no longer a precondition: a deposit is asked for before one exists.

    const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
      customerId: customer.id, salesOrderId: order.id, issueDate: TODAY,
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

test('a Stripe event is understood whether or not it carries a version prefix', () => {
  /*
   * Stripe's Workbench now lists events as "v1.billing.meter.no_meter_found",
   * and an endpoint created against a newer API version can deliver the
   * invoice events the same way.
   *
   * Matching the bare string meant such an event passed its signature check,
   * returned 200, and did nothing — Stripe showing the delivery as successful
   * while the payment never reached the books. Silence is the expensive
   * failure here, so both spellings are asserted.
   */
  const paid = { data: { object: { id: 'in_9', amount_paid: 4000, currency: 'usd' } } };
  assert.equal(stripe.readEvent({ ...paid, type: 'invoice.paid' }).kind, 'PAID');
  assert.equal(stripe.readEvent({ ...paid, type: 'v1.invoice.paid' }).kind, 'PAID');
  assert.equal(stripe.readEvent({ ...paid, type: 'v1.invoice.payment_succeeded' }).kind, 'PAID');
  assert.equal(stripe.readEvent({ ...paid, type: 'v1.invoice.payment_failed' }).kind, 'FAILED');
  assert.equal(stripe.readEvent({ ...paid, type: 'v1.charge.refunded' }).kind, 'REFUNDED');

  // The amount still comes off the event, not from the prefix being stripped.
  assert.equal(stripe.readEvent({ ...paid, type: 'v1.invoice.paid' }).amountMinor, 4000);

  // And an event Foundry has no business acting on is still ignored.
  const unrelated = stripe.readEvent({ type: 'v1.billing.meter.no_meter_found', data: { object: {} } });
  assert.equal(unrelated.kind, 'IGNORED');
  assert.match(unrelated.reason, /does not act on/);
});

test('two events describing one payment record it once', async () => {
  /*
   * Stripe sends invoice.paid and invoice.payment_succeeded for the same card
   * payment, with different event ids and the same amount_paid. Foundry
   * deduplicated on the event id, so both got through and each added the full
   * figure again: one $300.00 payment became $600.00 in the books, and the
   * request said it had been paid twice over.
   *
   * What the provider reports is the invoice's running total. Foundry records
   * the difference between that and what it has already recorded.
   */
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const { order, invoiceId } = invoicedOrder(env);
    const asked = await collection.request(env.db, env.ctx, order.id, { provider: 'fake' });
    const paidEvent = (id) => ({ id, type: 'paid', invoice: asked.externalInvoiceId,
      pi: 'pi_1', amount: asked.amountMinor });

    const first = collection.receiveEvent(env.db, env.ctx, 'fake', paidEvent('evt_paid'));
    assert.equal(first.applied, true);
    assert.equal(first.amountMinor, asked.amountMinor);

    const second = collection.receiveEvent(env.db, env.ctx, 'fake', paidEvent('evt_succeeded'));
    assert.equal(second.applied, false, 'the same money, reported again, is not more money');
    assert.match(second.outcome, /already recorded/i);

    const receipts = env.db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS total, COUNT(*) AS n
      FROM accounting_payments WHERE workspace_id = ? AND direction = 'CUSTOMER_RECEIPT'`)
      .get(env.workspace.workspaceId);
    assert.equal(receipts.n, 1, 'one payment');
    assert.equal(receipts.total, asked.amountMinor, 'for exactly what was charged');

    const request = collection.get(env.db, env.workspace.workspaceId, asked.id);
    assert.equal(request.paidMinor, asked.amountMinor, 'and the request is not paid twice over');
    assert.equal(balance(env, invoiceId), 0, 'the invoice is settled once, not overpaid');
  } finally { undo(); env.db.close(); }
});

test('a customer paying in two parts still has both recorded', async () => {
  // The guard is arithmetic, not a lock.
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const { order } = invoicedOrder(env);
    const asked = await collection.request(env.db, env.ctx, order.id, { provider: 'fake' });
    const half = Math.floor(asked.amountMinor / 2);

    const one = collection.receiveEvent(env.db, env.ctx, 'fake',
      { id: 'evt_1', type: 'paid', invoice: asked.externalInvoiceId, pi: 'pi_1', amount: half });
    assert.equal(one.applied, true);
    assert.equal(one.amountMinor, half);

    const two = collection.receiveEvent(env.db, env.ctx, 'fake',
      { id: 'evt_2', type: 'paid', invoice: asked.externalInvoiceId, pi: 'pi_2', amount: asked.amountMinor });
    assert.equal(two.applied, true, 'the rest of the money is still money');
    assert.equal(two.amountMinor, asked.amountMinor - half, 'and only the rest of it');

    assert.equal(env.db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS total
      FROM accounting_payments WHERE workspace_id = ? AND direction = 'CUSTOMER_RECEIPT'`)
      .get(env.workspace.workspaceId).total, asked.amountMinor);
  } finally { undo(); env.db.close(); }
});

test('money paid before the invoice existed is applied to it when it appears', async () => {
  /*
   * A customer paid $300.00 up front. A sale's invoice is only raised when the
   * goods go, so the receipt was recorded against the order and allocated to
   * nothing. Shipping then raised the invoice — unpaid — and the Orders list
   * read "Shipped — $300.00 still owed" about an order whose money was already
   * in the bank.
   */
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const customer = sales.createCustomer(env.db, env.ctx, { name: 'Paid Up Front', email: 'a@b.test' });
    inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
    const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
      customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 2 }],
    }).id);

    // Paid before anything is invoiced, exactly as a card payment on the order is.
    payments.record(env.db, env.ctx, env.membership, {
      direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: TODAY,
      amountMinor: 3000, method: 'card', sourceKey: 'paid-up-front',
      salesOrderId: order.id, allocations: [],
    });

    // Then the goods go, and the invoice for them is raised.
    const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
      customerId: customer.id, salesOrderId: order.id, issueDate: TODAY,
      lines: [{ description: 'Shirts', quantity: 2, unitPriceMinor: 1500 }],
    });
    const opened = receivables.open(env.db, env.ctx, env.membership, invoice.id);

    assert.equal(Number(opened.total_minor), 3000);
    assert.equal(Number(opened.balance_minor), 0, 'the money they already paid is on it');
    assert.equal(opened.status, 'PAID');
  } finally { undo(); env.db.close(); }
});

test('a deposit covers part of the invoice, and the rest is still owed', async () => {
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const customer = sales.createCustomer(env.db, env.ctx, { name: 'Deposit Co', email: 'd@b.test' });
    inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
    const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
      customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 4 }],
    }).id);
    payments.record(env.db, env.ctx, env.membership, {
      direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: TODAY,
      amountMinor: 2000, method: 'card', sourceKey: 'deposit', salesOrderId: order.id, allocations: [],
    });

    const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
      customerId: customer.id, salesOrderId: order.id, issueDate: TODAY,
      lines: [{ description: 'Shirts', quantity: 4, unitPriceMinor: 1500 }],
    });
    const opened = receivables.open(env.db, env.ctx, env.membership, invoice.id);

    assert.equal(Number(opened.total_minor), 6000);
    assert.equal(Number(opened.balance_minor), 4000, 'the deposit came off, the rest is owed');
    assert.equal(opened.status, 'OPEN');
  } finally { undo(); env.db.close(); }
});

test('paying more than the invoice leaves the excess as the customer’s money', async () => {
  // Overpayment must not be written off against an invoice that does not owe it.
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const customer = sales.createCustomer(env.db, env.ctx, { name: 'Over Co', email: 'o@b.test' });
    inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
    const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
      customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 2 }],
    }).id);
    payments.record(env.db, env.ctx, env.membership, {
      direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: TODAY,
      amountMinor: 5000, method: 'card', sourceKey: 'too-much', salesOrderId: order.id, allocations: [],
    });

    const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
      customerId: customer.id, salesOrderId: order.id, issueDate: TODAY,
      lines: [{ description: 'Shirts', quantity: 2, unitPriceMinor: 1500 }],
    });
    const opened = receivables.open(env.db, env.ctx, env.membership, invoice.id);

    assert.equal(Number(opened.balance_minor), 0);
    const applied = env.db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS n
      FROM accounting_payment_allocations WHERE customer_invoice_id = ?`).get(invoice.id).n;
    assert.equal(applied, 3000, 'only what the invoice was for');
  } finally { undo(); env.db.close(); }
});

test('money held on a cancelled order is put in front of a person', async () => {
  /*
   * Take $300.00, then cancel the order: the money stays in the bank, no
   * invoice exists, nothing is owed to anybody — and nothing anywhere said the
   * customer was owed it back. Every figure was right and a person was owed
   * three hundred dollars that no screen mentioned.
   */
  const env = setup();
  const needsYou = require('../../src/manager/needs-you-inbox');
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'Changed Their Mind', email: 'c@b.test' });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 2 }],
  }).id);
  payments.record(env.db, env.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: TODAY,
    amountMinor: 3000, method: 'card', sourceKey: 'cancel-me', salesOrderId: order.id, allocations: [],
  });

  assert.deepEqual(needsYou.fromMoneyHeldOnCancelledOrders(env.db, env.workspace.workspaceId), [],
    'nothing to decide while the order is alive');

  sales.cancel(env.db, env.ctx, order.id, 'Customer changed their mind');

  const [entry] = needsYou.fromMoneyHeldOnCancelledOrders(env.db, env.workspace.workspaceId);
  assert.ok(entry, 'the money is put in front of somebody');
  assert.match(entry.title, /Changed Their Mind paid USD 30\.00 for SO-\d+, which was cancelled/);
  assert.match(entry.recommendation, /Refund USD 30\.00 to Changed Their Mind, or keep it/);
  assert.match(entry.why, /never takes by itself/);
  assert.equal(entry.href, `/orders/${order.id}#money`);

  // And it is in the queue a person actually looks at.
  assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId).some((row) => row.id === `refund-held:${order.id}`));
  env.db.close();
});

test('money already applied to an invoice is not asked about again', async () => {
  // Only money doing nothing is a decision. A cancelled order whose payment
  // settled an invoice for what did ship is finished with.
  const env = setup();
  const needsYou = require('../../src/manager/needs-you-inbox');
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'Partly Shipped', email: 'p@b.test' });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 2 }],
  }).id);
  const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
    customerId: customer.id, salesOrderId: order.id, issueDate: TODAY,
    lines: [{ description: 'Shirts', quantity: 2, unitPriceMinor: 1500 }],
  });
  receivables.open(env.db, env.ctx, env.membership, invoice.id);
  payments.record(env.db, env.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: TODAY,
    amountMinor: 3000, method: 'card', sourceKey: 'settled', salesOrderId: order.id,
    allocations: [{ invoiceId: invoice.id, amountMinor: 3000 }],
  });
  sales.cancel(env.db, env.ctx, order.id, 'Rest not wanted');

  assert.deepEqual(needsYou.fromMoneyHeldOnCancelledOrders(env.db, env.workspace.workspaceId), [],
    'that money did its job');
  env.db.close();
});

test('a supplier paid before their bill arrived is a decision, not a silent debt', async () => {
  /*
   * Pay a supplier up front and the money sits as an advance. When their bill
   * arrives it is raised unpaid, so Foundry shows a debt to a supplier who
   * already has the money — and says nothing about the money it is holding.
   *
   * Not applied automatically: a payment to a supplier names the supplier and
   * not the order, so Foundry cannot tell an early settlement from a deposit
   * for something else. Guessing would be deciding where money went.
   */
  const env = setup();
  const needsYou = require('../../src/manager/needs-you-inbox');
  const supplierService = require('../../src/purchasing/supplier-service');
  const payablesService = require('../../src/accounting/payables');
  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership,
    { name: 'Paid Early Ltd', email: 's@b.test', currency: 'USD' });

  payments.record(env.db, env.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: supplier.id, paymentDate: TODAY,
    amountMinor: 27000, method: 'bank_transfer', sourceKey: 'prepay', allocations: [],
  });
  assert.deepEqual(needsYou.fromSupplierMoneyNotOnAnyBill(env.db, env.workspace.workspaceId), [],
    'money on account with nothing owed is not yet a decision');

  const bill = payablesService.createDraft(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, billNumber: 'B-1', issueDate: TODAY, dueDate: TODAY,
    lines: [{ description: '10 Widgets', quantity: 10, unitCostMinor: 2700 }],
  });
  payablesService.open(env.db, env.ctx, env.membership, bill.bill.id);

  const [entry] = needsYou.fromSupplierMoneyNotOnAnyBill(env.db, env.workspace.workspaceId);
  assert.ok(entry, 'now there is money and a bill it could belong to');
  assert.match(entry.title, /Paid Early Ltd has USD 270\.00 of yours that is not against any bill/);
  assert.match(entry.happened, /USD 270\.00 of their bills still says it is owed/);
  assert.match(entry.recommendation, /Put it against that bill/);
  assert.equal(entry.href, '/accounting/payables');
  assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId)
    .some((row) => row.id === `supplier-advance:${supplier.id}`));

  // Once it is matched, there is nothing left to decide.
  const prepayment = env.db.prepare(
    'SELECT id FROM accounting_payments WHERE workspace_id = ? AND source_key = ?')
    .get(env.workspace.workspaceId, 'prepay');
  env.db.prepare(`INSERT INTO accounting_payment_allocations
      (id, workspace_id, payment_id, supplier_bill_id, amount_minor, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('alloc-test', env.workspace.workspaceId, prepayment.id, bill.bill.id, 27000, TODAY);
  assert.deepEqual(needsYou.fromSupplierMoneyNotOnAnyBill(env.db, env.workspace.workspaceId), [],
    'money that has been matched is not asked about again');
  env.db.close();
});

test('a payment link raised against the order settles the invoice that already exists', async () => {
  /*
   * The ordinary shape of a shop's day, and the one nobody had covered.
   *
   * The customer was invoiced, then sent a link and paid it. Stripe charged
   * them, the webhook arrived, and the receipt posted to the ledger against
   * the right order — and the order went on reading "$100.00 still owed /
   * Unpaid", because nothing applied the money to the invoice.
   *
   * Two halves of this already worked and each covered one order of events. A
   * link raised against an invoice carries its id and allocates on the way in.
   * An invoice raised after the money arrived sweeps up what the order has
   * already paid. Neither covered invoice first, then a link raised against
   * the order — which has no invoice id to carry.
   */
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const { order, invoiceId } = invoicedOrder(env, 2);
    assert.equal(balance(env, invoiceId), 3000, 'invoiced and unpaid, as it should start');

    // A link for the balance on the order. It names no invoice, because the
    // owner asked for the order to be paid, not for one document to be settled.
    const asked = await collection.request(env.db, env.ctx, order.id, { provider: 'fake' });
    env.db.prepare('UPDATE payment_requests SET invoice_id = NULL WHERE id = ?').run(asked.id);

    const paid = collection.receiveEvent(env.db, env.ctx, 'fake',
      { id: 'evt_link', type: 'paid', invoice: asked.externalInvoiceId, pi: 'pi_link', amount: 3000 });
    assert.equal(paid.applied, true);

    assert.equal(balance(env, invoiceId), 0, 'the money the customer sent is on the invoice');
    assert.equal(env.db.prepare('SELECT status FROM accounting_customer_invoices WHERE id = ?')
      .get(invoiceId).status, 'PAID');

    // And the books agree: nothing is left sitting as money held.
    const held = env.db.prepare(`SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) AS n
      FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id = l.account_id
      WHERE a.system_key = 'CUSTOMER_DEPOSITS' AND l.workspace_id = ?`)
      .get(env.workspace.workspaceId).n;
    assert.equal(Number(held), 0, 'the deposit became a settled debt rather than staying a liability');
  } finally { undo(); env.db.close(); }
});

test('receipts left unapplied by an older build are settled, and settling twice changes nothing', async () => {
  const env = setup();
  const undo = registry.register('fake', fakeProvider());
  try {
    const { customer, order, invoiceId } = invoicedOrder(env, 2);
    // Exactly what the hole left behind: posted, against the order, allocated
    // to nothing, with the invoice still saying the money is owed.
    payments.record(env.db, env.ctx, env.membership, {
      direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: TODAY,
      amountMinor: 3000, method: 'card', sourceKey: 'stripe:stranded:paid:3000',
      salesOrderId: order.id, allocations: [],
    });
    env.db.prepare(`DELETE FROM accounting_payment_allocations WHERE payment_id IN
      (SELECT id FROM accounting_payments WHERE source_key = 'stripe:stranded:paid:3000')`).run();
    env.db.prepare('UPDATE accounting_customer_invoices SET balance_minor = 3000, status = ? WHERE id = ?')
      .run('OPEN', invoiceId);

    const settled = receivables.settleUnappliedReceipts(env.db, env.ctx);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].appliedMinor, 3000);
    assert.equal(balance(env, invoiceId), 0);

    assert.deepEqual(receivables.settleUnappliedReceipts(env.db, env.ctx), [],
      'a repair that has nothing to repair does nothing');
  } finally { undo(); env.db.close(); }
});
