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
  assert.match(text, /\$1,500\.00 is still owed/);
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
  assert.match(text, /\$1,050\.00 is still owed/);
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

test('the order offers to ask for payment, keeps the link, and a reply may use it', async () => {
  const registry = require('../../src/payments/provider');
  const env = setup();
  const undo = registry.register('fake', {
    async createCustomer() { return { externalCustomerId: 'cus_1' }; },
    async createInvoice() { return { externalInvoiceId: 'in_1', hostedUrl: 'https://pay.test/in_1' }; },
    async getHostedPaymentUrl() { return 'https://pay.test/in_1'; },
    async refundPayment() { return { externalRefundId: 're_1' }; },
    verifyEvent(raw) { return raw; },
    readEvent() { return { kind: 'IGNORED' }; },
  });
  try {
    const { customer, order } = invoicedOrder(env);
    terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'DEPOSIT', depositPercent: 30 });

    const agent = request.agent(env.app);
    await signIn(agent, env.workspace.account.email, env.workspace.account.password);

    let page = await agent.get(`/orders/${order.id}`);
    assert.match(plain(page.text), /Ask for the \$450\.00 deposit/);
    assert.match(plain(page.text), /never sees a card number/);

    const asked = await agent.post(`/sales/orders/${order.id}/payment-request`)
      .type('form').send({ _csrf: csrfFrom(page.text), provider: 'fake', purpose: 'DEPOSIT' });
    assert.equal(asked.status, 303);

    page = await agent.get(`/orders/${order.id}`);
    assert.match(page.text, /https:\/\/pay\.test\/in_1/, 'the link is on the order, readable and copyable');
    assert.match(plain(page.text), /\$450\.00 asked for as a deposit/);
    assert.match(plain(page.text), /updates this order by itself when they do/);

    /*
     * And a drafted reply may quote it — which is the point of the whole
     * chain: the customer gets a link without anybody copying it between
     * systems.
     */
    const drafting = require('../../src/connections/reply-drafting');
    const facts = drafting.factsFor(env.db, env.workspace.workspaceId,
      { sender: 'orders@abcschool.test', subject: 'Our order', body_text: 'How do we pay?' });
    assert.ok(facts.some((fact) => fact.includes('https://pay.test/in_1')),
      'the payment link is a fact a reply is allowed to state');
  } finally { undo(); }
});

test('the Orders list leads with what is stuck, and says what it is stuck on', async () => {
  /*
   * Found by walking the page rather than reading the code. The list showed
   * seven columns — ordered, committed, short, total — and a badge reading
   * "Confirmed — stock held" on an order whose deposit had not arrived and
   * which picking would refuse. Every figure true; the impression false.
   */
  const env = setup();
  const { customer, order } = invoicedOrder(env);
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'DEPOSIT', depositPercent: 30 });

  const second = sales.createCustomer(env.db, env.ctx, { name: 'Delta Cleaning' });
  sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: second.id, lines: [{ skuId: env.item.skuId, quantity: 20 }],
  }).id);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const text = plain((await agent.get('/orders')).text);

  assert.match(text, /1 order needs you, 1 ready to pick\./,
    'one sentence about the list, not three abstract figures');
  assert.match(text, /Waiting for a \$450\.00 deposit/,
    'the row says what it is waiting for, in money');
  assert.doesNotMatch(text, /Confirmed — stock held/,
    'and never claims a held order is fine');

  // The stuck one leads, whatever order they were created in.
  assert.ok(text.indexOf(order.order_number) < text.indexOf('SO-1002'),
    'what needs a person comes first');
});

test('a held order never offers what it will refuse, and Needs you agrees with the page', async () => {
  /*
   * Two contradictions on one screen, both found by looking at it.
   *
   * The order page offered "Record the items as shipped" and "Start picking"
   * on an order the engine refuses to pick — telling somebody to do the one
   * thing they cannot. And the strip above said "Nothing needs you" while the
   * page said an order needed them, because a payment hold was not a decision
   * in the queue. It is now.
   */
  const env = setup();
  const { customer, order } = invoicedOrder(env);
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'BEFORE_FULFILMENT' });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const text = plain((await agent.get(`/orders/${order.id}`)).text);

  assert.doesNotMatch(text, /Ship selected quantities/,
    'the direct ship form stands down while money holds the order');
  assert.doesNotMatch(text, /Start picking \d+ units/,
    'and so does the picking button');
  assert.match(text, /Get the \$1,500\.00/,
    'what it offers instead is the thing that would actually unblock it');
  assert.match(text, /Held until paid/,
    'and the fulfilment badge does not say "Ready to pick" about a refused pick');

  // The queue and the page now agree, because a hold is a decision.
  const needsYou = require('../../src/manager/needs-you-inbox').inbox(env.db, env.workspace.workspaceId);
  const held = needsYou.filter((entry) => entry.id.startsWith('order-payment-hold:'));
  assert.equal(held.length, 1, 'a held order is a decision waiting on a person');
  assert.match(held[0].title, /ABC School owes \$1,500\.00 before SO-\d+ can go/);
  assert.match(held[0].href, new RegExp(`/orders/${order.id}`));
});

test('once the deposit lands the page offers picking, and still holds the parcel', async () => {
  const env = setup();
  const { customer, order, invoiceId } = invoicedOrder(env);
  terms.setTerms(env.db, env.ctx, {
    customerId: customer.id, kind: 'DEPOSIT', depositPercent: 30, holdShipping: true,
  });
  payments.record(env.db, env.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: '2026-09-03',
    amountMinor: 45000, method: 'card', sourceKey: 'walk:deposit',
    allocations: [{ invoiceId, amountMinor: 45000 }],
  });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const text = plain((await agent.get(`/orders/${order.id}`)).text);

  assert.match(text, /Start picking 100 units/, 'the deposit arrived, so the warehouse may start');
  assert.doesNotMatch(text, /Ship selected quantities/, 'but shipping is still held');
  assert.match(text, /Get the \$1,050\.00/);
  assert.match(text, /picked and packed, but it does not leave until the balance is settled/);
  assert.match(text, /\$1,050\.00/, 'money is written the way the rest of the page writes it');
  assert.doesNotMatch(text, /\$1050\.00/);
});

test('a finished order stops explaining itself and stops showing empty columns', async () => {
  /*
   * Found by walking a shipped order. It was still being taught "Only two
   * business decisions: reserve when the customer commits, ship when the items
   * leave" — both already made — above a strip reading "0 committed, 0 waiting
   * for stock" and a line table with three columns of zeroes and dashes.
   *
   * A column, a figure and a paragraph each earn their place by having
   * something to say about this order, in this state.
   */
  const env = setup();
  const { customer, order, invoiceId } = invoicedOrder(env, 12);
  payments.record(env.db, env.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: customer.id, paymentDate: '2026-09-02',
    amountMinor: 18000, method: 'card', sourceKey: 'walk:full',
    allocations: [{ invoiceId, amountMinor: 18000 }],
  });
  const shipments = require('../../src/sales/shipment-service');
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  shipments.ship(env.db, env.ctx, box.id, {});

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get(`/orders/${order.id}`);
  const text = plain(page.text);

  assert.doesNotMatch(text, /Only two business decisions/,
    'both decisions are behind them');
  assert.doesNotMatch(text, /committed to this customer/,
    'nothing is committed on a shipped order, so the figure is not shown');
  assert.doesNotMatch(text, /waiting for stock/,
    'and nothing is waiting');
  assert.match(text, /12\s*shipped/, 'what did happen is still said');

  const columns = [...page.text.slice(page.text.indexOf('Order lines'))
    .matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(columns, ['Product', 'Ordered', 'Unit price', 'Line total', 'Shipped'],
    'a column earns its place by having something in it');
});

test('a partly shipped order never says nothing was shipped', async () => {
  /*
   * Written after breaking exactly this while moving the shortfall notice
   * above the "do this next" card: the notice read `shipped`, which was
   * declared further down the template, so it saw undefined and printed the
   * reassurance meant for an order where nothing had moved.
   *
   * The page said "nothing was shipped" beneath a figure saying 34 had. The
   * comment on that notice already recorded the same bug from the first time,
   * which is why it is a test now rather than a comment.
   */
  const env = setup();
  const { customer, order } = invoicedOrder(env, 50);
  const shipments = require('../../src/sales/shipment-service');
  const line = order.lines[0];
  const box = shipments.startPicking(env.db, env.ctx, order.id, {
    lines: [{ lineId: line.id, locationId: env.workspace.main.id, quantity: 34 }],
  });
  shipments.ship(env.db, env.ctx, box.id, {});
  // Take the rest of the stock away so the remainder is genuinely short.
  const repo = require('../../src/domain/repository');
  const onHand = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id);
  if (onHand) {
    require('../../src/domain/inventory-engine').issue(env.db, env.ctx, {
      skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: onHand,
      reasonCode: 'damaged', notes: 'clearing the shelf so the remainder is genuinely short',
    });
  }

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const text = plain((await agent.get(`/orders/${order.id}`)).text);

  assert.match(text, /34\s*shipped/, 'the page records that 34 went');
  assert.doesNotMatch(text, /nothing was shipped/,
    'so it must not reassure anybody that nothing did');
});

test('the customer page opens with the relationship, not a form for their phone number', async () => {
  /*
   * It used to open with "Customer details needed to manage inventory
   * commitments and delivery" over a name/company/email/phone form — a
   * sentence about the software rather than about them, and no money anywhere.
   * What somebody wants on opening a customer is what they owe and how they
   * pay.
   */
  const env = setup();
  const { customer, order } = invoicedOrder(env);
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'DEPOSIT', depositPercent: 30 });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const text = plain((await agent.get(`/sales/customers/${customer.id}`)).text);

  assert.match(text, /Owes \$1,500\.00 across 1 invoice/);
  assert.match(text, /Pays 30% of the order up front/);
  assert.doesNotMatch(text, /Customer details needed to manage inventory commitments/,
    'the page no longer explains itself to the person using it');

  /*
   * And the history says what the Orders list says. It used to print raw
   * statuses in lower case, so one order read two different ways depending on
   * which page you were looking at.
   */
  assert.match(text, /Waiting for a \$450\.00 deposit/);
  assert.doesNotMatch(text, /\bconfirmed\b/, 'no raw enum values');
  assert.ok(text.indexOf('SO-') > 0 && order.order_number);
});

test('a deposit is set in money, and stored in minor units', async () => {
  const env = setup();
  const { customer } = invoicedOrder(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get(`/sales/customers/${customer.id}`);
  assert.doesNotMatch(plain(page.text), /in cents/, 'an owner does not think in cents');

  await agent.post(`/sales/customers/${customer.id}/terms`).type('form').send({
    _csrf: csrfFrom(page.text), kind: 'DEPOSIT', depositAmount: '500.00',
  });
  const saved = terms.forCustomer(env.db, env.workspace.workspaceId, customer.id);
  assert.equal(saved.depositMinor, 50000, 'five hundred dollars, stored as fifty thousand cents');
  assert.equal(terms.describe(saved), 'Pays a fixed deposit up front.');
});

test('a till sale says why it has no total, rather than showing a bare dash', async () => {
  /*
   * Foundry values a sale at the price on file when it happened, so a sale
   * from before a price was recorded genuinely has no value it can support.
   * Showing "—" was the refusal without the reason, which is half the rule and
   * reads like a broken column.
   */
  const env = setup();
  const connections = require('../../src/connections/service');
  const till = connections.create(env.db, env.ctx, env.membership, {
    providerType: 'reference_webhook', displayName: 'Downtown POS',
  });
  const send = (body) => request(env.app).post('/api/v1/events')
    .set('Authorization', `Bearer ${till.token}`).send(body);

  const inventory = require('../../src/domain/inventory-engine');
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.store.id, quantity: 50 });

  // Dated before any price existed.
  const early = await send({
    eventId: 'sale-early', type: 'sale.completed', version: '1',
    occurredAt: '2020-01-01T10:00:00.000Z',
    data: { externalSku: 'p1', skuCode: 'BLACK-S', externalLocationId: 'store-12',
      locationName: 'Downtown Store', quantity: 3, reference: 'TILL-EARLY' },
  });
  assert.equal(early.body.accepted, 1);

  // And one now, when the price is known.
  const now = await send({
    eventId: 'sale-now', type: 'sale.completed', version: '1',
    occurredAt: new Date(Date.now() + 60000).toISOString(),
    data: { externalSku: 'p1', skuCode: 'BLACK-S', externalLocationId: 'store-12',
      locationName: 'Downtown Store', quantity: 4, reference: 'TILL-NOW' },
  });
  assert.equal(now.body.accepted, 1);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const text = plain((await agent.get('/orders')).text);

  assert.match(text, /No price on file when this sold/,
    'the sale from before any price says why it has no total');
  assert.match(text, /\$60\.00/, 'and the one priced at the time is valued');
  assert.match(text, /TILL-EARLY/);
  assert.match(text, /TILL-NOW/);
});

test('the fast ship path leaves a shipment, an address and a notice', async () => {
  /*
   * Reported from a real screen: an order reading "7 shipped" beside
   * "0 shipments", with no address anywhere. The fast path — "record the items
   * as shipped" — called the sales order's fulfil directly, so the stock moved
   * and nothing recorded where it went. One click still, and now a record.
   */
  const env = setup();
  const customer = sales.createCustomer(env.db, env.ctx, {
    name: 'Hendel', email: 'h@hendel.test',
    shippingAddress: ['2 Bridge Street', 'Riverside, OR 97001'].join('\n'),
  });
  inventory.receive(env.db, env.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 40,
  });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 7 }],
  }).id);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get(`/orders/${order.id}`);

  const shipped = await agent.post(`/sales/orders/${order.id}/fulfill`).type('form').send({
    _csrf: csrfFrom(page.text), lineId: order.lines[0].id,
    locationId: env.workspace.main.id, quantity: '7',
  });
  assert.equal(shipped.status, 303);

  const shipments = require('../../src/sales/shipment-service');
  const boxes = shipments.listForOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(boxes.length, 1, 'shipping produced a shipment');
  assert.equal(boxes[0].units, 7);
  assert.match(boxes[0].ship_to_address, /2 Bridge Street/, 'and it knows where it went');

  const text = plain((await agent.get(`/orders/${order.id}`)).text);
  assert.doesNotMatch(text, /0 shipments/, 'the page never says 7 shipped and 0 shipments');
  assert.match(text, /SHP-1001/);

  const notices = require('../../src/sales/customer-communications');
  assert.equal(notices.forOrder(env.db, env.workspace.workspaceId, order.id).length, 1,
    'and the customer has something to be told');
});

test('a payment taken in the room is recorded on the order, through the same engine', async () => {
  /*
   * The money panel offered a payment link and a sentence suggesting you tell
   * Foundry about anything else. Most of what a small business takes is cash,
   * a cheque, a transfer or the card machine on the counter, and none of that
   * has a link.
   */
  const env = setup();
  const { customer, order, invoiceId } = invoicedOrder(env, 7);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  let page = await agent.get(`/orders/${order.id}`);
  assert.match(plain(page.text), /They paid me — record it/);
  assert.match(plain(page.text), /Cash/);

  const recorded = await agent.post(`/sales/orders/${order.id}/payment`).type('form').send({
    _csrf: csrfFrom(page.text), amount: '105.00', method: 'cash', paymentDate: '2026-09-02',
    reference: 'Counter, Tuesday',
  });
  assert.equal(recorded.status, 303);

  const balance = Number(env.db.prepare('SELECT balance_minor FROM accounting_customer_invoices WHERE id = ?')
    .get(invoiceId).balance_minor);
  assert.equal(balance, 0, 'the invoice is settled');

  const receipt = env.db.prepare(`SELECT * FROM accounting_payments
    WHERE workspace_id = ? AND direction = 'CUSTOMER_RECEIPT'`).get(env.workspace.workspaceId);
  assert.equal(receipt.method, 'cash');
  assert.equal(receipt.reference, 'Counter, Tuesday');
  assert.ok(receipt.journal_entry_id, 'the same journal entry a card payment would make');

  page = await agent.get(`/orders/${order.id}`);
  assert.match(plain(page.text), /Recorded \$105\.00/);
  assert.match(plain(page.text), /Paid/);

  // And it will not take more than is owed.
  const tooMuch = await agent.post(`/sales/orders/${order.id}/payment`).type('form')
    .send({ _csrf: csrfFrom(page.text), amount: '50.00', method: 'cash' });
  assert.equal(tooMuch.status, 303);
  assert.match(plain((await agent.get(`/orders/${order.id}`)).text), /more than the \$0\.00 still owed/);
});

test('orders that shipped before shipments existed get their record rebuilt', async () => {
  /*
   * Reported from a real database: an order reading "7 shipped" and
   * "0 shipments", with no address. Fixing the code fixed the next order and
   * did nothing for the one on the screen — so the history is rebuilt from the
   * order's own fulfilment events, which recorded the line, the location and
   * the quantity at the time.
   *
   * Nothing is invented. A carrier and a tracking number were never captured,
   * so they stay empty, and the page says why rather than leaving a blank
   * where an address should be.
   */
  const env = setup();
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'Hendel' });
  inventory.receive(env.db, env.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 40,
  });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 7 }],
  }).id);

  // Exactly what the old fast path did: fulfil, and record nothing else.
  sales.fulfill(env.db, env.ctx, order.id, {
    lines: [{ lineId: order.lines[0].id, locationId: env.workspace.main.id, quantity: 7 }],
  }, { idempotencyKey: 'old-world' });

  const shipments = require('../../src/sales/shipment-service');
  assert.equal(shipments.listForOrder(env.db, env.workspace.workspaceId, order.id).length, 0,
    'the state this test exists to repair');

  const { backfillShipments } = require('../../src/db/backfill-shipments');
  assert.equal(backfillShipments(env.db), 1);

  const rebuilt = shipments.listForOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].units, 7, 'the quantity that actually went');
  assert.equal(rebuilt[0].status, 'SHIPPED');
  assert.equal(rebuilt[0].carrier, null, 'no carrier was captured, so none is claimed');
  assert.equal(rebuilt[0].tracking_number, null);
  assert.match(rebuilt[0].notes, /Rebuilt from this order's own fulfilment record/);

  // Running it again changes nothing: it is safe on every start.
  assert.equal(backfillShipments(env.db), 0);
  assert.equal(shipments.listForOrder(env.db, env.workspace.workspaceId, order.id).length, 1);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const orderText = plain((await agent.get(`/orders/${order.id}`)).text);
  assert.doesNotMatch(orderText, /0 shipments/, 'the order no longer contradicts itself');
  assert.match(orderText, /SHP-1001/);

  const boxText = plain((await agent.get(`/fulfilment/${rebuilt[0].id}`)).text);
  assert.match(boxText, /Foundry has no address for Hendel/,
    'and the page answers "where did it go" instead of showing a blank');
});
