'use strict';

/*
 * An understood instruction reaches a page that can carry it out.
 *
 * "Please email motty6700@gmail.com that we received is order and processing
 * it now" was read correctly — the reader returned a message draft with the
 * right recipient and the person's own words — and then the home page came
 * back with "Foundry needs more detail" over it. The route that called the
 * reader only knew where proposals and questions go; a draft fell through to
 * a generic error, and so did a reported supplier payment.
 *
 * These tests type the sentence into the same box and follow the redirect.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { fakeProvider } = require('../helpers/fake-provider');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, plain, makeQuantityItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const connections = require('../../src/connections/service');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const payables = require('../../src/accounting/payables');

test.after(cleanupAll);

// The books open today; a bill dated before that is refused, so the fixture is dated today.
const TODAY = new Date().toISOString().slice(0, 10);

/** One line of the reader's answer, every field present, only the named ones set. */
function line(overrides) {
  return {
    actionType: 'send_message', item: '', variant: '', lotCode: '', serials: [],
    sourceLocation: '', destinationLocation: '', quantity: -1, adjustmentTarget: -1, reasonCode: '',
    terminologyKey: '', terminologyValue: '', productName: '', productCode: '', variantAxes: '',
    unitLabel: '', supplier: '', purchaseUnit: '', amount: -1, reference: '',
    recipient: '', messageBody: '', ...overrides,
  };
}

/**
 * A provider that answers the classifier and the reader by name, so the test
 * scripts what was understood rather than the order of calls.
 */
function scripted(lines) {
  return fakeProvider((call) => {
    if (call.schemaName === 'inventory_action_intent') {
      return { lines, clarifyingQuestion: '', unsupportedReason: '' };
    }
    return { intentClass: 'INVENTORY_ACTION', confidence: 'high', reason: 'asks Foundry to act',
      resolvedReference: '', clarifyingQuestion: '' };
  });
}

async function setup(lines) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'HalFi Shoes' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'messages-http', aiProvider: scripted(lines) });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  return { ...store, workspace, ctx: workspace.ctx, membership, agent };
}

function connectMailbox(env) {
  const made = connections.create(env.db, env.ctx, env.membership,
    { providerType: 'supplier_email', displayName: 'Shop Gmail' });
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(made.connection.id);
  return made.connection.id;
}

async function tell(env, message) {
  const home = await env.agent.get('/');
  return env.agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message });
}

const SAID = 'Please email motty6700@gmail.com that we received is order and processing it now';

test('an emailed instruction lands on a page with the words and a Send button', async () => {
  const env = await setup([line({ actionType: 'send_message', recipient: 'motty6700@gmail.com',
    messageBody: 'we received is order and processing it now' })]);
  const connectorId = connectMailbox(env);

  const response = await tell(env, SAID);
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/messages\/ccom_/, 'a draft, not the home page');

  const page = await env.agent.get(response.headers.location);
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /motty6700@gmail\.com/);
  assert.match(text, /we received is order and processing it now/, 'their words, as typed');
  assert.match(text, /Send to motty6700@gmail\.com/, 'and a way to send it');
  assert.doesNotMatch(text, /needs more detail/i);

  const row = env.db.prepare(`SELECT * FROM customer_communications WHERE workspace_id = ?`)
    .get(env.workspace.workspaceId);
  assert.equal(row.status, 'PREPARED', 'written, not sent');
  assert.equal(row.message_kind, 'owner_message');
  assert.equal(row.recipient, 'motty6700@gmail.com');
  assert.equal(row.body, 'we received is order and processing it now');
  assert.equal(row.connector_id, connectorId, 'the connected mailbox is the one it will leave from');
  env.db.close();
});

test('"Do not send" cancels it and nothing leaves', async () => {
  const env = await setup([line({ actionType: 'send_message', recipient: 'motty6700@gmail.com',
    messageBody: 'we received your order' })]);
  connectMailbox(env);
  const sent = await tell(env, SAID);
  const url = sent.headers.location;
  const page = await env.agent.get(url);

  const cancel = await env.agent.post(url).type('form').send({
    _csrf: csrfFrom(page.text), action: 'cancel',
    recipient: 'motty6700@gmail.com', subject: 'x', body: 'we received your order',
  });
  assert.equal(cancel.status, 303);
  const after = await env.agent.get(url);
  assert.match(plain(after.text), /Not sent/);
  const row = env.db.prepare('SELECT status FROM customer_communications').get();
  assert.equal(row.status, 'CANCELLED');
  env.db.close();
});

test('without a mailbox, the person is told that — not asked for more detail', async () => {
  const env = await setup([line({ actionType: 'send_message', recipient: 'motty6700@gmail.com',
    messageBody: 'we received your order' })]);
  const response = await tell(env, SAID);
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/actions');
  const page = await env.agent.get('/actions');
  const text = plain(page.text);
  assert.match(text, /No mailbox is connected/);
  assert.doesNotMatch(text, /needs more detail/i);
  env.db.close();
});

test('asking to delete the inventory points at the page that does it', async () => {
  const env = await setup([line({ actionType: 'delete_inventory' })]);
  const response = await tell(env, 'Please delete my entire inventory');
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/actions');
  const page = await env.agent.get('/actions');
  assert.match(page.text, new RegExp(`/inventories/${env.workspace.workspaceId}/delete`),
    'a link to the deletion page, which asks for the name');
  assert.match(plain(page.text), /cannot be undone/i);
  env.db.close();
});

test('a reported supplier payment lands on a confirm page with the right bill and amount', async () => {
  const env = await setup([line({ actionType: 'pay_supplier', supplier: 'ABC Apparel', amount: 100,
    reference: '9281' })]);
  require('../../src/accounting/automatic').ensure(env.db, env.workspace.workspaceId, { actorId: env.ctx.actorId });
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Black Small', baseCode: 'BLACK-S' });
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership,
    { name: 'ABC Apparel', email: 'orders@abcapparel.test', currency: 'USD' });
  const draft = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityUnits: 24, unitCost: 10, supplierSku: 'BLACK-S' }],
  });
  const order = poService.approve(env.db, env.ctx, env.membership, draft.id,
    { expectedHash: draft.integrityHash, markOrdered: true });
  const poLine = env.db.prepare('SELECT id FROM purchase_order_lines WHERE purchase_order_id = ?').get(order.id);
  const bill = payables.createDraft(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, purchaseOrderId: order.id, billNumber: '9281',
    issueDate: TODAY, dueDate: '2026-09-30',
    lines: [{ description: '24 Black Small', quantity: 24, unitCostMinor: 1000,
      skuId: item.skuId, purchaseOrderLineId: poLine.id }],
  });
  payables.open(env.db, env.ctx, env.membership, bill.bill.id);

  const response = await tell(env, 'I paid ABC Apparel $100 toward invoice 9281');
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/actions/supplier-payment');

  const page = await env.agent.get('/actions/supplier-payment');
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /ABC Apparel/);
  assert.match(text, /9281/);
  assert.match(text, /USD 240\.00/, 'what is outstanding now');
  assert.match(text, /USD 140\.00/, 'what will be left');
  assert.match(page.text, /name="amount"[^>]*value="100\.00"/, 'the amount they said, not the balance');
  assert.match(page.text, new RegExp(`/accounting/payables/${bill.bill.id}/payment`),
    'recorded through the same route as any other supplier payment');
  assert.equal(env.db.prepare(`SELECT COUNT(*) n FROM accounting_payments WHERE workspace_id = ?`)
    .get(env.workspace.workspaceId).n, 0, 'nothing recorded until they confirm');
  env.db.close();
});

test('the mailbox page says an order was drafted from the email, not "Ignored sender"', async () => {
  /*
   * The message that produced SO-1001 was labelled "Ignored sender · Saved
   * for history. It did not change purchasing or inventory." Every word was
   * technically about the sender's trust status; none of it was about what
   * had actually happened to the email.
   */
  const env = await setup([]);
  const connectorId = connectMailbox(env);
  const item = makeQuantityItem(env.db, env.ctx, { name: 'bike toe lace', baseCode: 'TBD-36' });
  const ingestion = require('../../src/connections/email-ingestion');
  const orderFromEmail = require('../../src/sales/order-from-email');
  const captured = ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId },
    { occurredAt: new Date().toISOString(), data: { messageId: 'g-1', sender: 'arye6700@gmail.com',
      subject: 'bike toe lace', bodyText: "I'd like to order bike toe lace 2 pieces", attachments: [] } });
  const { order } = await orderFromEmail.draft(env.db, env.ctx, captured.actionRecordId, {
    provider: { complete: async () => ({ data: { isAnOrder: true, contactName: 'Moshe Ekstein', phone: '',
      lines: [{ itemText: 'bike toe lace', variantText: '', quantity: 2 }] } }) },
  });
  assert.ok(order, 'drafted');

  const page = await env.agent.get(`/settings/connections/${connectorId}`);
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, new RegExp(`Order ${order.order_number} drafted · Needs your approval`));
  assert.match(text, new RegExp(`Foundry read this as an order and drafted ${order.order_number}`));
  assert.match(page.text, new RegExp(`href="/orders/${order.id}"`), 'with a way to the order');
  assert.doesNotMatch(text, /Ignored sender/);
  assert.doesNotMatch(text, /It did not change purchasing or inventory/);

  const needs = await env.agent.get('/needs-you');
  assert.match(plain(needs.text), new RegExp(`Approve ${order.order_number} for Moshe Ekstein`), 'and Needs you asks for the approval');
  env.db.close();
});

test('an order whose product has no selling price can still be approved: the price is asked for right there', async () => {
  /*
   * Needs you sent the owner to approve SO-1001 and the page showed a warning
   * and no button, because the shoes had come from a supplier invoice and had
   * a cost but no selling price. Foundry will not invent one. It asks for it
   * on the approval itself and confirms in the same step.
   */
  const env = await setup([]);
  const connectorId = connectMailbox(env);
  const item = makeQuantityItem(env.db, env.ctx, { name: 'bike toe lace', baseCode: 'TBD-36' });
  const ingestion = require('../../src/connections/email-ingestion');
  const orderFromEmail = require('../../src/sales/order-from-email');
  const captured = ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId },
    { occurredAt: new Date().toISOString(), data: { messageId: 'g-2', sender: 'arye6700@gmail.com',
      subject: 'bike toe lace', bodyText: "I'd like to order bike toe lace 2 pieces", attachments: [] } });
  const { order } = await orderFromEmail.draft(env.db, env.ctx, captured.actionRecordId, {
    provider: { complete: async () => ({ data: { isAnOrder: true, contactName: 'Moshe Ekstein', phone: '',
      lines: [{ itemText: 'bike toe lace', variantText: '', quantity: 2 }] } }) },
  });

  const needs = plain((await env.agent.get('/needs-you')).text);
  assert.match(needs, /give bike toe lace a selling price/i, 'Needs you says what will be asked');

  const page = await env.agent.get(`/orders/${order.id}`);
  assert.equal(page.status, 200);
  assert.match(plain(page.text), /Give the selling price, then confirm this order/);
  assert.match(page.text, new RegExp(`name="price\\[${item.skuId}\\]"`), 'a box for the price');
  assert.match(plain(page.text), /Set price and confirm order/, 'and a button that does both');
  assert.doesNotMatch(plain(page.text), /cannot be confirmed yet/);

  const confirmed = await env.agent.post(`/sales/orders/${order.id}/confirm`).type('form')
    .send({ _csrf: csrfFrom(page.text), [`price[${item.skuId}]`]: '45.00' });
  assert.equal(confirmed.status, 303);
  const after = env.db.prepare('SELECT status FROM sales_orders WHERE id = ?').get(order.id);
  assert.notEqual(after.status, 'DRAFT', 'approved in one step');
  assert.ok(['CONFIRMED','BACKORDERED'].includes(after.status), 'confirmed, waiting for stock if there is none');
  const line = env.db.prepare('SELECT unit_price_minor FROM sales_order_lines WHERE sales_order_id = ?').get(order.id);
  assert.equal(line.unit_price_minor, 4500, 'at the price the owner gave');
  const price = env.db.prepare('SELECT amount_minor FROM sku_prices WHERE sku_id = ? ORDER BY created_at DESC').get(item.skuId);
  assert.equal(price.amount_minor, 4500, 'kept on the product for next time');
  env.db.close();
});

test('a blank price is not a price: confirming without one is refused, not zeroed', async () => {
  const env = await setup([]);
  const connectorId = connectMailbox(env);
  makeQuantityItem(env.db, env.ctx, { name: 'bike toe lace', baseCode: 'TBD-36' });
  const ingestion = require('../../src/connections/email-ingestion');
  const orderFromEmail = require('../../src/sales/order-from-email');
  const captured = ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId },
    { occurredAt: new Date().toISOString(), data: { messageId: 'g-3', sender: 'arye6700@gmail.com',
      subject: 'bike toe lace', bodyText: "I'd like to order bike toe lace 2 pieces", attachments: [] } });
  const { order } = await orderFromEmail.draft(env.db, env.ctx, captured.actionRecordId, {
    provider: { complete: async () => ({ data: { isAnOrder: true, contactName: '', phone: '',
      lines: [{ itemText: 'bike toe lace', variantText: '', quantity: 2 }] } }) },
  });
  const page = await env.agent.get(`/orders/${order.id}`);
  const confirmed = await env.agent.post(`/sales/orders/${order.id}/confirm`).type('form')
    .send({ _csrf: csrfFrom(page.text) });
  assert.equal(confirmed.status, 303);
  assert.equal(env.db.prepare('SELECT status FROM sales_orders WHERE id = ?').get(order.id).status, 'DRAFT');
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM sku_prices').get().n, 0, 'no price was made up');
  env.db.close();
});

test('the payment email Foundry wrote is on the order, readable, with the send button — not just a button to write it', async () => {
  /*
   * After confirming, the page said "Foundry made a $300.00 payment link and
   * wrote the email — it is on the order, ready to send", and the order
   * showed a button labelled "Email it to Moshe Ekstein" and nothing else.
   * The owner asked where the email was. Fair question.
   */
  const registry = require('../../src/payments/provider');
  const undo = registry.register('fake', {
    async createCustomer() { return { externalCustomerId: 'cus_1' }; },
    async createInvoice() { return { externalInvoiceId: 'in_1', hostedUrl: 'https://pay.test/in_1' }; },
    async getHostedPaymentUrl() { return 'https://pay.test/in_1'; },
    async refundPayment() { return { externalRefundId: 're_1' }; },
    verifyEvent(raw) { return raw; },
    readEvent() { return { kind: 'IGNORED' }; },
  });
  try {
    const env = await setup([]);
    const connectorId = connectMailbox(env);
    const item = makeQuantityItem(env.db, env.ctx, { name: 'bike toe lace', baseCode: 'TBD-36' });
    require('../../src/pricing/price-service').setPrice(env.db, env.ctx, { skuId: item.skuId, amount: '150.00', currency: 'USD' });
    const ingestion = require('../../src/connections/email-ingestion');
    const orderFromEmail = require('../../src/sales/order-from-email');
    const captured = ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId },
      { occurredAt: new Date().toISOString(), data: { messageId: 'g-4', sender: 'arye6700@gmail.com',
        subject: 'bike toe lace', bodyText: "I'd like to order bike toe lace 2 pieces", attachments: [] } });
    const { order } = await orderFromEmail.draft(env.db, env.ctx, captured.actionRecordId, {
      provider: { complete: async () => ({ data: { isAnOrder: true, contactName: 'Moshe Ekstein', phone: '',
        lines: [{ itemText: 'bike toe lace', variantText: '', quantity: 2 }] } }) },
    });

    let page = await env.agent.get(`/orders/${order.id}`);
    await env.agent.post(`/sales/orders/${order.id}/confirm`).type('form').send({ _csrf: csrfFrom(page.text) });

    page = await env.agent.get(`/orders/${order.id}`);
    const text = plain(page.text);
    assert.match(text, /\$300\.00 asked for/);
    assert.match(text, /Foundry wrote the email to Moshe Ekstein\. It has not been sent\./);
    assert.match(text, /Read the email and send it/, 'the email is a thing on the page, not a button to write one');
    assert.doesNotMatch(text, /Email it to Moshe Ekstein/, 'and not offered a second time');
    assert.doesNotMatch(text, /Nothing has been committed/, 'a confirmed order no longer tells you to confirm it');
    assert.match(text, /Came in by email from arye6700@gmail\.com/, 'the source is still there, folded away');

    const href = /href="(\/messages\/[^"]+)"/.exec(page.text);
    assert.ok(href, 'a link to the written email');
    const email = await env.agent.get(href[1]);
    assert.equal(email.status, 200);
    assert.match(plain(email.text), /link to pay USD 300\.00 on order/, 'the email carries the amount and the link');
    assert.match(plain(email.text), /Written from the order.s own record/, 'and says where its words came from');
    assert.match(plain(email.text), /Send to arye6700@gmail\.com/, 'and can be sent from there');
    env.db.close();
  } finally { undo(); }
});
