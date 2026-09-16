'use strict';

/*
 * The three things that were missing, and are not now.
 *
 * A rule said in a sentence rather than filled into a form; a second carrier
 * provider behind the same seam; and the message a late customer is owed,
 * written before anybody asks for it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const shipping = require('../../src/shipping');
const intent = require('../../src/shipping/rule-intent');
const shipments = require('../../src/sales/shipment-service');
const sales = require('../../src/sales/sales-order-service');
const inventory = require('../../src/domain/inventory-engine');
const prices = require('../../src/pricing/price-service');
const needsYou = require('../../src/manager/needs-you-inbox');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

const TRACKING = '1Z999AA10123456784';

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'HalFi Shoes' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'moc toe slip in', baseCode: '7L665-3-36' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '80.00', currency: 'USD' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40 });
  const customer = sales.createCustomer(db, workspace.ctx, {
    name: 'Moshe Ekstein', email: 'motty@example.test',
    shippingAddress: '13 Austra Pkwy, Monroe, NY 10950',
  });
  const order = sales.confirm(db, workspace.ctx, sales.createOrder(db, workspace.ctx, {
    customerId: customer.id, neededBy: '2026-09-14',
    lines: [{ skuId: item.skuId, quantity: 2 }],
  }).id);
  const box = shipments.startPicking(db, workspace.ctx, order.id, {});
  shipments.markPacked(db, workspace.ctx, box.id, {});
  return { db, workspace, ctx: workspace.ctx, membership, item, customer, order, box };
}

/* ------------------------------------------------ a rule, said out loud */

test('a shipping rule typed as a sentence becomes the same rule the form makes', () => {
  const env = setup();
  const said = intent.applySentence(env.db, env.ctx,
    'Use UPS Ground automatically if it arrives by the promised date and costs under $25. Ask me otherwise.');

  assert.equal(said.understood, true);
  assert.equal(said.saved.carrier, 'ups');
  assert.equal(said.saved.service, 'Ground');
  assert.equal(said.saved.maxCostMinor, 2500);
  assert.equal(said.saved.requireByPromised, true);
  assert.ok(said.saved.statedText.startsWith('Use UPS Ground'),
    'their own words are kept, so they can see StockChief understood them');

  const rates = [
    { id: 'a', carrier: 'ups', carrierName: 'UPS', service: 'Ground', amountMinor: 1842,
      currency: 'USD', deliveryDays: 3, deliveryDate: '2026-09-14', guaranteed: false },
  ];
  assert.equal(shipping.rules.decide(env.db, env.workspace.workspaceId, rates,
    { promisedDate: '2026-09-14' }).rate.id, 'a',
  'and it decides parcels exactly as a rule made in the form does');
  env.db.close();
});

test('a sentence with no limit is refused, because that is permission to spend anything', () => {
  const env = setup();
  const said = intent.applySentence(env.db, env.ctx, 'Always use UPS');
  assert.equal(said.understood, false);
  assert.equal(said.needs, 'a limit');
  assert.match(said.because, /permission to spend anything on postage/);
  assert.equal(shipping.rules.list(env.db, env.workspace.workspaceId).length, 0,
    'and nothing half-understood is written down');
  env.db.close();
});

test('"within 3 days" is a deadline, never a three-dollar limit', () => {
  /*
   * The first version of the reader matched "within 3" as money, because
   * "within" introduces both a budget and a duration and a bare number looks
   * the same either way. It would have refused every rate over $3 and looked,
   * to the owner, like the carriers had stopped quoting.
   */
  const said = intent.read('Use USPS Priority Mail if it arrives within 3 days and costs under $15');
  assert.equal(said.understood, true);
  assert.equal(said.rule.maxCostMinor, 1500);
  assert.equal(said.rule.maxDeliveryDays, 3);
  assert.equal(intent.moneyIn('arrives within 3 days'), null, 'a duration is not a budget');
  assert.equal(intent.moneyIn('under 25 dollars'), 2500, 'and the word counts as well as the symbol');
});

test('a one-off instruction is not quietly turned into a standing rule', () => {
  assert.equal(intent.read('Ship this order today').understood, false);
  assert.equal(intent.read('Reorder the black shoes when we get to 12').understood, false);
});

/* ----------------------------------------------------- a second provider */

test('Shippo answers the same five questions, in StockChief vocabulary', () => {
  /*
   * The only real test of whether the seam is an abstraction rather than a
   * wish: a provider that names almost nothing the way the first one does,
   * driven by exactly the same code above it.
   */
  const shippo = require('../../src/shipping/providers/shippo');
  for (const method of shipping.provider.REQUIRED) {
    assert.equal(typeof shippo[method], 'function', `Shippo must implement ${method}`);
  }
  assert.ok(shipping.provider.names().includes('shippo'));

  const rate = shippo.readRate({ object_id: 'rate_1', provider: 'UPS',
    servicelevel: { name: 'Ground' }, amount: '18.42', currency: 'USD', estimated_days: 3 });
  assert.equal(rate.carrier, 'ups');
  assert.equal(rate.amountMinor, 1842, 'dollars as a string become minor units');
  assert.equal(rate.deliveryDays, 3);
  assert.match(rate.deliveryDate, /^\d{4}-\d{2}-\d{2}$/,
    'days become a date, so a rule comparing dates never learns that one provider counts');

  assert.equal(shippo.statusOf('TRANSIT'), 'IN_TRANSIT');
  assert.equal(shippo.statusOf('DELIVERED'), 'DELIVERED');
  assert.equal(shippo.statusOf('something new'), 'UNKNOWN', 'never guessed at');

  const read = shippo.readEvent({ event: 'track_updated', data: {
    object_id: 'trk_1', tracking_number: TRACKING, carrier: 'ups',
    tracking_status: { status: 'TRANSIT', status_details: 'Departed' },
    tracking_history: [{ object_id: 'h1', status: 'TRANSIT', status_date: '2026-09-11T18:00:00Z' }],
  } });
  assert.equal(read.status, 'IN_TRANSIT');
  assert.equal(read.trackingNumber, TRACKING);
  assert.equal(read.events.length, 1);
});

/* ------------------------------------------------------- the late notice */

test('a late parcel has the message already written, and unsent', () => {
  const env = setup();
  env.db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', tracking_number = ?,
    carrier = 'ups', provider = 'easypost', expected_delivery_date = '2026-09-01',
    tracking_status = 'IN_TRANSIT' WHERE id = ?`).run(TRACKING, env.box.id);
  env.db.prepare(`INSERT INTO shipment_tracking_events
    (id, workspace_id, shipment_id, provider, external_event_id, status, detail, location,
     occurred_at, created_at)
    VALUES ('t1', ?, ?, 'easypost', 'e1', 'IN_TRANSIT', 'Departed facility', 'Newark, NJ',
      '2026-09-12T10:00:00Z', '2026-09-12T10:00:00Z')`)
    .run(env.workspace.workspaceId, env.box.id);

  const prepared = shipping.delayNotice.prepareAll(env.db, env.ctx);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].prepared, true);

  const message = prepared[0].message;
  assert.equal(message.status, 'PREPARED', 'written, not sent');
  assert.match(message.subject, /running late/);
  assert.match(message.body, /SO-1001/);
  assert.match(message.body, /due 2026-09-01/);
  assert.match(message.body, /last scanned in Newark, NJ/);
  assert.match(message.body, /has not given a new date/);
  assert.ok(!/sorry|apolog/i.test(message.body),
    'it does not apologise on the owner behalf — that is their decision to make');

  // Written once, however long the parcel stays late.
  shipping.delayNotice.prepareAll(env.db, env.ctx);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM customer_communications
    WHERE workspace_id = ? AND message_kind LIKE 'delay_notice_%'`)
    .get(env.workspace.workspaceId).n, 1);

  // And Needs You says the words exist rather than asking for them.
  const card = needsYou.fromLateShipments(env.db, env.workspace.workspaceId)[0];
  assert.match(card.recommendation, /StockChief has written/);
  assert.equal(card.actionLabel, 'Read what StockChief wrote');
  env.db.close();
});

test('a returned parcel is a different conversation, and gets its own message', () => {
  const env = setup();
  env.db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', tracking_number = ?,
    carrier = 'ups', provider = 'easypost', tracking_status = 'RETURNED',
    exception_reason = 'Refused by recipient' WHERE id = ?`).run(TRACKING, env.box.id);

  const written = shipping.delayNotice.compose(env.db, env.workspace.workspaceId, env.box.id);
  assert.equal(written.kind, 'returned');
  assert.match(written.subject, /coming back to us/);
  assert.match(written.body, /on its way back to us/);
  assert.match(written.body, /you have not been charged twice/);
  assert.ok(!/due /.test(written.body), 'a returned parcel is not a late one');
  env.db.close();
});

test('a customer with no email address is reported, not written to nowhere', () => {
  const env = setup();
  env.db.prepare('UPDATE customers SET email = NULL WHERE id = ?').run(env.customer.id);
  env.db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', tracking_number = ?,
    provider = 'easypost', expected_delivery_date = '2026-09-01',
    tracking_status = 'IN_TRANSIT' WHERE id = ?`).run(TRACKING, env.box.id);

  const prepared = shipping.delayNotice.prepare(env.db, env.ctx, env.box.id);
  assert.equal(prepared.prepared, false);
  assert.match(prepared.because, /no email address/);
  env.db.close();
});
