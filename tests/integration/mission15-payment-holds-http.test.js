'use strict';

/*
 * Payment holds through the screens.
 *
 * The engine tests prove the arithmetic and the refusal. These prove the owner
 * can see why an order is stuck, and let one through without changing what they
 * agreed with the customer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const terms = require('../../src/sales/payment-terms');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const receivables = require('../../src/accounting/receivables');
const payments = require('../../src/accounting/payments');
const prices = require('../../src/pricing/price-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '15.00', currency: 'USD' });
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  const app = createApp({ db, env: 'test', sessionSecret: 'payment-holds' });
  return { db, workspace, ctx: workspace.ctx, membership, item, app };
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

test('an order held for payment says so, names the amount, and offers no picking', async () => {
  const env = setup();
  const { customer, order } = invoicedOrder(env);
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'BEFORE_FULFILMENT' });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get(`/orders/${order.id}`);
  const text = plain(page.text);
  assert.match(text, /This order is on hold until it is paid/);
  assert.match(text, /\$1500\.00 is still owed/);
  assert.match(text, /Pays in full before anything is picked/);
  assert.match(text, /Let this one order through anyway/);

  // And the route refuses too, not only the page.
  const refused = await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) });
  assert.equal(refused.status, 303);
  assert.match(plain((await agent.get(refused.headers.location)).text), /pays before anything is picked/);
});

test('the owner can let one order through, and the page says they did', async () => {
  const env = setup();
  const { customer, order } = invoicedOrder(env);
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'BEFORE_FULFILMENT' });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  let page = await agent.get(`/orders/${order.id}`);

  const allowed = await agent.post(`/sales/orders/${order.id}/payment-hold`).type('form')
    .send({ _csrf: csrfFrom(page.text), action: 'override', reason: 'Called John, cheque is in the post.' });
  assert.equal(allowed.status, 303);

  page = await agent.get(`/orders/${order.id}`);
  const text = plain(page.text);
  assert.match(text, /You let this one through unpaid/);
  assert.match(text, /Called John, cheque is in the post/);
  assert.match(text, /Put the hold back/);

  const picked = await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) });
  assert.match(picked.headers.location, /^\/fulfilment\//, 'it picks now');

  // Their terms did not change; only this order was let through.
  assert.equal(terms.forCustomer(env.db, env.workspace.workspaceId, customer.id).kind, 'BEFORE_FULFILMENT');
});

test('a deposit shows what is due now, and clears once it is paid', async () => {
  const env = setup();
  const { customer, order, invoiceId } = invoicedOrder(env);
  terms.setTerms(env.db, env.ctx, {
    customerId: customer.id, kind: 'DEPOSIT', depositPercent: 30, holdShipping: true,
  });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let text = plain((await agent.get(`/orders/${order.id}`)).text);
  assert.match(text, /\$450\.00\s*due now/);
  assert.match(text, /deposit of \$450\.00 is due before this is picked/);

  payments.record(env.db, env.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: '2026-09-03',
    amountMinor: 45000, method: 'card', sourceKey: 'http:deposit',
    allocations: [{ invoiceId, amountMinor: 45000 }],
  });

  text = plain((await agent.get(`/orders/${order.id}`)).text);
  assert.doesNotMatch(text, /due now/, 'the deposit is covered');
  assert.match(text, /cannot ship until it is paid/, 'but the balance still holds the parcel');
  assert.match(text, /\$1050\.00 is still owed/);
});

test('terms are agreed on the customer, and the order repeats them word for word', async () => {
  const env = setup();
  const { customer, order } = invoicedOrder(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const customerPage = await agent.get(`/sales/customers/${customer.id}`);
  assert.match(plain(customerPage.text), /How ABC School pays/);

  const saved = await agent.post(`/sales/customers/${customer.id}/terms`).type('form').send({
    _csrf: csrfFrom(customerPage.text), kind: 'DEPOSIT', depositPercent: '50', holdShipping: '1',
  });
  assert.equal(saved.status, 303);

  const sentence = terms.describe(terms.forCustomer(env.db, env.workspace.workspaceId, customer.id));
  assert.equal(sentence, 'Pays 50% of the order up front, and the balance before it ships.');
  assert.match(plain((await agent.get(`/orders/${order.id}`)).text), /Pays 50% of the order up front/,
    'the order says what the customer page says');

  // Nonsense is refused in words rather than saved.
  const refused = await agent.post(`/sales/customers/${customer.id}/terms`).type('form')
    .send({ _csrf: csrfFrom(customerPage.text), kind: 'DEPOSIT', depositPercent: '', depositMinor: '' });
  assert.equal(refused.status, 303);
  assert.match(plain((await agent.get(`/sales/customers/${customer.id}`)).text),
    /how much of the order they pay up front/);
});
