'use strict';

/*
 * Two bugs found on the first live Stripe run, within a minute of each other.
 *
 * Foundry created an invoice, Stripe finalised it for $0.00, decided a $0.00
 * invoice was already settled, and sent invoice.paid. Foundry recorded $10.00
 * against the order. Nothing had been paid, nothing had even been billed — the
 * line item was sitting on the customer attached to no invoice at all — and
 * both the app and the Stripe dashboard reported success.
 *
 * The first bug made an empty invoice. The second turned it into money:
 * a fallback that used the amount Foundry had asked for whenever the provider
 * reported none. That one is the serious one, because it applies to every
 * provider and every event, and it makes Foundry state a figure nobody gave it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const stripe = require('../../src/payments/providers/stripe');
const collection = require('../../src/payments/collection');
const providers = require('../../src/payments/provider');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/inventory-engine');
const receivables = require('../../src/accounting/receivables');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

// The books open the day the test runs; a date before that is refused, so fixtures are dated today.
const TODAY = new Date().toISOString().slice(0, 10);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '10.00', currency: 'USD' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 20 });
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  return { db, workspace, ctx: { ...workspace.ctx, membership }, membership, item };
}

/* A provider that answers exactly what the test wants it to answer. */
function fakeProvider(overrides = {}) {
  return {
    name: 'faux',
    createCustomer: async () => ({ externalCustomerId: 'cus_test' }),
    createInvoice: async () => ({ externalInvoiceId: 'in_test', hostedUrl: 'https://pay.test/1', status: 'open' }),
    getHostedPaymentUrl: async () => 'https://pay.test/1',
    refundPayment: async () => ({ ok: true }),
    verifyEvent: () => true,
    readEvent: () => ({ kind: 'PAID', externalInvoiceId: 'in_test', ...overrides }),
  };
}

/* An order with a real invoice on it, which is what a payment can be asked for. */
async function askFor(env, provider) {
  providers.register(provider.name, provider);
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School', email: 'jo@abcschool.test' });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 1 }],
  }).id);
  const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
    customerId: customer.id, salesOrderId: order.id, issueDate: TODAY,
    lines: [{ description: 'Shirt', quantity: 1, unitPriceMinor: 1000 }],
  });
  receivables.open(env.db, env.ctx, env.membership, invoice.id);
  return collection.request(env.db, env.ctx, order.id, { provider: provider.name, purpose: 'FULL' });
}
test('a provider reporting that nothing was paid records nothing', async () => {
  const env = setup();
  // Stripe's exact answer on the empty invoice: settled, with zero collected.
  const provider = fakeProvider({ amountMinor: 0, currency: 'USD' });
  await askFor(env, provider);

  const result = collection.receiveEvent(env.db, env.ctx, provider.name, { id: 'evt_zero' });

  assert.equal(result.applied, false, 'nothing arrived, so nothing is recorded');
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_payments`).get().n, 0,
    'and no receipt reaches the books');
  assert.match(result.outcome, /nothing paid|without an amount/i);
  assert.match(result.outcome, /Check the invoice/i, 'it points at where the truth is');
});

test('a provider reporting no amount at all records nothing either', async () => {
  const env = setup();
  const provider = fakeProvider({ amountMinor: undefined, currency: 'USD' });
  await askFor(env, provider);

  const result = collection.receiveEvent(env.db, env.ctx, provider.name, { id: 'evt_missing' });

  assert.equal(result.applied, false);
  assert.match(result.outcome, /without an amount/i);
  assert.match(result.outcome, /will not supply the figure itself/i);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_payments`).get().n, 0);
});

test('a real payment is still recorded at the amount the provider reports', async () => {
  const env = setup();
  // Deliberately not the amount asked for: a part payment is normal, and the
  // figure that counts is the one that arrived.
  const provider = fakeProvider({ amountMinor: 600, currency: 'USD' });
  await askFor(env, provider);

  const result = collection.receiveEvent(env.db, env.ctx, provider.name, { id: 'evt_part' });

  assert.equal(result.applied, true);
  assert.equal(result.amountMinor, 600, 'what arrived, not what was hoped for');
  const receipt = env.db.prepare(`SELECT amount_minor FROM accounting_payments`).get();
  assert.equal(receipt.amount_minor, 600);
});

test('Stripe reading an invoice reports zero as zero, not as absent', () => {
  /*
   * The guard above is only as good as what reaches it, and this is the exact
   * payload that started all of it.
   */
  const read = stripe.readEvent({
    type: 'invoice.paid',
    data: { object: { id: 'in_1', amount_paid: 0, amount_due: 0, currency: 'usd' } },
  });
  assert.equal(read.kind, 'PAID');
  assert.equal(read.amountMinor, 0, 'zero survives the read rather than becoming undefined');
});
