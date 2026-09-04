'use strict';

/*
 * A customer who has never written before.
 *
 * The claim under test is that an ordinary email — no account, no portal, no
 * approved-sender rule — reaches Foundry, is understood as an order, and
 * comes back as a draft the owner approves. And that everything Foundry says
 * about it came out of the email rather than out of the model.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ingestion = require('../../src/connections/email-ingestion');
const orderFromEmail = require('../../src/sales/order-from-email');
const connections = require('../../src/connections/service');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Classic Cotton T-Shirt', baseCode: 'COTTON-TEE-B-SMALL' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '15.00', currency: 'USD' });
  const created = connections.create(db, workspace.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  return { db, workspace, ctx: workspace.ctx, membership, item, connectorId: created.connection.id };
}

let sequence = 0;
function arrive(env, { sender, subject, body }) {
  sequence += 1;
  const result = ingestion.capture(env.db,
    { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId },
    { occurredAt: new Date().toISOString(),
      data: { messageId: `ext-order-${sequence}`, sender, subject, bodyText: body, attachments: [] } });
  return env.db.prepare('SELECT * FROM connection_email_messages WHERE id = ?').get(result.actionRecordId);
}

/* A reader that reports exactly what it is told to, so the plumbing is what is under test. */
function reader(data) {
  return { complete: async () => ({ data }) };
}

test('a stranger asking to buy something is read as an order, not as supplier post', () => {
  assert.equal(ingestion.classify('Order supplies', 'I would like to order 10 pieces of the COTTON-TEE', []),
    'customer_order_request');
  assert.equal(ingestion.classify('Hello', 'Can we buy 20 of these?', []), 'customer_order_request');

  // A supplier sending our own paperwork back is the opposite direction.
  assert.equal(ingestion.classify('Purchase Order 4471', 'Confirming receipt', [], { knownSupplier: true }),
    'purchase_order');
  // The same words from somebody with no rule are somebody trying to buy.
  assert.equal(ingestion.classify('Hello', 'We would like to place an order for 5 units', []),
    'customer_order_request');

  // And ordinary post stays ordinary post.
  assert.equal(ingestion.classify('Our spring catalogue is out', 'Browse the new range', []), 'supplier_message');
  assert.equal(ingestion.classify('Re: delivery', 'Running late today', [], { knownSupplier: true }), 'supplier_message');
});

test('an unapproved sender is captured, and captured untrusted', () => {
  const env = setup();
  const message = arrive(env, { sender: 'hendel@example.test', subject: 'Order supplies',
    body: 'I would like to order 10 pieces of the COTTON-TEE-B-SMALL' });
  assert.equal(message.trust_status, 'UNTRUSTED', 'a stranger is heard, not believed');
  assert.equal(message.classification, 'customer_order_request');
});

test('the email becomes a draft order, priced from the catalogue and not from the email', async () => {
  const env = setup();
  const message = arrive(env, { sender: 'hendel@example.test', subject: 'Order supplies',
    body: 'I would like to order 10 pieces of the COTTON-TEE-B-SMALL. Name: Moshe Ekstein, phone number: 3476756700' });

  const { order } = await orderFromEmail.draft(env.db, env.ctx, message.id, {
    provider: reader({ isAnOrder: true, contactName: 'Moshe Ekstein', phone: '3476756700',
      lines: [{ itemText: 'COTTON-TEE-B-SMALL', variantText: '', quantity: 10 }] }),
  });

  assert.ok(order, 'the email produced an order');
  assert.equal(order.status, 'DRAFT', 'nothing is committed until the owner says so');

  const lines = env.db.prepare(`SELECT quantity_ordered, unit_price_minor FROM sales_order_lines
    WHERE sales_order_id = ?`).all(order.id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity_ordered, 10, 'the quantity is the one they wrote');
  assert.equal(lines[0].unit_price_minor, 1500, 'the price is ours, because a customer does not set it by asking');

  // Identity comes from the address the mail arrived from.
  const customer = env.db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id);
  assert.equal(customer.email, 'hendel@example.test');
  assert.match(order.notes, /hendel@example\.test/, 'the order says where it came from');
  assert.match(order.notes, /3476756700/, 'and keeps the phone number they gave');
});

test('a mailbox polled twice does not order the same thing twice', async () => {
  const env = setup();
  const message = arrive(env, { sender: 'hendel@example.test', subject: 'Order supplies',
    body: 'I would like to order 10 pieces of the COTTON-TEE-B-SMALL' });
  const options = { provider: reader({ isAnOrder: true, contactName: 'Moshe', phone: '',
    lines: [{ itemText: 'COTTON-TEE-B-SMALL', variantText: '', quantity: 10 }] }) };

  const first = await orderFromEmail.draft(env.db, env.ctx, message.id, options);
  const second = await orderFromEmail.draft(env.db, env.ctx, message.id, options);
  assert.equal(second.replayed, true);
  assert.equal(second.order.id, first.order.id, 'the same email is the same order');
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM sales_orders').get().n, 1);
});

test('a product nobody wrote down cannot get onto the order', async () => {
  const env = setup();
  const message = arrive(env, { sender: 'hendel@example.test', subject: 'Order supplies',
    body: 'I would like to order 10 pieces of the COTTON-TEE-B-SMALL' });

  /*
   * The reader answers with a real catalogue product the email never mentions.
   * It resolves perfectly, which is exactly why it is dangerous: without
   * grounding it would arrive on the order looking like a fact.
   */
  const { order, because } = await orderFromEmail.draft(env.db, env.ctx, message.id, {
    provider: reader({ isAnOrder: true, contactName: '', phone: '',
      lines: [{ itemText: 'Classic Cotton T-Shirt', variantText: 'Large', quantity: 99 }] }),
  });
  assert.equal(order, null, 'an invented product is not an order');
  assert.match(because, /Nothing in that email/i);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM sales_orders').get().n, 0);
});

test('what Foundry could not identify is written down, not dropped', async () => {
  const env = setup();
  const message = arrive(env, { sender: 'hendel@example.test', subject: 'Order supplies',
    body: 'I would like to order 10 COTTON-TEE-B-SMALL and 4 gross of the brass eyelets' });

  const { order, unmatched } = await orderFromEmail.draft(env.db, env.ctx, message.id, {
    provider: reader({ isAnOrder: true, contactName: '', phone: '', lines: [
      { itemText: 'COTTON-TEE-B-SMALL', variantText: '', quantity: 10 },
      { itemText: 'brass eyelets', variantText: '', quantity: 4 },
    ] }),
  });
  assert.ok(order, 'the half that was understood still becomes an order');
  assert.deepEqual(unmatched, ['4 × brass eyelets']);
  assert.match(order.notes, /brass eyelets/,
    'because an order carrying half a request would look complete');
});

test('a reader that fails invents nothing', async () => {
  const env = setup();
  const message = arrive(env, { sender: 'hendel@example.test', subject: 'Order supplies',
    body: 'I would like to order some shirts' });
  const { order, because } = await orderFromEmail.draft(env.db, env.ctx, message.id, {
    provider: { complete: async () => { throw new Error('no model today'); } },
  });
  assert.equal(order, null);
  assert.match(because, /could not read/);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM sales_orders').get().n, 0);
});

test('a customer who already exists is not duplicated', async () => {
  const env = setup();
  const existing = sales.createCustomer(env.db, env.ctx, { name: 'Chavy', email: 'hendel@example.test' });
  const message = arrive(env, { sender: 'hendel@example.test', subject: 'Order supplies',
    body: 'I would like to order 10 pieces of the COTTON-TEE-B-SMALL' });
  const { order } = await orderFromEmail.draft(env.db, env.ctx, message.id, {
    provider: reader({ isAnOrder: true, contactName: 'Somebody Else', phone: '',
      lines: [{ itemText: 'COTTON-TEE-B-SMALL', variantText: '', quantity: 10 }] }),
  });
  assert.equal(order.customer_id, existing.id, 'the address is the identity');
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);
});

/*
 * What happened after the draft.
 *
 * On a real mailbox the order was drafted — SO-1001, right customer, right
 * line — and the owner never found out: Needs you said nothing, the mailbox
 * page said "Ignored sender", and a second copy of the same email produced
 * nothing at all, for a reason nobody recorded.
 */
const needsYou = () => require('../../src/manager/needs-you-inbox');
const ORDER_TWO = () => reader({ isAnOrder: true, contactName: 'Moshe Ekstein', phone: '',
  lines: [{ itemText: 'COTTON-TEE-B-SMALL', variantText: '', quantity: 2 }] });

test('a drafted order is a decision in Needs you, not a secret', async () => {
  const env = setup();
  const message = arrive(env, { sender: 'arye@example.test', subject: 'bike toe lace',
    body: 'I would like to order 2 pieces of the COTTON-TEE-B-SMALL' });
  const { order } = await orderFromEmail.draft(env.db, env.ctx, message.id, { provider: ORDER_TWO() });

  const entry = needsYou().inbox(env.db, env.workspace.workspaceId).find((e) => e.id === `email-order:${order.id}`);
  assert.ok(entry, 'the approval is asked for');
  assert.match(entry.title, /^Approve SO-\d+ for Moshe Ekstein: 2 × Classic Cotton T-Shirt/);
  assert.equal(entry.href, `/orders/${order.id}`);
  assert.match(entry.happened, /arye@example\.test wrote "bike toe lace"/);
  assert.match(entry.happened, /Nothing is committed/);
});

test('the same request sent twice is one draft order, and the second email says so', async () => {
  const env = setup();
  const first = arrive(env, { sender: 'arye@example.test', subject: 'bike toe lace',
    body: 'I would like to order 2 pieces of the COTTON-TEE-B-SMALL' });
  const second = arrive(env, { sender: 'arye@example.test', subject: null,
    body: 'I would like to order 2 pieces of the COTTON-TEE-B-SMALL' });

  const a = await orderFromEmail.draft(env.db, env.ctx, first.id, { provider: ORDER_TWO() });
  const b = await orderFromEmail.draft(env.db, env.ctx, second.id, { provider: ORDER_TWO() });

  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM sales_orders').get().n, 1, 'one order, not two');
  assert.equal(b.order.id, a.order.id);
  assert.equal(b.duplicateOf, a.order.order_number);
  const row = env.db.prepare('SELECT order_draft_reason FROM connection_email_messages WHERE id = ?').get(second.id);
  assert.match(row.order_draft_reason, new RegExp(`^Same request as ${a.order.order_number}`));

  const decisions = needsYou().inbox(env.db, env.workspace.workspaceId).filter((e) => e.id.startsWith('email-order'));
  assert.equal(decisions.length, 1, 'one decision, not two');
});

test('an order Foundry could not read is handed to the owner with the reason, not dropped', async () => {
  const env = setup();
  const message = arrive(env, { sender: 'arye@example.test', subject: 'order',
    body: 'I would like to order some of the usual' });
  const out = await orderFromEmail.draft(env.db, env.ctx, message.id,
    { provider: { complete: async () => { throw new Error('model down'); } } });
  assert.equal(out.order, null);

  const row = env.db.prepare('SELECT order_draft_reason FROM connection_email_messages WHERE id = ?').get(message.id);
  assert.match(row.order_draft_reason, /could not read/i);
  const entry = needsYou().inbox(env.db, env.workspace.workspaceId).find((e) => e.id === `email-order-unread:${message.id}`);
  assert.ok(entry, 'the owner is handed the email');
  assert.match(entry.title, /Read the order from arye@example\.test yourself/);
  assert.equal(entry.href, `/mail/${message.id}`);
  assert.match(entry.why, /could not read/i);
});

test('a message left unexplained by an earlier check is drafted on the next one', async () => {
  const env = setup();
  arrive(env, { sender: 'arye@example.test', subject: 'bike toe lace',
    body: 'I would like to order 2 pieces of the COTTON-TEE-B-SMALL' });
  const results = await orderFromEmail.draftPending(env.db, env.ctx, { provider: ORDER_TWO() });
  assert.equal(results.length, 1);
  assert.ok(results[0].order, 'drafted on the sweep');

  const again = await orderFromEmail.draftPending(env.db, env.ctx, { provider: ORDER_TWO() });
  assert.equal(again.length, 0, 'nothing left to explain, so nothing is re-read');
});

test('two drafts already made for one request collapse to the first, and the second says why', async () => {
  const env = setup();
  const first = arrive(env, { sender: 'arye@example.test', subject: 'bike toe lace',
    body: 'I would like to order 2 pieces of the COTTON-TEE-B-SMALL' });
  const second = arrive(env, { sender: 'arye@example.test', subject: null,
    body: 'I would like to order 2 pieces of the COTTON-TEE-B-SMALL' });
  const a = await orderFromEmail.draft(env.db, env.ctx, first.id, { provider: ORDER_TWO() });
  // What the earlier build did with the second email: a second draft, no questions asked.
  const twin = sales.createOrder(env.db, env.ctx, { customerId: a.order.customer_id,
    lines: [{ skuId: env.item.skuId, quantity: 2 }], notes: 'old build' });
  env.db.prepare('UPDATE sales_orders SET source_email_message_id = ? WHERE id = ?').run(second.id, twin.id);

  const collapsed = await orderFromEmail.draftPending(env.db, env.ctx, { provider: ORDER_TWO() });
  assert.equal(collapsed.length, 0, 'nothing new to draft');
  const rows = env.db.prepare('SELECT order_number, status, cancel_reason FROM sales_orders ORDER BY created_at').all();
  assert.equal(rows[0].status, 'DRAFT', 'the first draft stands');
  assert.equal(rows[1].status, 'CANCELLED', 'the twin does not');
  assert.match(rows[1].cancel_reason, new RegExp(`Same request as ${rows[0].order_number}`));
  const note = env.db.prepare('SELECT order_draft_reason FROM connection_email_messages WHERE id = ?').get(second.id);
  assert.match(note.order_draft_reason, new RegExp(`^Same request as ${rows[0].order_number}`));
  const decisions = needsYou().inbox(env.db, env.workspace.workspaceId).filter((e) => e.id.startsWith('email-order'));
  assert.equal(decisions.length, 1, 'one approval to give, not two');
});
