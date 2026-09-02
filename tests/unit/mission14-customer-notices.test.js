'use strict';

/*
 * Shipping notices.
 *
 * The claim under test is that this message contains nothing Foundry cannot
 * support. A shipping notice is read by somebody who is owed goods, so a
 * tracking number that does not resolve, or a delivery date nobody committed
 * to, is worse than sending nothing at all.
 *
 * The second claim is that writing a notice can never disturb the parcel it
 * describes: a box that physically left stays shipped no matter what happens
 * to the email about it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const notices = require('../../src/sales/customer-communications');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup(name = 'Riverside Supply') {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: name });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  return { db, workspace, item, ctx: workspace.ctx };
}

function orderFor(env, quantity, customerInput = {}) {
  const customer = sales.createCustomer(env.db, env.ctx, {
    name: 'ABC School', email: 'orders@abcschool.test', ...customerInput,
  });
  return {
    customer,
    order: sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
      customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity }],
    }).id),
  };
}

test('shipping a box writes the customer a notice made only of records', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 30 });
  const { order } = orderFor(env, 12);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {
    trackingNumber: '1Z999AA10123456784', service: 'Ground', expectedDeliveryDate: '2026-09-08',
  });

  const notice = shipped.customerNotice;
  assert.ok(notice, 'shipping should have written the notice');
  assert.equal(notice.status, 'PREPARED', 'writing is not sending');
  assert.equal(notice.recipient, 'orders@abcschool.test');
  assert.equal(notice.subject, `Your order ${order.order_number} has shipped`);

  const body = notice.body;
  assert.match(body, /Hello ABC School/);
  assert.match(body, /Black Small Shirt \(BLACK-S\): 12/);
  assert.match(body, /Carrier: UPS Ground/);
  assert.match(body, /Tracking number: 1Z999AA10123456784/);
  assert.match(body, /https:\/\/www\.ups\.com\/track\?tracknum=1Z999AA10123456784/);
  assert.match(body, /Expected delivery: 2026-09-08/);
  assert.match(body, /Riverside Supply/, 'the notice signs itself with the business name');
  assert.doesNotMatch(body, /have not shipped yet/, 'the whole order went, so nothing is outstanding');
});

test('a notice states nothing Foundry was not given', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const { order } = orderFor(env, 4);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});

  const body = shipped.customerNotice.body;
  assert.match(body, /is on its way/);
  assert.doesNotMatch(body, /Carrier:/, 'no carrier was given, so no carrier is claimed');
  assert.doesNotMatch(body, /Tracking/, 'no tracking number was given, so none is offered');
  assert.doesNotMatch(body, /Expected delivery/, 'nobody promised a date, so none is promised');
  assert.doesNotMatch(body, /undefined|null|NaN/);
});

test('a part shipment tells the customer what is still coming', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 30 });
  const { order } = orderFor(env, 18);
  const box = shipments.startPicking(env.db, env.ctx, order.id, {
    lines: [{ lineId: order.lines[0].id, locationId: env.workspace.main.id, quantity: 12 }],
  });
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});
  assert.match(shipped.customerNotice.body, /6 items on this order have not shipped yet/);

  const rest = shipments.startPicking(env.db, env.ctx, order.id);
  const second = shipments.ship(env.db, env.ctx, rest.id, {});
  assert.doesNotMatch(second.customerNotice.body, /have not shipped yet/);
  assert.equal(notices.forOrder(env.db, env.workspace.workspaceId, order.id).length, 2,
    'two boxes, two notices');
});

test('one box gets one notice, however many times it is shipped', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const { order } = orderFor(env, 3);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  shipments.ship(env.db, env.ctx, box.id, {});
  shipments.ship(env.db, env.ctx, box.id, {});
  assert.equal(notices.forShipment(env.db, env.workspace.workspaceId, box.id).length, 1);
});

test('a customer with no email still gets a notice written, and it says why it cannot go', async () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const { order } = orderFor(env, 2, { email: null });
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});

  assert.ok(shipped.customerNotice, 'the words are still worth having, to copy or read aloud');
  assert.equal(shipped.customerNotice.recipient, null);
  await assert.rejects(
    () => notices.sendThroughMailbox(env.db, env.workspace.workspaceId, shipped.customerNotice.id),
    /no email address for this customer/);
});

test('a workspace can switch notices off, and then none are written', () => {
  const env = setup();
  notices.setPolicy(env.db, env.ctx, { shippingNotice: 'off' });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const { order } = orderFor(env, 2);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});
  assert.equal(shipped.customerNotice, null);
  assert.equal(notices.forShipment(env.db, env.workspace.workspaceId, box.id).length, 0);
  assert.equal(shipped.status, 'SHIPPED', 'the box still went');
});

test('asking Foundry to send for you requires naming the mailbox it sends from', () => {
  const env = setup();
  assert.equal(notices.policy(env.db, env.workspace.workspaceId).shippingNotice, 'prepare',
    'the default writes the message and sends nothing');
  assert.throws(() => notices.setPolicy(env.db, env.ctx, { shippingNotice: 'send' }),
    /Choose which mailbox/);
  assert.throws(() => notices.setPolicy(env.db, env.ctx, { shippingNotice: 'shout' }),
    /writes shipping notices, sends them, or leaves them alone/);
});

test('a broken notice cannot unship a box that physically left', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const { order } = orderFor(env, 5);
  const box = shipments.startPicking(env.db, env.ctx, order.id);

  // Break the whole hook, at the boundary `ship` actually calls through.
  const original = notices.onShipped;
  notices.onShipped = () => { throw new Error('mail subsystem is on fire'); };
  try {
    const shipped = shipments.ship(env.db, env.ctx, box.id, {});
    assert.equal(shipped.status, 'SHIPPED');
    assert.equal(shipped.customerNotice, null, 'no notice, and no exception');
    assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 5,
      'the stock still left, because it really did');
  } finally {
    notices.onShipped = original;
  }
});

test('an owner can correct the words before they go, but not after', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const { order } = orderFor(env, 3);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});
  const id = shipped.customerNotice.id;

  const edited = notices.updateDraft(env.db, env.workspace.workspaceId, id, {
    body: 'Hi — your order is on the way, and I put a sample in the box.',
  });
  assert.match(edited.body, /sample in the box/);
  assert.throws(() => notices.updateDraft(env.db, env.workspace.workspaceId, id, { body: '   ' }),
    /needs something in it/);

  const cancelled = notices.cancel(env.db, env.workspace.workspaceId, id, 'I phoned them instead.');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.throws(() => notices.updateDraft(env.db, env.workspace.workspaceId, id, { body: 'again' }),
    /already been sent/);
});

test('the waiting list is what Foundry has written and not yet sent', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20 });
  const { order } = orderFor(env, 4);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});

  let queue = notices.waiting(env.db, env.workspace.workspaceId);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].customerName, 'ABC School');
  assert.equal(queue[0].orderNumber, order.order_number);
  assert.equal(queue[0].shipmentNumber, box.shipment_number);

  notices.cancel(env.db, env.workspace.workspaceId, shipped.customerNotice.id);
  assert.equal(notices.waiting(env.db, env.workspace.workspaceId).length, 0,
    'a cancelled message is not waiting for anybody');
});

test('one inventory never sees another inventory customer notices', () => {
  const first = setup('Riverside Supply');
  const second = setup('Delta Cleaning Co');

  for (const env of [first, second]) {
    inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
    const { order } = orderFor(env, 2);
    const box = shipments.startPicking(env.db, env.ctx, order.id);
    shipments.ship(env.db, env.ctx, box.id, {});
  }

  const mine = notices.waiting(first.db, first.workspace.workspaceId);
  assert.equal(mine.length, 1);
  assert.match(mine[0].body, /Riverside Supply/);
  assert.doesNotMatch(mine[0].body, /Delta Cleaning/);

  // And a message id from one inventory does not resolve in the other.
  assert.equal(notices.get(first.db, second.workspace.workspaceId, mine[0].id), null);
  assert.equal(notices.waiting(first.db, second.workspace.workspaceId).length, 0);
});

test('when the workspace says send, the customer receives exactly what the page showed', async () => {
  const env = setup();
  const connections = require('../../src/connections/service');
  const credentials = require('../../src/connections/credentials');
  const gmail = require('../../src/connections/providers/gmail');
  const modes = require('../../src/autopilot/modes');
  const authService = require('../../src/domain/auth-service');
  const membership = authService.getMembership(env.db, env.workspace.workspaceId, env.workspace.accountId);

  const created = connections.create(env.db, env.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(created.connection.id);
  credentials.put(env.db, env.workspace.workspaceId, created.connection.id, 'provider', {
    accessToken: 'test-token', refreshToken: 'test-refresh', mailbox: 'shop@riverside.test',
    expiresAt: Date.now() + 3_600_000,
  });
  modes.setMode(env.db, env.ctx, membership, modes.MODES.POLICY_AUTOMATED);
  notices.setPolicy(env.db, env.ctx, { shippingNotice: 'send', connectorId: created.connection.id });

  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const { order } = orderFor(env, 4);
  const box = shipments.startPicking(env.db, env.ctx, order.id);

  const originalSend = gmail.send;
  const outbox = [];
  gmail.send = async ({ message }) => { outbox.push(message); return { externalMessageId: 'gm-1' }; };
  try {
    const shipped = shipments.ship(env.db, env.ctx, box.id, { trackingNumber: '1Z999AA10123456784' });
    const outcome = await notices.autoSend(env.db, env.ctx, shipped.customerNotice);
    assert.equal(outcome.sent, true);
    assert.equal(outbox.length, 1, 'exactly one message reached the customer');
    assert.equal(outbox[0].recipient, 'orders@abcschool.test');
    assert.equal(outbox[0].subject, `Your order ${order.order_number} has shipped`);
    assert.match(outbox[0].body, /Tracking number: 1Z999AA10123456784/);

    const stored = notices.get(env.db, env.workspace.workspaceId, shipped.customerNotice.id);
    assert.equal(stored.status, 'SENT');
    assert.equal(stored.externalMessageId, 'gm-1');
    assert.equal(stored.body, outbox[0].body, 'what was recorded is what went');
    assert.equal(notices.waiting(env.db, env.workspace.workspaceId).length, 0);
  } finally { gmail.send = originalSend; }
});

test('a paused Foundry sends nothing to customers, and says why', async () => {
  const env = setup();
  const connections = require('../../src/connections/service');
  const modes = require('../../src/autopilot/modes');
  const authService = require('../../src/domain/auth-service');
  const membership = authService.getMembership(env.db, env.workspace.workspaceId, env.workspace.accountId);

  const created = connections.create(env.db, env.ctx, membership, {
    providerType: 'supplier_email', displayName: 'Shop Mailbox',
  });
  env.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(created.connection.id);
  notices.setPolicy(env.db, env.ctx, { shippingNotice: 'prepare', connectorId: created.connection.id });

  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10 });
  const { order } = orderFor(env, 2);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});

  modes.pause(env.db, env.ctx, membership, 'Testing the stop boundary.');
  await assert.rejects(
    () => notices.sendThroughMailbox(env.db, env.workspace.workspaceId, shipped.customerNotice.id),
    /paused/i);
  assert.notEqual(notices.get(env.db, env.workspace.workspaceId, shipped.customerNotice.id).status, 'SENT');
});
