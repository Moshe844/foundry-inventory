'use strict';

/*
 * An understood instruction reaches a page that can carry it out.
 *
 * "Please email motty6700@gmail.com that we received is order and processing
 * it now" was read correctly — the reader returned a message draft with the
 * right recipient and the person's own words — and then the home page came
 * back with "StockChief needs more detail" over it. The route that called the
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
    return { intentClass: 'INVENTORY_ACTION', confidence: 'high', reason: 'asks StockChief to act',
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

async function ask(env, message, fields = {}) {
  const page = await env.agent.get('/ask');
  return env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(page.text), queryConversation: '1', message, ...fields,
  });
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

test('Ask resolves a supplier by name without requiring the word supplier', async () => {
  const env = await setup([]);
  connectMailbox(env);
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Gmail Qualification', email: 'qualification@example.test', currency: 'USD',
  });

  const response = await ask(env, 'Email Gmail Qualification saying: Please confirm the dispatch date.');
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/messages\//, 'a supplier message goes to its review, not a customer form');
  const page = await env.agent.get(response.headers.location);
  assert.match(plain(page.text), /qualification@example\.test/);
  assert.match(plain(page.text), /Please confirm the dispatch date/);
  const message = env.db.prepare('SELECT customer_id, recipient, body FROM customer_communications ORDER BY created_at DESC').get();
  assert.equal(message.customer_id, null, 'the supplier was not silently converted into a customer');
  assert.equal(message.recipient, supplier.email);
  env.db.close();
});

test('Ask creates a missing supplier as a prerequisite and resumes the original email', async () => {
  const env = await setup([]);
  connectMailbox(env);

  let response = await ask(env, 'Email Solomon');
  assert.equal(response.status, 303);
  let page = await env.agent.get(response.headers.location);
  let text = plain(page.text);
  assert.match(text, /no customer or supplier called “Solomon”/);
  assert.match(text, /Create Solomon as a supplier/);
  assert.match(text, /Create Solomon as a customer/);
  assert.doesNotMatch(text, /Which supplier is this for, and up to what order value/i);
  const goalId = (/name="assistantGoal" value="([^"]+)"/.exec(page.text) || [])[1];
  assert.ok(goalId, 'the original email goal remains attached to the clarification');

  response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(page.text), queryConversation: '1', original: 'Email Solomon',
    answer: 'Create supplier named Solomon', answerAction: '1', assistantGoal: goalId,
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/suppliers\?name=Solomon#add-supplier$/);

  page = await env.agent.get(response.headers.location);
  assert.match(page.text, /name="name"[^>]*value="Solomon"/);
  response = await env.agent.post('/suppliers').type('form').send({
    _csrf: csrfFrom(page.text), name: 'Solomon', email: 'solomon@example.test',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/foundry/resume-prerequisite');

  response = await env.agent.get(response.headers.location);
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/ask\?/);
  page = await env.agent.get(response.headers.location);
  text = plain(page.text);
  assert.match(text, /What should StockChief say to Solomon\?/);
  assert.doesNotMatch(text, /Clarification: Create supplier/i);
  const resumedGoalId = (/name="assistantGoal" value="([^"]+)"/.exec(page.text) || [])[1];
  assert.equal(resumedGoalId, goalId, 'the email request resumes instead of becoming a supplier-policy request');

  response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(page.text), queryConversation: '1', original: 'Email Solomon',
    answer: 'Please confirm tomorrow’s delivery date.', answerAction: '1', assistantGoal: resumedGoalId,
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/messages\//);
  page = await env.agent.get(response.headers.location);
  text = plain(page.text);
  assert.match(text, /solomon@example\.test/);
  assert.match(text, /Please confirm tomorrow’s delivery date\./);
  assert.doesNotMatch(text, /Which supplier is this for, and up to what order value/i);
  const saved = env.db.prepare(`SELECT recipient, body, status FROM customer_communications
    WHERE workspace_id = ? ORDER BY created_at DESC`).get(env.workspace.workspaceId);
  assert.deepEqual(saved, {
    recipient: 'solomon@example.test', body: 'Please confirm tomorrow’s delivery date.', status: 'PREPARED',
  });
  env.db.close();
});

test('Ask resumes an email after adding a missing address to an existing supplier', async () => {
  const env = await setup([]);
  connectMailbox(env);
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'No Mail Supply', currency: 'USD',
  });

  let response = await ask(env, 'Email No Mail Supply saying the delivery arrived damaged.');
  assert.equal(response.status, 303);
  let page = await env.agent.get(response.headers.location);
  let text = plain(page.text);
  assert.match(text, /There is no email address on file for No Mail Supply/);
  assert.match(page.text, new RegExp(`href="/suppliers/${supplier.id}"`));

  page = await env.agent.get(`/suppliers/${supplier.id}`);
  response = await env.agent.post(`/suppliers/${supplier.id}`).type('form').send({
    _csrf: csrfFrom(page.text), name: 'No Mail Supply', email: 'nomail@example.test',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/foundry/resume-prerequisite');

  response = await env.agent.get(response.headers.location);
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/messages\//);
  page = await env.agent.get(response.headers.location);
  text = plain(page.text);
  assert.match(text, /nomail@example\.test/);
  assert.match(text, /the delivery arrived damaged/);
  assert.doesNotMatch(text, /say this again/i);
  env.db.close();
});

test('Ask keeps a missing email body in the conversation and continues the same supplier request', async () => {
  const env = await setup([]);
  connectMailbox(env);
  suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Gmail Qualification Supplier', email: 'qualification@example.test', currency: 'USD',
  });

  const asked = await ask(env, 'Send an email to Gmail Qualification');
  assert.equal(asked.status, 303);
  assert.match(asked.headers.location, /^\/ask\?/, 'the clarification stays in Ask StockChief');
  const clarification = await env.agent.get(asked.headers.location);
  const clarificationText = plain(clarification.text);
  assert.match(clarificationText, /What should StockChief say to Gmail Qualification Supplier\?/);
  assert.doesNotMatch(clarificationText, /create a customer/i);
  assert.match(clarification.text, /name="original" value="Send an email to Gmail Qualification"/);
  assert.match(clarification.text, /name="answer"/);
  const goalId = /name="assistantGoal" value="([^"]+)"/.exec(clarification.text);
  assert.ok(goalId, 'the reply continues the same Ask goal');

  const continued = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(clarification.text), queryConversation: '1', answerAction: '1',
    assistantGoal: goalId[1],
    original: 'Send an email to Gmail Qualification',
    answer: 'Please confirm when PO-1001 will ship.',
  });
  assert.equal(continued.status, 303);
  assert.match(continued.headers.location, /^\/messages\//);
  const draft = await env.agent.get(continued.headers.location);
  assert.match(plain(draft.text), /Please confirm when PO-1001 will ship\./);
  assert.match(plain(draft.text), /qualification@example\.test/);
  const oldTurn = await env.agent.get(asked.headers.location);
  assert.equal(oldTurn.status, 303);
  assert.equal(oldTurn.headers.location, '/ask', 'returning to the original turn does not reinterpret it');
  const conversation = plain((await env.agent.get('/ask')).text);
  assert.match(conversation, /Drafted, not sent|Drafted — not sent/);
  assert.doesNotMatch(conversation, /Needs an answer from you/,
    'the completed request is not left marked unanswered');
  env.db.close();
});

test('an identical customer and supplier name is clarified by role instead of defaulting to customer', async () => {
  const env = await setup([]);
  suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Northstar', email: 'supplier@northstar.test', currency: 'USD',
  });
  require('../../src/sales/sales-order-service').createCustomer(env.db, env.ctx, {
    name: 'Northstar', email: 'customer@northstar.test',
  });

  const asked = await ask(env, 'Email Northstar saying: Please call me.');
  assert.equal(asked.status, 303);
  assert.match(asked.headers.location, /^\/ask\?/);
  const page = await env.agent.get(asked.headers.location);
  const text = plain(page.text);
  assert.match(text, /matches more than one business contact/);
  assert.match(text, /Northstar \(customer\)/);
  assert.match(text, /Northstar \(supplier\)/);
  assert.equal(env.db.prepare('SELECT COUNT(*) count FROM customer_communications').get().count, 0);
  env.db.close();
});

test('a polite email command accepts role and body together without creating queued work', async () => {
  const env = await setup([]);
  connectMailbox(env);
  suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Chavy', email: 'supplier-chavy@example.test', currency: 'USD',
  });
  require('../../src/sales/sales-order-service').createCustomer(env.db, env.ctx, {
    name: 'Chavy', email: 'customer-chavy@example.test',
  });

  const asked = await ask(env, 'Please email chavy');
  assert.equal(asked.status, 303);
  const clarification = await env.agent.get(asked.headers.location);
  const clarificationText = plain(clarification.text);
  assert.match(clarificationText, /matches more than one business contact/i);
  assert.match(clarificationText, /Chavy \(supplier\)/);
  assert.match(clarificationText, /Chavy \(customer\)/);
  assert.doesNotMatch(clarificationText, /What would you like the email.*and can you confirm/i,
    'the command reaches grounded action routing instead of the lookup model');
  const goalId = (/name="assistantGoal" value="([^"]+)"/.exec(clarification.text) || [])[1];
  assert.ok(goalId);

  const continued = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(clarification.text), queryConversation: '1', answerAction: '1',
    assistantGoal: goalId, original: 'Please email chavy',
    answer: 'supplier, the email should say, waiting to hear back from you',
  });
  assert.equal(continued.status, 303);
  assert.match(continued.headers.location, /^\/messages\//);
  const draft = await env.agent.get(continued.headers.location);
  const draftText = plain(draft.text);
  assert.match(draftText, /supplier-chavy@example\.test/);
  assert.match(draftText, /waiting to hear back from you/);
  assert.doesNotMatch(draftText, /Follow-up answer|That lists 2 things|Not started yet/i);
  assert.equal(env.db.prepare(`SELECT COUNT(*) count FROM assistant_goals
    WHERE workspace_id = ? AND status = 'pending'`).get(env.workspace.workspaceId).count, 0);
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
  // The draft is still written and shown; its page says there is nothing to
  // send it from and offers the words to copy or a mailbox to connect.
  const response = await tell(env, SAID);
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/messages\//);
  const page = await env.agent.get(response.headers.location);
  const text = plain(page.text);
  assert.match(text, /No mailbox is connected/);
  assert.match(text, /Copy the words above into your own email/);
  assert.doesNotMatch(text, /needs more detail/i);
  assert.doesNotMatch(text, /Send to /, 'no send button without a mailbox');
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
  assert.match(text, new RegExp(`StockChief read this as an order and drafted ${order.order_number}`));
  assert.match(page.text, new RegExp(`href="/orders/${order.id}"`), 'with a way to the order');
  assert.doesNotMatch(text, /Ignored sender/);
  assert.doesNotMatch(text, /It did not change purchasing or inventory/);

  const needs = await env.agent.get('/needs-you');
  assert.match(plain(needs.text), /Is arye6700@gmail\.com a new customer\?/, 'and Needs you asks who the new sender is');
  env.db.close();
});

test('an unknown email order presents one clear customer and delivery path before fulfilment', async () => {
  const env = await setup([]);
  const connectorId = connectMailbox(env);
  makeQuantityItem(env.db, env.ctx, { name: 'bike toe lace', baseCode: 'TBD-36' });
  const ingestion = require('../../src/connections/email-ingestion');
  const orderFromEmail = require('../../src/sales/order-from-email');
  const captured = ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId },
    { occurredAt: new Date().toISOString(), data: { messageId: 'new-customer-path', sender: 'firstorder@example.test',
      subject: 'New order', bodyText: "I'd like to order bike toe lace 3 pieces", attachments: [] } });
  const { order } = await orderFromEmail.draft(env.db, env.ctx, captured.actionRecordId, {
    provider: { complete: async () => ({ data: { isAnOrder: true, contactName: 'First Buyer', phone: '',
      deliveryMethod: 'UNKNOWN', lines: [{ itemText: 'bike toe lace', variantText: '', quantity: 3 }] } }) },
  });

  let page = await env.agent.get(`/orders/${order.id}`);
  let text = plain(page.text);
  assert.match(text, /Is this a new customer\?/);
  assert.match(text, /Create First Buyer as a customer/);
  assert.doesNotMatch(text, /Record what physically left/);
  assert.doesNotMatch(text, /Do now: Connect where sales happen/,
    'a focused order does not compete with unrelated workspace guidance');

  let response = await env.agent.post(`/sales/orders/${order.id}/resolve-customer`).type('form')
    .send({ _csrf: csrfFrom(page.text), action: 'create' });
  assert.equal(response.status, 303);
  page = await env.agent.get(`/orders/${order.id}`);
  text = plain(page.text);
  assert.match(text, /Where should this order go\?/);
  assert.match(text, /StockChief already emailed|StockChief wrote the exact question|did not provide a usable destination/);
  assert.doesNotMatch(text, /Record what physically left/);

  response = await env.agent.post(`/sales/orders/${order.id}/resolve-delivery`).type('form')
    .send({ _csrf: csrfFrom(page.text), deliveryMethod: 'PICKUP' });
  assert.equal(response.status, 303);
  page = await env.agent.get(`/orders/${order.id}`);
  assert.match(plain(page.text), /Confirm this order and reserve stock|Give the selling price, then confirm this order/);
  env.db.close();
});

test('a customer can be created directly without first creating an order', async () => {
  const env = await setup([]);
  let page = await env.agent.get('/sales/customers/new');
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /Who is the customer\?/);
  assert.match(text, /Only the name is required/);

  const response = await env.agent.post('/sales/customers').type('form').send({
    _csrf: csrfFrom(page.text), name: 'Walk-in Customer', email: 'walkin@example.test',
  });
  assert.equal(response.status, 303);
  const customer = env.db.prepare("SELECT * FROM customers WHERE email = 'walkin@example.test'").get();
  assert.ok(customer);
  assert.equal(response.headers.location, `/sales/customers/${customer.id}`);

  page = await env.agent.get('/orders');
  assert.match(page.text, /href="\/sales\/customers\/new"[^>]*>[^<]*Add a customer</);
  env.db.close();
});

test('an order whose product has no selling price can still be approved: the price is asked for right there', async () => {
  /*
   * Needs you sent the owner to approve SO-1001 and the page showed a warning
   * and no button, because the shoes had come from a supplier invoice and had
   * a cost but no selling price. StockChief will not invent one. It asks for it
   * on the approval itself and confirms in the same step.
   */
  const env = await setup([]);
  const connectorId = connectMailbox(env);
  const item = makeQuantityItem(env.db, env.ctx, { name: 'bike toe lace', baseCode: 'TBD-36' });
  require('../../src/sales/sales-order-service').createCustomer(env.db, env.ctx,
    { name: 'Moshe Ekstein', email: 'arye6700@gmail.com' });
  const ingestion = require('../../src/connections/email-ingestion');
  const orderFromEmail = require('../../src/sales/order-from-email');
  const captured = ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId },
    { occurredAt: new Date().toISOString(), data: { messageId: 'g-2', sender: 'arye6700@gmail.com',
      subject: 'bike toe lace', bodyText: "I'd like to order bike toe lace 2 pieces", attachments: [] } });
  const { order } = await orderFromEmail.draft(env.db, env.ctx, captured.actionRecordId, {
    provider: { complete: async () => ({ data: { isAnOrder: true, contactName: 'Moshe Ekstein', phone: '', deliveryMethod: 'PICKUP',
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

test('the payment email StockChief wrote is on the order, readable, with the send button — not just a button to write it', async () => {
  /*
   * After confirming, the page said "StockChief made a $300.00 payment link and
   * wrote the email — it is on the order, ready to send", and the order
   * showed a button labelled "Email it to Moshe Ekstein" and nothing else.
   * The owner asked where the email was. Fair question.
   */
  const registry = require('../../src/payments/provider');
  const fakePaymentProvider = {
    async createCustomer() { return { externalCustomerId: 'cus_1' }; },
    async createInvoice() { return { externalInvoiceId: 'in_1', hostedUrl: 'https://pay.test/in_1' }; },
    async getHostedPaymentUrl() { return 'https://pay.test/in_1'; },
    async refundPayment() { return { externalRefundId: 're_1' }; },
    verifyEvent(raw) { return raw; },
    readEvent() { return { kind: 'IGNORED' }; },
  };
  let undo = () => {};
  try {
    const env = await setup([]);
    // createApp installs the normal adapter, so replace it only after the app
    // exists. This test verifies the order/email flow, not Stripe's network.
    undo = registry.register('stripe', fakePaymentProvider);
    require('../../src/payments/accounts').connect(env.db, env.ctx, env.membership,
      { secretKey: 'sk_test_halfi_messages_0000' });
    const connectorId = connectMailbox(env);
    const item = makeQuantityItem(env.db, env.ctx, { name: 'bike toe lace', baseCode: 'TBD-36' });
    require('../../src/sales/sales-order-service').createCustomer(env.db, env.ctx,
      { name: 'Moshe Ekstein', email: 'arye6700@gmail.com' });
    require('../../src/pricing/price-service').setPrice(env.db, env.ctx, { skuId: item.skuId, amount: '150.00', currency: 'USD' });
    const ingestion = require('../../src/connections/email-ingestion');
    const orderFromEmail = require('../../src/sales/order-from-email');
    const captured = ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId },
      { occurredAt: new Date().toISOString(), data: { messageId: 'g-4', sender: 'arye6700@gmail.com',
        subject: 'bike toe lace', bodyText: "I'd like to order bike toe lace 2 pieces", attachments: [] } });
    const { order } = await orderFromEmail.draft(env.db, env.ctx, captured.actionRecordId, {
      provider: { complete: async () => ({ data: { isAnOrder: true, contactName: 'Moshe Ekstein', phone: '', deliveryMethod: 'PICKUP',
        lines: [{ itemText: 'bike toe lace', variantText: '', quantity: 2 }] } }) },
    });

    let page = await env.agent.get(`/orders/${order.id}`);
    await env.agent.post(`/sales/orders/${order.id}/confirm`).type('form').send({ _csrf: csrfFrom(page.text) });

    page = await env.agent.get(`/orders/${order.id}`);
    const text = plain(page.text);
    assert.match(text, /\$300\.00 asked for/);
    assert.match(text, /StockChief wrote the email to Moshe Ekstein\. It has not been sent\./);
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
