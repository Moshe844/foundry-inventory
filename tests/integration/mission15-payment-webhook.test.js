'use strict';

/*
 * The webhook, over HTTP.
 *
 * This is the only route in Foundry a stranger can reach without signing in, so
 * these tests are mostly about what it refuses. An unsigned claim that an
 * invoice was paid must not become an entry in somebody's books.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const registry = require('../../src/payments/provider');
const collection = require('../../src/payments/collection');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const receivables = require('../../src/accounting/receivables');
const prices = require('../../src/pricing/price-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

const SECRET = 'whsec_for_tests';

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '15.00', currency: 'USD' });
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  const app = createApp({ db, env: 'test', sessionSecret: 'payment-webhook' });
  return { db, workspace, ctx: { ...workspace.ctx, membership }, membership, item, app };
}

/** A provider whose signature check is Stripe's, so the route is tested as it runs. */
function signedProvider() {
  const stripe = require('../../src/payments/providers/stripe');
  return {
    async createCustomer() { return { externalCustomerId: 'cus_1' }; },
    async createInvoice() { return { externalInvoiceId: 'in_1', hostedUrl: 'https://pay.test/in_1' }; },
    async getHostedPaymentUrl() { return 'https://pay.test/in_1'; },
    async refundPayment() { return { externalRefundId: 're_1' }; },
    verifyEvent(raw, headers) { return stripe.verifyEvent(raw, headers, { webhookSecret: SECRET }); },
    readEvent(event) {
      return event.type === 'invoice.paid'
        ? { kind: 'PAID', externalInvoiceId: event.data.object.id,
          externalPaymentId: event.data.object.payment_intent,
          amountMinor: event.data.object.amount_paid, currency: 'USD', method: 'card' }
        : { kind: 'IGNORED' };
    },
  };
}

function sign(body) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function invoicedOrder(env) {
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School', email: 'orders@abcschool.test' });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 200 });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 100 }],
  }).id);
  const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
    customerId: customer.id, salesOrderId: order.id, issueDate: '2026-09-02',
    lines: [{ description: 'Shirts', quantity: 100, unitPriceMinor: 1500 }],
  });
  receivables.open(env.db, env.ctx, env.membership, invoice.id);
  const asked = await collection.request(env.db, env.ctx, order.id, { provider: 'signed' });
  return { customer, order, invoiceId: invoice.id, asked };
}

const balance = (env, invoiceId) => Number(env.db
  .prepare('SELECT balance_minor FROM accounting_customer_invoices WHERE id = ?').get(invoiceId).balance_minor);

test('a properly signed payment event is recorded, and an unsigned one is refused', async () => {
  const env = setup();
  const undo = registry.register('signed', signedProvider());
  try {
    const { invoiceId, asked } = await invoicedOrder(env);
    const body = JSON.stringify({
      id: 'evt_http_1', type: 'invoice.paid',
      data: { object: { id: asked.externalInvoiceId, payment_intent: 'pi_1', amount_paid: 150000 } },
    });
    const url = `/webhooks/payments/signed/${env.workspace.workspaceId}`;

    // Unsigned: refused, and nothing is written.
    const unsigned = await request(env.app).post(url).set('content-type', 'application/json').send(body);
    assert.equal(unsigned.status, 400);
    assert.match(unsigned.body.error, /without a Stripe signature/);
    assert.equal(balance(env, invoiceId), 150000, 'a stranger cannot pay an invoice by asserting it');

    // Signed by somebody who is not the provider: also refused.
    const forged = await request(env.app).post(url)
      .set('content-type', 'application/json')
      .set('stripe-signature', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`)
      .send(body);
    assert.equal(forged.status, 400);
    assert.equal(balance(env, invoiceId), 150000);

    // Properly signed: recorded.
    const real = await request(env.app).post(url)
      .set('content-type', 'application/json')
      .set('stripe-signature', sign(body))
      .send(body);
    assert.equal(real.status, 200);
    assert.equal(real.body.applied, true);
    assert.equal(balance(env, invoiceId), 0, 'paid, through the ordinary payment engine');
  } finally { undo(); }
});

test('a redelivered webhook answers 200 and changes nothing', async () => {
  const env = setup();
  const undo = registry.register('signed', signedProvider());
  try {
    const { invoiceId, asked } = await invoicedOrder(env);
    const body = JSON.stringify({
      id: 'evt_http_same', type: 'invoice.paid',
      data: { object: { id: asked.externalInvoiceId, payment_intent: 'pi_2', amount_paid: 150000 } },
    });
    const url = `/webhooks/payments/signed/${env.workspace.workspaceId}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(env.app).post(url)
        .set('content-type', 'application/json').set('stripe-signature', sign(body)).send(body);
      assert.equal(response.status, 200, 'a retry must not look like a failure, or it retries forever');
    }
    assert.equal(balance(env, invoiceId), 0);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM accounting_payments").get().n, 1,
      'three deliveries, one receipt');
  } finally { undo(); }
});

test('an event for an inventory or a provider that does not exist is a plain 404', async () => {
  const env = setup();
  const undo = registry.register('signed', signedProvider());
  try {
    const body = JSON.stringify({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } });
    const wrongProvider = await request(env.app)
      .post(`/webhooks/payments/nobody/${env.workspace.workspaceId}`)
      .set('stripe-signature', sign(body)).set('content-type', 'application/json').send(body);
    assert.equal(wrongProvider.status, 404);

    const wrongWorkspace = await request(env.app)
      .post('/webhooks/payments/signed/wsp_does_not_exist')
      .set('stripe-signature', sign(body)).set('content-type', 'application/json').send(body);
    assert.equal(wrongWorkspace.status, 404);
  } finally { undo(); }
});

test('the webhook needs no session, and does not disturb the signed-in app', async () => {
  const env = setup();
  const undo = registry.register('signed', signedProvider());
  try {
    const { asked } = await invoicedOrder(env);
    const body = JSON.stringify({
      id: 'evt_nosession', type: 'invoice.paid',
      data: { object: { id: asked.externalInvoiceId, payment_intent: 'pi_3', amount_paid: 50000 } },
    });
    // No agent, no cookie, no CSRF token: exactly how a provider arrives.
    const response = await request(env.app)
      .post(`/webhooks/payments/signed/${env.workspace.workspaceId}`)
      .set('content-type', 'application/json').set('stripe-signature', sign(body)).send(body);
    assert.equal(response.status, 200);
    assert.equal(response.body.applied, true);

    // And an ordinary page still works, so the early mount broke nothing.
    const { signIn } = require('../helpers');
    const agent = request.agent(env.app);
    await signIn(agent, env.workspace.account.email, env.workspace.account.password);
    assert.equal((await agent.get('/orders')).status, 200);
  } finally { undo(); }
});
