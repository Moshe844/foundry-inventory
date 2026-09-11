'use strict';

/*
 * Foundry learning that money moved.
 *
 * On a real account it never did. Stripe fired charge.failed,
 * payment_intent.payment_failed and invoice.payment_failed; Foundry's
 * payment_provider_events table had zero rows in it, ever, and the order went
 * on saying $300.00 was still owed.
 *
 * Two faults, and each one alone was enough.
 *
 * The address Stripe was given had a workspace id baked into it. One Stripe
 * account serves every inventory an owner has, so that id was a guess made
 * once at setup about where money would arrive for ever after — and the
 * inventory it named had since been deleted. Every event got a 404.
 *
 * And the address was a tunnel that was not running. Nothing could arrive
 * however well it was addressed, which is why Foundry no longer waits to be
 * told: it asks, and the answer travels the same code path as the event would
 * have.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { fakeProvider } = require('../helpers/fake-provider');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, makeQuantityItem, plain } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const collection = require('../../src/payments/collection');
const registry = require('../../src/payments/provider');
const stripe = require('../../src/payments/providers/stripe');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/inventory-engine');
const receivables = require('../../src/accounting/receivables');

test.after(cleanupAll);

const TODAY = new Date().toISOString().slice(0, 10);

/** A provider that can be asked, the way Stripe now can. */
function askable(invoice) {
  return {
    async createCustomer() { return { externalCustomerId: 'cus_1' }; },
    async createInvoice() { return { externalInvoiceId: 'in_1', hostedUrl: 'https://pay.test/in_1' }; },
    async getHostedPaymentUrl() { return 'https://pay.test/in_1'; },
    async refundPayment() { return { externalRefundId: 're_1' }; },
    verifyEvent(raw) { return typeof raw === 'string' ? JSON.parse(raw) : raw; },
    readEvent: stripe.readEvent,
    eventFromInvoice: stripe.eventFromInvoice,
    async readInvoice() { return invoice(); },
  };
}

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'HalFi Shoes' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  require('../../src/accounting/automatic').ensure(store.db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Loafer', baseCode: 'LOAF' });
  prices.setPrice(store.db, workspace.ctx, { skuId: item.skuId, amount: '150.00', currency: 'USD' });
  inventory.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 });
  const customer = sales.createCustomer(store.db, workspace.ctx, { name: 'Moshe Ekstein', email: 'm@example.test' });
  const order = sales.confirm(store.db, workspace.ctx, sales.createOrder(store.db, workspace.ctx, {
    customerId: customer.id, lines: [{ skuId: item.skuId, quantity: 2 }],
  }).id);
  const { invoice } = receivables.createDraft(store.db, workspace.ctx, membership, {
    customerId: customer.id, salesOrderId: order.id, issueDate: TODAY,
    lines: [{ description: 'Loafer', quantity: 2, unitPriceMinor: 15000 }],
  });
  receivables.open(store.db, workspace.ctx, membership, invoice.id);
  return { ...store, workspace, ctx: workspace.ctx, membership, customer, order };
}

async function asked(env) {
  return collection.request(env.db, env.ctx, env.order.id, { provider: 'fake', purpose: 'BALANCE' });
}

const UNPAID = { id: 'in_1', livemode: true, status: 'open', amount_due: 30000, amount_paid: 0,
  currency: 'usd', attempted: false, attempt_count: 0, payments: { data: [] } };
const DECLINED = { ...UNPAID, attempted: true, attempt_count: 1,
  foundryDeclineReason: 'The bank did not return any further details with this decline.' };
const PAID = { ...UNPAID, status: 'paid', amount_paid: 30000, attempted: true, attempt_count: 1,
  status_transitions: { paid_at: Math.floor(Date.now() / 1000) } };

test('with no webhook at all, Foundry learns the payment was declined and says why', async () => {
  const env = setup();
  let invoice = UNPAID;
  const undo = registry.register('fake', askable(() => invoice));
  try {
    const req = await asked(env);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payment_provider_events').get().n, 0,
      'nothing has been reported');

    invoice = DECLINED;
    const out = await collection.refresh(env.db, env.ctx, req.id);
    assert.equal(out.checked, true);
    assert.match(out.outcome, /did not return any further details/);

    const row = env.db.prepare('SELECT status, last_error FROM payment_requests WHERE id = ?').get(req.id);
    assert.equal(row.status, 'OPEN', 'a decline does not settle anything');
    assert.match(row.last_error, /did not return any further details/,
      'and the reason is on the order, not only in a log');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM payment_provider_events').get().n, 1);
  } finally { undo(); env.db.close(); }
});

test('with no webhook at all, a payment that succeeded is recorded once', async () => {
  const env = setup();
  let invoice = UNPAID;
  const undo = registry.register('fake', askable(() => invoice));
  try {
    const req = await asked(env);
    invoice = PAID;

    const first = await collection.refresh(env.db, env.ctx, req.id);
    assert.equal(first.applied, true, 'the money reached the books');
    assert.equal(env.db.prepare('SELECT status, paid_minor FROM payment_requests WHERE id = ?')
      .get(req.id).paid_minor, 30000);

    // Asked again about an unchanged invoice: the same event, ignored.
    const again = await collection.refresh(env.db, env.ctx, req.id);
    assert.ok(!again.applied, 'a settled request is not asked about again');
    assert.match(again.because, /nothing outstanding/i);
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_payments
      WHERE workspace_id = ?`).get(env.workspace.workspaceId).n, 1,
      'asking twice never records the money twice');
  } finally { undo(); env.db.close(); }
});

test('the waiting order learns payment immediately and returns receipt and invoice actions', async () => {
  const env = setup();
  let invoice = UNPAID;
  const undo = registry.register('fake', askable(() => invoice));
  try {
    const askedFor = await asked(env);
    invoice = PAID;
    const app = createApp({ db: env.db, env: 'test', sessionSecret: 'payment-window', aiProvider: fakeProvider({}) });
    const agent = request.agent(app);
    await signIn(agent, env.workspace.account.email, env.workspace.account.password);

    const state = await agent.get(`/sales/orders/${env.order.id}/payment-state`)
      .set('Accept', 'application/json');
    assert.equal(state.status, 200);
    assert.equal(state.body.paid, true);
    assert.match(state.body.receipt.href, /\/receipt\//);
    assert.equal(state.body.invoice.href, askedFor.hostedUrl);

    const page = await agent.get(`/orders/${env.order.id}?payment=paid`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Payment recorded/);
    assert.match(page.text, /Print receipt/);
    assert.match(page.text, /View or print Stripe invoice/);

    const home = plain((await agent.get('/')).text);
    assert.match(home, /Handled\s*1\s*automatic action completed in the last day/i);
    assert.match(home, /Recorded \$300\.00 from Moshe Ekstein.*confirmed the payment and Foundry posted it to SO-1001 without you/i);
  } finally { undo(); env.db.close(); }
});

test('an unreachable provider is not news about the customer', async () => {
  const env = setup();
  const undo = registry.register('fake', {
    ...askable(() => UNPAID),
    async readInvoice() { throw new Error('getaddrinfo ENOTFOUND api.stripe.com'); },
  });
  try {
    const req = await asked(env);
    const out = await collection.refresh(env.db, env.ctx, req.id);
    assert.equal(out.checked, false);
    assert.match(out.because, /ENOTFOUND/);
    const row = env.db.prepare('SELECT status, last_error FROM payment_requests WHERE id = ?').get(req.id);
    assert.equal(row.status, 'OPEN');
    assert.equal(row.last_error, null, 'not being able to ask is not a failed payment');
  } finally { undo(); env.db.close(); }
});

test('asking is bounded to once a minute, so opening an order stays cheap', async () => {
  const env = setup();
  let calls = 0;
  const undo = registry.register('fake', {
    ...askable(() => UNPAID),
    async readInvoice() { calls += 1; return UNPAID; },
  });
  try {
    await asked(env);
    await collection.refreshForOrder(env.db, env.ctx, env.order.id);
    await collection.refreshForOrder(env.db, env.ctx, env.order.id);
    await collection.refreshForOrder(env.db, env.ctx, env.order.id);
    assert.equal(calls, 1, 'three page views, one question');

    // Once a minute has passed, it is asked again.
    env.db.prepare('UPDATE payment_requests SET checked_at = ?')
      .run(new Date(Date.now() - 90_000).toISOString());
    await collection.refreshForOrder(env.db, env.ctx, env.order.id);
    assert.equal(calls, 2, 'and once it is stale again it is asked again');
  } finally { undo(); env.db.close(); }
});

test('a webhook is placed by the invoice it names, not by an id in its address', async () => {
  /*
   * The whole cause of the silence. The endpoint pointed at a workspace that
   * had been deleted, so a verified event about a live invoice was answered
   * 404 and thrown away.
   */
  const env = setup();
  const undo = registry.register('fake', askable(() => PAID));
  try {
    const req = await asked(env);
    const app = createApp({ db: env.db, env: 'test', sessionSecret: 'hooks', aiProvider: fakeProvider({}) });
    const event = { id: 'evt_1', type: 'invoice.payment_succeeded', data: { object: PAID } };

    // Addressed to an inventory that does not exist — the exact live failure.
    const wrong = await request(app)
      .post('/webhooks/payments/fake/wsp_thisinventorywasdeleted')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
    assert.equal(wrong.status, 200, 'never a 404: that is what lost every event');
    assert.equal(wrong.body.applied, true, 'and it still reached the right books');

    const row = env.db.prepare('SELECT workspace_id, status FROM payment_requests WHERE id = ?').get(req.id);
    assert.equal(row.workspace_id, env.workspace.workspaceId);
    assert.equal(row.status, 'PAID');
  } finally { undo(); env.db.close(); }
});

test('an address with no inventory in it at all works, and is the one to register', async () => {
  const env = setup();
  const undo = registry.register('fake', askable(() => PAID));
  try {
    await asked(env);
    const app = createApp({ db: env.db, env: 'test', sessionSecret: 'hooks2', aiProvider: fakeProvider({}) });
    const posted = await request(app)
      .post('/webhooks/payments/fake')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_2', type: 'invoice.payment_succeeded', data: { object: PAID } }));
    assert.equal(posted.status, 200);
    assert.equal(posted.body.applied, true);
  } finally { undo(); env.db.close(); }
});

test('a verified event nobody owns is answered, not retried for days', async () => {
  const env = setup();
  const undo = registry.register('fake', askable(() => PAID));
  try {
    const app = createApp({ db: env.db, env: 'test', sessionSecret: 'hooks3', aiProvider: fakeProvider({}) });
    const posted = await request(app)
      .post('/webhooks/payments/fake')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_3', type: 'invoice.payment_succeeded',
        data: { object: { ...PAID, id: 'in_nobody_has_this' } } }));
    assert.equal(posted.status, 200);
    assert.equal(posted.body.applied, false);
    assert.match(posted.body.outcome, /No inventory owns that invoice/);
  } finally { undo(); env.db.close(); }
});

test('the order shows a declined attempt instead of only waiting', async () => {
  const env = setup();
  let invoice = UNPAID;
  const undo = registry.register('fake', askable(() => invoice));
  try {
    const req = await asked(env);
    invoice = DECLINED;
    await collection.refresh(env.db, env.ctx, req.id);

    const app = createApp({ db: env.db, env: 'test', sessionSecret: 'hooks4', aiProvider: fakeProvider({}) });
    const agent = request.agent(app);
    await signIn(agent, env.workspace.account.email, env.workspace.account.password);
    const page = await agent.get(`/orders/${env.order.id}`);
    assert.equal(page.status, 200);
    const { plain } = require('../helpers');
    const text = plain(page.text);
    assert.match(text, /The last attempt to pay this did not go through/);
    assert.match(text, /did not return any further details/);
  } finally { undo(); env.db.close(); }
});
