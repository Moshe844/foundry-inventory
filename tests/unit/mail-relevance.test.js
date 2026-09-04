'use strict';

/*
 * Only the business's mail reaches Foundry.
 *
 * The owner connected the shop's Gmail and got everything: newsletters, bank
 * alerts, delivery robots, personal mail — all of it captured, triaged, listed
 * and counted as work on the one screen they are supposed to trust. Their
 * instruction was plain: only related mail should be sent to Foundry, and when
 * a customer writes asking to order something, Foundry should have prepared
 * the order by the time they look.
 *
 * Both halves are asserted here, because a gate that keeps the customer out is
 * worse than no gate at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const relevance = require('../../src/connections/mail-relevance');
const ingestion = require('../../src/connections/email-ingestion');
const setAside = require('../../src/connections/mail-set-aside');
const connections = require('../../src/connections/service');
const sales = require('../../src/sales/sales-order-service');
const poService = require('../../src/purchasing/po-service');
const suppliers = require('../../src/purchasing/supplier-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Classic Cotton T-Shirt', baseCode: 'COTTON-TEE-B-SMALL' });
  const created = connections.create(db, workspace.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  return { db, workspace, ctx: workspace.ctx, membership, item, connectorId: created.connection.id };
}

const judge = (env, message) =>
  relevance.judge(env.db, env.workspace.workspaceId, env.connectorId, message);

const now = () => new Date().toISOString();

/* ------------------------------------------------------------ turned away */

test('a newsletter is not the business, whatever commercial words it uses', () => {
  const env = setup();
  const verdict = judge(env, { messageId: 'n-1', sender: 'news@brand.test',
    subject: 'Order now and save 20% on everything in stock',
    bodyText: 'Our biggest sale of the year. Shop the range.\n\nUnsubscribe',
    receivedAt: now(), attachments: [] });
  assert.equal(verdict.keep, false);
  assert.match(verdict.reason, /unsubscribe link/i);
  env.db.close();
});

test('"nothing about purchasing" is not somebody purchasing', () => {
  /*
   * The first version of this gate matched single commercial words and let
   * this exact sentence through, which is the same trap the reply triage
   * already had to be rescued from. Trading language has to be somebody
   * trading with us, not the vocabulary of trade.
   */
  const env = setup();
  assert.equal(relevance.tradingLanguage('weekly news\nnothing about purchasing.'), null);
  assert.equal(relevance.tradingLanguage('order now and save 20%'), null);
  const verdict = judge(env, { messageId: 'n-2', sender: 'newsletter@example.test',
    subject: 'Weekly news', bodyText: 'Nothing about purchasing.', receivedAt: now(), attachments: [] });
  assert.equal(verdict.keep, false);
  assert.match(verdict.reason, /nothing in it mentions an order/i);
  env.db.close();
});

test('a bank alert is nobody Foundry has to answer', () => {
  const env = setup();
  const verdict = judge(env, { messageId: 'n-3', sender: 'no.reply.alerts@bank.test',
    subject: 'Your account balance', bodyText: 'A payment of $40.00 was made on your card.',
    receivedAt: now(), attachments: [] });
  assert.equal(verdict.keep, false);
  assert.match(verdict.reason, /nobody reads replies/i);
  env.db.close();
});

/* ---------------------------------------------------------------- kept */

test('a stranger asking to buy is the business, and says which words made it so', () => {
  const env = setup();
  const verdict = judge(env, { messageId: 'k-1', sender: 'chavy@example.test',
    subject: 'Hello', bodyText: 'Do you have these in a small? We would like to order 20 pieces.',
    receivedAt: now(), attachments: [] });
  assert.equal(verdict.keep, true);
  assert.equal(verdict.relationship, 'stranger');
  assert.match(verdict.reason, /we would like to order/i);
  env.db.close();
});

test('a message quoting one of our numbers is ours, even from an address nobody reads', () => {
  /*
   * A carrier's robot and a supplier's billing system both write from
   * no-reply. If it quotes our purchase order, the address is beside the
   * point — which is why naming one of our records is tested above the bulk
   * rule rather than below it.
   */
  const env = setup();
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, { name: 'Chongqing Langchi' });
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, destinationLocationId: env.workspace.store.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 100, unitCost: 5 }],
  });
  const verdict = judge(env, { messageId: 'k-2', sender: 'noreply@carrier.test',
    subject: `Shipment update for ${order.poNumber}`, bodyText: 'Your consignment has left the port.',
    receivedAt: now(), attachments: [] });
  assert.equal(verdict.keep, true);
  assert.match(verdict.reason, new RegExp(order.poNumber));
  env.db.close();
});

test('a number written with a different dash is still our number', () => {
  const env = setup();
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, { name: 'Langchi' });
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, destinationLocationId: env.workspace.store.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 10, unitCost: 5 }],
  });
  const spaced = order.poNumber.replace(/-/g, ' ');
  const verdict = judge(env, { messageId: 'k-3', sender: 'someone@elsewhere.test',
    subject: `Re: ${spaced}`, bodyText: 'Attached.', receivedAt: now(), attachments: [] });
  assert.equal(verdict.keep, true, `"${spaced}" should still match ${order.poNumber}`);
  env.db.close();
});

test('a product code of ours speaks for the business; a word from its name does not', () => {
  const env = setup();
  const kept = judge(env, { messageId: 'k-4', sender: 'someone@elsewhere.test',
    subject: 'COTTON-TEE-B-SMALL', bodyText: 'Availability?', receivedAt: now(), attachments: [] });
  assert.equal(kept.keep, true);
  assert.match(kept.reason, /product code/i);

  const turnedAway = judge(env, { messageId: 'k-5', sender: 'style@magazine.test',
    subject: 'The classic cotton look this autumn', bodyText: 'Ten ways to wear it.\nunsubscribe',
    receivedAt: now(), attachments: [] });
  assert.equal(turnedAway.keep, false, 'a product name is ordinary English; a code is not');
  env.db.close();
});

test('somebody we trade with is the business, but their marketing is still marketing', () => {
  const env = setup();
  sales.createCustomer(env.db, env.ctx, { name: 'ABC School', email: 'orders@abcschool.test' });

  const kept = judge(env, { messageId: 'c-1', sender: 'orders@abcschool.test',
    subject: 'Quick question', bodyText: 'Is Tuesday still fine?', receivedAt: now(), attachments: [] });
  assert.equal(kept.keep, true);
  assert.equal(kept.relationship, 'customer');
  assert.match(kept.reason, /ABC School is a customer/);

  const blast = judge(env, { messageId: 'c-2', sender: 'orders@abcschool.test',
    subject: 'ABC School spring newsletter', bodyText: 'Term dates and news.\nUnsubscribe here.',
    receivedAt: now(), attachments: [] });
  assert.equal(blast.keep, false, 'buying from someone does not make their mailing list ours');
  env.db.close();
});

test('a reply on a conversation Foundry already keeps stays in the conversation', () => {
  const env = setup();
  ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId }, {
    occurredAt: now(),
    data: { messageId: 'thread-first', threadId: 'thread-42', sender: 'chavy@example.test',
      subject: 'Order', bodyText: 'We would like to order 20 pieces.', attachments: [] },
  });
  const verdict = judge(env, { messageId: 'thread-second', threadId: 'thread-42',
    sender: 'chavy@example.test', subject: 'Re: Order', bodyText: 'Thanks!',
    receivedAt: now(), attachments: [] });
  assert.equal(verdict.keep, true);
  assert.match(verdict.reason, /already keeping/i);
  env.db.close();
});

test('a document dropped in with no covering note is still a document', () => {
  const env = setup();
  const verdict = judge(env, { messageId: 'd-1', sender: 'accounts@elsewhere.test',
    subject: 'Invoice 5512', bodyText: '', receivedAt: now(),
    attachments: [{ filename: 'invoice-5512.pdf' }] });
  assert.equal(verdict.keep, true);
  assert.match(verdict.reason, /invoice/i);
  env.db.close();
});

/* ------------------------------------------------------- who is speaking */

test('a customer writing about anything is a customer message, not supplier post', () => {
  /*
   * The classifier's fallback was `supplier_message`, on the assumption that
   * everybody who is not buying is selling. So a customer asking where their
   * order was filed as post from a supplier, and the screen the owner reads
   * did not know somebody was waiting on them.
   */
  const env = setup();
  sales.createCustomer(env.db, env.ctx, { name: 'ABC School', email: 'orders@abcschool.test' });
  const auth = { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId };
  ingestion.capture(env.db, auth, { occurredAt: now(),
    data: { messageId: 'cm-1', sender: 'orders@abcschool.test', subject: 'Where is it?',
      bodyText: 'Any update on when this arrives?', attachments: [] } });
  const row = env.db.prepare(`SELECT classification, reply_state FROM connection_email_messages
    WHERE workspace_id = ? AND external_message_id = ?`).get(env.workspace.workspaceId, 'cm-1');
  assert.equal(row.classification, 'customer_message');
  assert.equal(row.reply_state, 'NEEDS_REPLY');

  // And a stranger with the same words is still not claimed as a customer.
  assert.equal(ingestion.classify('Where is it?', 'Any update?', []), 'supplier_message');
  env.db.close();
});

test('somebody asking to buy is waiting on you, however they phrased it', () => {
  /*
   * A real customer wrote "I want to order size 36, 2 pieces" — no question
   * mark, no phrase on the asking list — and Foundry read it as an order
   * request and then filed it as handled, nothing needed. What the message is
   * outranks how it scans.
   */
  const env = setup();
  const auth = { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId };
  ingestion.capture(env.db, auth, { occurredAt: now(),
    data: { messageId: 'buy-1', sender: 'motty@example.test', subject: '',
      bodyText: 'Hi,\nI want to order size 36 2 pieces\n\nMoshe', attachments: [] } });
  const row = env.db.prepare(`SELECT classification, reply_state, reply_reason
    FROM connection_email_messages WHERE workspace_id = ? AND external_message_id = ?`)
    .get(env.workspace.workspaceId, 'buy-1');
  assert.equal(row.classification, 'customer_order_request');
  assert.equal(row.reply_state, 'NEEDS_REPLY');
  assert.match(row.reply_reason, /asking to buy/i);
  env.db.close();
});

test('an order request already filed as handled is put back where somebody can see it', () => {
  const env = setup();
  const auth = { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId };
  ingestion.capture(env.db, auth, { occurredAt: now(),
    data: { messageId: 'buried-1', sender: 'motty@example.test', subject: '',
      bodyText: 'I want to order 2 pieces', attachments: [] } });
  // As an older build left it.
  env.db.prepare(`UPDATE connection_email_messages SET reply_state = 'HANDLED',
    reply_reason = 'Nothing in this asks for an answer.' WHERE workspace_id = ?`)
    .run(env.workspace.workspaceId);

  relevance.sweepCaptured(env.db, env.workspace.workspaceId, env.connectorId);
  const row = env.db.prepare(`SELECT reply_state FROM connection_email_messages
    WHERE workspace_id = ? AND external_message_id = ?`).get(env.workspace.workspaceId, 'buried-1');
  assert.equal(row.reply_state, 'NEEDS_REPLY');
  assert.equal(setAside.count(env.db, env.workspace.workspaceId), 0,
    'and an order request is never the mail that gets set aside');
  env.db.close();
});

test('a message a person filed themselves is left exactly where they put it', () => {
  const env = setup();
  const auth = { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId };
  ingestion.capture(env.db, auth, { occurredAt: now(),
    data: { messageId: 'mine-1', sender: 'someone@elsewhere.test', subject: 'Lunch?',
      bodyText: 'Are you free Thursday?', attachments: [] } });
  env.db.prepare(`UPDATE connection_email_messages SET reply_state_by_user_id = ?
    WHERE workspace_id = ?`).run(env.ctx.actorId, env.workspace.workspaceId);

  relevance.sweepCaptured(env.db, env.workspace.workspaceId, env.connectorId);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM connection_email_messages
    WHERE workspace_id = ? AND external_message_id = ?`).get(env.workspace.workspaceId, 'mine-1').n, 1,
  'the gate does not overrule a decision somebody made by hand');
  env.db.close();
});

/* ------------------------------------------------------------- the record */

test('mail that was set aside keeps its envelope, its reason, and nothing else', () => {
  const env = setup();
  const message = { messageId: 'sa-1', sender: 'News@Brand.Test', subject: 'Weekly news',
    bodyText: 'The whole of a private message.', receivedAt: '2026-09-01T09:00:00.000Z', attachments: [] };
  setAside.record(env.db, env.workspace.workspaceId, env.connectorId, message, 'Set aside because it is a newsletter.');
  setAside.record(env.db, env.workspace.workspaceId, env.connectorId, message, 'Set aside because it is a newsletter.');

  const rows = setAside.list(env.db, env.workspace.workspaceId);
  assert.equal(rows.length, 1, 'an overlapping poll offers the same message again and must not pile up');
  assert.equal(rows[0].sender, 'news@brand.test');
  assert.equal(rows[0].subject, 'Weekly news');
  assert.equal(setAside.count(env.db, env.workspace.workspaceId), 1);
  assert.ok(!JSON.stringify(rows[0]).includes('The whole of a private message'),
    'the body of mail that is not the business is never stored');
  env.db.close();
});

test('a message a person brought in is not set aside again on the next poll', () => {
  const env = setup();
  const id = setAside.record(env.db, env.workspace.workspaceId, env.connectorId,
    { messageId: 'sa-2', sender: 'someone@elsewhere.test', subject: 'Hello', receivedAt: now() },
    'Set aside because nothing in it mentions an order.');
  assert.equal(setAside.alreadySeen(env.db, env.workspace.workspaceId, env.connectorId, 'sa-2'), false);
  setAside.markBroughtIn(env.db, env.workspace.workspaceId, id, null, env.ctx.actorId);
  assert.equal(setAside.alreadySeen(env.db, env.workspace.workspaceId, env.connectorId, 'sa-2'), true);
  assert.equal(setAside.count(env.db, env.workspace.workspaceId), 0, 'and it leaves the drawer');
  env.db.close();
});
