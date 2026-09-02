'use strict';

/*
 * Replies Foundry drafts.
 *
 * This is the first place a model writes words addressed to somebody outside
 * the business, so the tests are about what it is not allowed to say. A draft
 * that invents a figure, names a date nobody committed to, claims work was
 * done, or promises a refund is thrown away — and the owner is told which of
 * those it was, because "Foundry wrote something and binned it" is only
 * trustworthy if it says what was wrong.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const drafting = require('../../src/connections/reply-drafting');
const inbox = require('../../src/connections/reply-inbox');
const connections = require('../../src/connections/service');
const ingestion = require('../../src/connections/email-ingestion');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const prices = require('../../src/pricing/price-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

let sequence = 0;

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  const created = connections.create(db, workspace.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  return { db, workspace, ctx: workspace.ctx, item, connectorId: created.connection.id };
}

function arrive(env, { sender = 'orders@abcschool.test', subject = 'Our order', body = 'Where is it?' } = {}) {
  sequence += 1;
  return ingestion.capture(env.db,
    { workspaceId: env.workspace.workspaceId, connectorId: env.connectorId },
    { occurredAt: '2026-09-01T09:00:00.000Z',
      data: { messageId: `d-${sequence}`, sender, subject, bodyText: body } }).actionRecordId;
}

/** A shipped order for a customer whose email the message will come from. */
function shippedOrderFor(env) {
  const customer = sales.createCustomer(env.db, env.ctx, {
    name: 'ABC School', email: 'orders@abcschool.test',
  });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 30 });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 12 }],
  }).id);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  shipments.ship(env.db, env.ctx, box.id, {
    trackingNumber: '1Z999AA10123456784', service: 'Ground', expectedDeliveryDate: '2026-09-08',
  });
  return { customer, order };
}

const provider = (data) => ({ complete: async () => ({ data }) });

test('the facts handed to the model are records, not prose', () => {
  const env = setup();
  const { order } = shippedOrderFor(env);
  const id = arrive(env);
  const message = env.db.prepare('SELECT * FROM connection_email_messages WHERE id = ?').get(id);

  const facts = drafting.factsFor(env.db, env.workspace.workspaceId, message);
  const joined = facts.join('\n');
  assert.match(joined, /They are a customer of ours: ABC School/);
  assert.match(joined, new RegExp(`Order ${order.order_number}`));
  assert.match(joined, /12 ordered, 12 shipped/);
  assert.match(joined, /tracking number 1Z999AA10123456784/);
  assert.match(joined, /expected 2026-09-08/);
});

test('a stranger gets facts that say Foundry knows nothing about them', () => {
  const env = setup();
  const id = arrive(env, { sender: 'someone@nowhere.test' });
  const message = env.db.prepare('SELECT * FROM connection_email_messages WHERE id = ?').get(id);
  const facts = drafting.factsFor(env.db, env.workspace.workspaceId, message);
  assert.equal(facts.length, 1);
  assert.match(facts[0], /does not recognise this sender/);
});

test('a draft that invents a figure is refused, and the reason names the fault', async () => {
  const env = setup();
  shippedOrderFor(env);
  const id = arrive(env);

  const result = await drafting.draft(env.db, env.ctx, id, {
    provider: provider({ subject: 'Re: Our order', body: 'Your 40 shirts went out last week.' }),
  });
  assert.equal(result.source, 'facts', 'the invented draft was thrown away');
  assert.equal(result.rejected, 'it used a figure that is not in your records');
  assert.doesNotMatch(result.body, /40 shirts/);
});

test('a draft that names a date nobody committed to is refused', async () => {
  const env = setup();
  shippedOrderFor(env);
  const id = arrive(env);

  const result = await drafting.draft(env.db, env.ctx, id, {
    provider: provider({ subject: 'Re: Our order', body: 'It will be with you on Thursday.' }),
  });
  assert.equal(result.rejected, 'it named a date nobody has committed to');
  assert.equal(result.source, 'facts');
});

test('a draft that claims work was done, or promises a refund, is refused', async () => {
  const env = setup();
  shippedOrderFor(env);

  const claimed = await drafting.draft(env.db, env.ctx, arrive(env), {
    provider: provider({ subject: 'Re', body: 'We have transferred the stock across for you.' }),
  });
  assert.equal(claimed.rejected, 'it claimed something had been done that Foundry cannot show was done');

  const promised = await drafting.draft(env.db, env.ctx, arrive(env), {
    provider: provider({ subject: 'Re', body: 'We will send a full refund and guarantee it arrives.' }),
  });
  assert.equal(promised.rejected, 'it promised something your records do not support');
});

test('a grounded draft is kept, and may quote figures the sender used themselves', async () => {
  const env = setup();
  shippedOrderFor(env);
  const id = arrive(env, { body: 'We ordered 12 shirts. Where are they?' });

  const result = await drafting.draft(env.db, env.ctx, id, {
    provider: provider({
      subject: 'Re: Our order',
      body: 'All 12 went out with tracking number 1Z999AA10123456784. It is expected 2026-09-08.',
    }),
  });
  assert.equal(result.rejected, null);
  assert.equal(result.source, 'model');
  assert.match(result.body, /1Z999AA10123456784/);

  const stored = drafting.getDraft(env.db, env.workspace.workspaceId, id);
  assert.equal(stored.body, result.body);
  assert.equal(stored.source, 'model');
});

test('with no model at all, the facts alone still make a usable reply', async () => {
  const env = setup();
  shippedOrderFor(env);
  const id = arrive(env);

  const result = await drafting.draft(env.db, env.ctx, id, { deterministicOnly: true });
  assert.equal(result.source, 'facts');
  assert.equal(result.rejected, null, 'nothing was rejected, because nothing was drafted');
  assert.match(result.subject, /^Re: /);
  assert.match(result.body, /Here is what we have on record/);
  assert.match(result.body, /1Z999AA10123456784/);
});

test('an owner can rewrite the draft, and rewriting clears the machine authorship', async () => {
  const env = setup();
  shippedOrderFor(env);
  const id = arrive(env);
  await drafting.draft(env.db, env.ctx, id, { deterministicOnly: true });

  const saved = drafting.saveDraft(env.db, env.ctx, id, {
    subject: 'Re: Our order', body: 'Hi Jo — it went out Monday, tracking is on its way to you separately.',
  });
  assert.equal(saved.source, 'person');
  assert.match(saved.body, /went out Monday/,
    'a person may write what they like; the guard is on what Foundry writes');
  assert.throws(() => drafting.saveDraft(env.db, env.ctx, id, { body: '   ' }), /needs something in it/);
});

test('dates are only allowed if the records or the sender named them', () => {
  const message = { subject: 'Our order', body_text: 'Can you get it here by Friday?' };
  const facts = ['Shipment SHP-1001 left on 2026-09-01.'];
  assert.equal(drafting.datesAreGrounded('We will aim for Friday.', message, facts), true,
    'they named Friday themselves');
  assert.equal(drafting.datesAreGrounded('It should arrive Thursday.', message, facts), false);
  assert.equal(drafting.datesAreGrounded('It left on 2026-09-01.', message, facts), true);
  assert.equal(drafting.datesAreGrounded('We will send it tomorrow.', message, facts), false);
});

test('sending a reply marks the conversation as waiting on them', async () => {
  const env = setup();
  shippedOrderFor(env);
  const id = arrive(env);
  await drafting.draft(env.db, env.ctx, id, { deterministicOnly: true });
  assert.equal(inbox.get(env.db, env.workspace.workspaceId, id).reply_state, 'NEEDS_REPLY');

  const providerService = require('../../src/connections/provider-service');
  const original = providerService.sendMailboxMessage;
  const outbox = [];
  providerService.sendMailboxMessage = async (db, workspaceId, connectorId, message) => {
    outbox.push(message);
    return { externalMessageId: 'sent-1' };
  };
  try {
    await drafting.send(env.db, env.ctx, id);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].recipient, 'orders@abcschool.test');
    assert.match(outbox[0].body, /Here is what we have on record/);

    const after = inbox.get(env.db, env.workspace.workspaceId, id);
    assert.equal(after.reply_state, 'WAITING');
    assert.match(after.reply_reason, /ball is with them/);

    // Sending twice sends once.
    await drafting.send(env.db, env.ctx, id);
    assert.equal(outbox.length, 1);
  } finally { providerService.sendMailboxMessage = original; }
});
