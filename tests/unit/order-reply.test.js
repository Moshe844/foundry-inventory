'use strict';

/*
 * What a customer hears when their order does not simply go through.
 *
 * A real customer wrote "I want to order size 36 2 pieces". StockChief read it
 * as an order, could not tell which of four shoes they meant, and produced:
 * a line in Needs You saying read it yourself, a second line saying reply to
 * them, and — for the customer — nothing at all.
 *
 * Three things were wrong and each is asserted here. The catalogue could
 * answer "which four", and was never asked. The refusal said "nothing matched"
 * when StockChief knew exactly what could have been meant. And nobody wrote back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const orderFromEmail = require('../../src/sales/order-from-email');
const orderReply = require('../../src/sales/order-reply');
const ingestion = require('../../src/connections/email-ingestion');
const needsYou = require('../../src/manager/needs-you-inbox');
const connections = require('../../src/connections/service');
const resolver = require('../../src/actions/resolver');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

/* Two shoes, both made in a 36 — the shape of the real catalogue. */
function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'HalFi Shoes' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const lace = makeQuantityItem(db, workspace.ctx, { name: 'moc toe lace', baseCode: '7L665-1-36' });
  const slip = makeQuantityItem(db, workspace.ctx, { name: 'moc toe slip in', baseCode: '7L665-3-36' });
  for (const made of [lace, slip]) {
    db.prepare("UPDATE skus SET variant_label = '36' WHERE id = ?").run(made.skuId);
    prices.setPrice(db, workspace.ctx, { skuId: made.skuId, amount: '80.00', currency: 'USD' });
  }
  const created = connections.create(db, workspace.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  return { db, workspace, ctx: workspace.ctx, membership, lace, slip, connectorId: created.connection.id };
}

let sequence = 0;
function arrive(env, body, subject = '') {
  sequence += 1;
  const messageId = `order-${sequence}`;
  ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId }, {
    occurredAt: new Date().toISOString(),
    data: { messageId, sender: 'motty6700@example.test', subject, bodyText: body, attachments: [] },
  });
  return env.db.prepare(`SELECT id FROM connection_email_messages
    WHERE workspace_id = ? AND external_message_id = ?`).get(env.workspace.workspaceId, messageId).id;
}

/* The reader, with no model: it reports exactly what the email said. */
const reads = (lines) => ({ provider: { complete: async () => ({
  data: { isAnOrder: true, contactName: '', phone: '', lines },
}) } });

/* -------------------------------------------------------------- the search */

test('a word the catalogue has never heard of does not veto the whole search', () => {
  /*
   * "size 36" found nothing while "36" found four products. Search terms drop
   * tokens under three characters, so the size itself was thrown away, and
   * what remained asked for a row containing the word "size" — which is the
   * name of an option axis, not a value, and appears in no column anywhere.
   */
  const env = setup();
  const vague = resolver.resolveSku(env.db, env.workspace.workspaceId, '', 'size 36');
  assert.equal(vague.ok, false);
  assert.equal(vague.reason, 'ambiguous', 'StockChief knows which products come in a 36');
  assert.equal(vague.candidates.length, 2);
  // "size" is a describing word, not a search word: it is set aside before the search rather than reported as unplaceable.
  assert.deepEqual(vague.ignored || [], [], 'the axis word is not searched for at all');

  const exact = resolver.resolveSku(env.db, env.workspace.workspaceId, 'moc toe lace', 'size 36');
  assert.equal(exact.ok, true, 'naming the style still resolves to one product');
  assert.equal(exact.value.id, env.lace.skuId);

  const nonsense = resolver.resolveSku(env.db, env.workspace.workspaceId, '', 'size 99');
  assert.equal(nonsense.reason, 'not_found', 'a query of words nobody sells still finds nothing');
  env.db.close();
});

/* ------------------------------------------------------------ the question */

test('an ambiguous order names the actual choices, and writes the question to send', async () => {
  const env = setup();
  const messageId = arrive(env, 'Hi,\nI want to order size 36 2 pieces\n\nMoshe');
  const result = await orderFromEmail.draft(env.db, env.ctx, messageId,
    reads([{ itemText: '', variantText: 'size 36', quantity: 2 }]));

  assert.equal(result.order, null, 'StockChief does not choose between four shoes');
  assert.match(result.because, /2 different products here/);
  assert.match(result.because, /moc toe lace/);
  assert.match(result.because, /moc toe slip in/);
  assert.match(result.because, /will not choose between them/);

  const draft = env.db.prepare(`SELECT draft_subject, draft_body, draft_source, reply_sent_at
    FROM connection_email_messages WHERE id = ?`).get(messageId);
  assert.equal(draft.draft_source, 'records', 'the question is built from the catalogue, not written by a model');
  assert.match(draft.draft_body, /2 × size 36/);
  assert.match(draft.draft_body, /moc toe lace 36 and moc toe slip in 36/);
  assert.match(draft.draft_body, /Which did you mean\?/);
  assert.equal(draft.reply_sent_at, null, 'and nothing is sent');
  env.db.close();
});

test('one email is one decision, not two', async () => {
  /*
   * The same message arrived in Needs You twice — once as an order StockChief
   * could not read, once as mail nobody had answered — with the same sender,
   * the same button and the same destination.
   */
  const env = setup();
  const messageId = arrive(env, 'Hi,\nI want to order size 36 2 pieces');
  await orderFromEmail.draft(env.db, env.ctx, messageId,
    reads([{ itemText: '', variantText: 'size 36', quantity: 2 }]));

  const mine = needsYou.inbox(env.db, env.workspace.workspaceId)
    .filter((entry) => entry.href === `/mail/${messageId}`);
  assert.equal(mine.length, 1, 'one email, one card');
  assert.match(mine[0].title, /Read the order/);
  assert.match(mine[0].recommendation, /StockChief has written the question/);
  env.db.close();
});

/* --------------------------------------------------------- the conversation */

function arriveOnThread(env, threadId, body, subject = '') {
  sequence += 1;
  const messageId = `thread-${sequence}`;
  ingestion.capture(env.db, { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId }, {
    occurredAt: new Date().toISOString(),
    data: { messageId, threadId, sender: 'motty6700@example.test', subject, bodyText: body, attachments: [] },
  });
  return env.db.prepare(`SELECT * FROM connection_email_messages
    WHERE workspace_id = ? AND external_message_id = ?`).get(env.workspace.workspaceId, messageId);
}

test('the customer answers the question, and the order is made from the conversation', async () => {
  /*
   * The whole round trip, as it actually happened. StockChief asked which of
   * four shoes; the owner sent it; the customer replied "I would like the moc
   * toe slip in 36 please" — and that reply arrived as an unrelated message,
   * because there is no buying language in it. The customer had answered and
   * StockChief did not notice.
   *
   * Neither email is an order on its own: the first says how many and not
   * which, the second says which and not how many. Together they are one.
   */
  const env = setup();
  const first = arriveOnThread(env, 'gmail-thread-1', 'Hi,\nI want to order size 36 2 pieces');
  await orderFromEmail.draft(env.db, env.ctx, first.id,
    reads([{ itemText: '', variantText: 'size 36', quantity: 2 }]));
  // The owner reads StockChief's question and sends it.
  env.db.prepare(`UPDATE connection_email_messages SET reply_sent_at = ?, reply_state = 'WAITING'
    WHERE id = ?`).run(new Date().toISOString(), first.id);

  const answer = arriveOnThread(env, 'gmail-thread-1',
    'I would like the moc toe slip in 36 please.\n\nOn Fri, Sep 4, 2026 at 12:17 PM Moshe wrote:\n'
    + '> You asked for 2 × size 36. We make 4 of those — bike toe lace 36, bike\n'
    + '> toe slip in 36, moc toe lace 36 and moc toe slip in 36.', 'Re: your order');
  assert.equal(answer.classification, 'customer_order_request',
    'a reply on an unfinished order conversation is part of that order');

  const result = await orderFromEmail.draft(env.db, env.ctx, answer.id,
    reads([{ itemText: 'moc toe slip in', variantText: '36', quantity: 2 }]));
  assert.ok(result.order, 'the two messages together are an order');
  const lines = env.db.prepare('SELECT sku_id, quantity_ordered FROM sales_order_lines WHERE sales_order_id = ?')
    .all(result.order.id);
  assert.deepEqual(lines, [{ sku_id: env.slip.skuId, quantity_ordered: 2 }]);
  env.db.close();
});

test('our own question is never counted as words the customer wrote', () => {
  /*
   * The question named all four shoes. If that text were treated as the
   * customer's, the reader could answer with any of the four and the
   * grounding check would wave it through — which is the exact invention the
   * grounding exists to stop. Only their side of the thread counts, and only
   * the part they typed rather than the part their mail client quoted back.
   */
  const env = setup();
  const first = arriveOnThread(env, 'gmail-thread-2', 'I want to order size 36 2 pieces');
  env.db.prepare(`UPDATE connection_email_messages SET draft_body = ?, reply_sent_at = ?
    WHERE id = ?`).run('We make bike toe lace 36, bike toe slip in 36, moc toe lace 36 and moc toe slip in 36.',
    new Date().toISOString(), first.id);
  const answer = arriveOnThread(env, 'gmail-thread-2',
    'The slip in please.\n\nOn Fri, Sep 4, 2026 at 12:17 PM Moshe wrote:\n> moc toe lace 36 and moc toe slip in 36.',
    'Re: your order');

  const said = orderFromEmail.conversationWith(env.db, env.workspace.workspaceId, answer).join('\n');
  assert.match(said, /I want to order size 36 2 pieces/);
  assert.match(said, /The slip in please/);
  assert.ok(!/bike toe lace/.test(said), 'our own question is not in the customer\'s words');
  assert.ok(!/^>/m.test(said), 'and neither is the quotation of it');
  env.db.close();
});

test('a reply stranded by an older build is adopted into the order it answers', async () => {
  const env = setup();
  const first = arriveOnThread(env, 'gmail-thread-5', 'I want to order size 36 2 pieces');
  await orderFromEmail.draft(env.db, env.ctx, first.id,
    reads([{ itemText: '', variantText: 'size 36', quantity: 2 }]));
  const answer = arriveOnThread(env, 'gmail-thread-5', 'moc toe slip in 36 please', 'Re: your order');
  // As a build that read each message on its own left it.
  env.db.prepare("UPDATE connection_email_messages SET classification = 'supplier_message' WHERE id = ?")
    .run(answer.id);

  assert.equal(orderFromEmail.adoptThreadReplies(env.db, env.ctx), 1);
  assert.equal(env.db.prepare('SELECT classification FROM connection_email_messages WHERE id = ?')
    .get(answer.id).classification, 'customer_order_request');

  // Running again changes nothing, because there is nothing left to change.
  assert.equal(orderFromEmail.adoptThreadReplies(env.db, env.ctx), 0);
  assert.equal(env.db.prepare('SELECT classification FROM connection_email_messages WHERE id = ?')
    .get(answer.id).classification, 'customer_order_request');

  // And the conversation closes once its order exists: a later "thanks, got
  // them" on the same thread is not read as somebody ordering again.
  await orderFromEmail.draft(env.db, env.ctx, answer.id,
    reads([{ itemText: 'moc toe slip in', variantText: '36', quantity: 2 }]));
  const thanks = arriveOnThread(env, 'gmail-thread-5', 'Perfect, thanks.', 'Re: your order');
  env.db.prepare("UPDATE connection_email_messages SET classification = 'supplier_message' WHERE id = ?")
    .run(thanks.id);
  assert.equal(orderFromEmail.adoptThreadReplies(env.db, env.ctx), 0,
    'once the order exists the conversation is closed');
  env.db.close();
});

test('a question that has been sent is waiting on them, not on you', async () => {
  const env = setup();
  const first = arriveOnThread(env, 'gmail-thread-3', 'I want to order size 36 2 pieces');
  await orderFromEmail.draft(env.db, env.ctx, first.id,
    reads([{ itemText: '', variantText: 'size 36', quantity: 2 }]));
  assert.equal(orderFromEmail.unreadable(env.db, env.workspace.workspaceId).length, 1,
    'until it is sent, the owner has a decision');

  env.db.prepare('UPDATE connection_email_messages SET reply_sent_at = ? WHERE id = ?')
    .run(new Date().toISOString(), first.id);
  assert.deepEqual(orderFromEmail.unreadable(env.db, env.workspace.workspaceId), [],
    'once asked, the next move is theirs');
  assert.deepEqual(needsYou.inbox(env.db, env.workspace.workspaceId)
    .filter((entry) => entry.href === `/mail/${first.id}`), []);
  env.db.close();
});

test('when the answer makes the order, the email that started it stops asking', async () => {
  const env = setup();
  const first = arriveOnThread(env, 'gmail-thread-4', 'I want to order size 36 2 pieces');
  await orderFromEmail.draft(env.db, env.ctx, first.id,
    reads([{ itemText: '', variantText: 'size 36', quantity: 2 }]));
  const answer = arriveOnThread(env, 'gmail-thread-4', 'moc toe slip in 36 please', 'Re: your order');
  await orderFromEmail.draft(env.db, env.ctx, answer.id,
    reads([{ itemText: 'moc toe slip in', variantText: '36', quantity: 2 }]));

  assert.deepEqual(orderFromEmail.unreadable(env.db, env.workspace.workspaceId), [],
    'the order came out of the conversation, so the conversation is answered');
  env.db.close();
});

/* ---------------------------------------------------------------- the stock */

test('an order StockChief can fill only partly says so, before it ships', async () => {
  const env = setup();
  const messageId = arrive(env, 'I would like to order 20 moc toe lace size 36');
  const result = await orderFromEmail.draft(env.db, env.ctx, messageId,
    reads([{ itemText: 'moc toe lace', variantText: 'size 36', quantity: 20 }]));

  assert.ok(result.order, 'the order is still drafted — a shortfall is not a refusal');
  assert.equal(result.shortfall, true);

  const draft = env.db.prepare('SELECT draft_body, draft_source FROM connection_email_messages WHERE id = ?')
    .get(messageId);
  assert.equal(draft.draft_source, 'records');
  assert.match(draft.draft_body, /do not have the moc toe lace 36 in stock/i);
  assert.match(draft.draft_body, /not on order yet/,
    'and it does not invent a date nobody has committed to');
  env.db.close();
});

test('an order that can be filled gets no apology', () => {
  const env = setup();
  const workspaceId = env.workspace.workspaceId;
  // Put the stock on the shelf, then ask whether anything is short.
  const location = env.db.prepare('SELECT id FROM locations WHERE workspace_id = ? LIMIT 1').get(workspaceId);
  env.db.prepare(`INSERT INTO balances (workspace_id, sku_id, location_id, on_hand, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(workspaceId, env.lace.skuId, location.id, 50, new Date().toISOString());

  const short = orderReply.stockShortfall(env.db, workspaceId, [{ skuId: env.lace.skuId, quantity: 20 }]);
  assert.deepEqual(short, [], 'nothing to tell them about');
  env.db.close();
});

test('a draft somebody has already written is never overwritten', () => {
  const env = setup();
  const messageId = arrive(env, 'I want to order size 36 2 pieces');
  env.db.prepare(`UPDATE connection_email_messages SET draft_subject = 'Mine', draft_body = 'My own words',
    draft_source = 'person', draft_at = ? WHERE id = ?`).run(new Date().toISOString(), messageId);

  const written = orderReply.askWhichProduct(env.db, env.workspace.workspaceId, messageId,
    { subject: '' }, [{ asked: '2 × size 36', candidates: [] }]);
  assert.equal(written, null);
  assert.equal(env.db.prepare('SELECT draft_body FROM connection_email_messages WHERE id = ?')
    .get(messageId).draft_body, 'My own words');
  env.db.close();
});
