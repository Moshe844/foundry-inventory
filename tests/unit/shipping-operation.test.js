'use strict';

/*
 * Shipping as an operation, not a status toggle.
 *
 * The claim under test is the whole sequence a person actually does: what is
 * in the box, what the carriers would charge, which one the owner's rule
 * allows, buying the label, and then knowing where the parcel is until it
 * arrives or something goes wrong.
 *
 * All of it against a fake carrier that answers the way a real one does. That
 * is the point of the seam: if anything above it had learned a carrier's
 * vocabulary, this file could not exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const shipping = require('../../src/shipping');
const shipments = require('../../src/sales/shipment-service');
const sales = require('../../src/sales/sales-order-service');
const inventory = require('../../src/domain/inventory-engine');
const prices = require('../../src/pricing/price-service');
const ledger = require('../../src/accounting/ledger');
const needsYou = require('../../src/manager/needs-you-inbox');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeCarrier, carrierEvent } = require('../helpers/fake-carrier');

test.after(cleanupAll);

const TRACKING = '1Z999AA10123456784';

function setup(options = {}) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'HalFi Shoes' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'moc toe slip in', baseCode: '7L665-3-36' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '80.00', currency: 'USD' });
  db.prepare('UPDATE skus SET weight_grams = 900 WHERE id = ?').run(item.skuId);
  db.prepare('UPDATE locations SET address = ? WHERE id = ?')
    .run('12 Depot Road, Monroe, NY 10950', workspace.main.id);
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40 });

  const customer = sales.createCustomer(db, workspace.ctx, {
    name: 'Moshe Ekstein', email: 'motty@example.test',
    shippingAddress: options.address === null ? null : (options.address || '13 Austra Pkwy, Monroe, NY 10950'),
  });
  const order = sales.confirm(db, workspace.ctx, sales.createOrder(db, workspace.ctx, {
    customerId: customer.id, neededBy: options.neededBy || '2026-09-14',
    lines: [{ skuId: item.skuId, quantity: 2 }],
  }).id);

  const box = shipments.startPicking(db, workspace.ctx, order.id, {});
  shipments.markPacked(db, workspace.ctx, box.id, {});
  return { db, workspace, ctx: workspace.ctx, membership, item, customer, order, box };
}

const withCarrier = (carrier) => {
  const undo = shipping.provider.register('easypost', carrier);
  process.env.EASYPOST_API_KEY = 'EZTK_test-key-not-a-real-one';
  return () => { undo(); delete process.env.EASYPOST_API_KEY; };
};

/* ------------------------------------------------------------ the parcel */

test('a parcel weighs what is in it, and says when that was worked out rather than measured', () => {
  const env = setup();
  const boxes = shipping.service.packagesFor(env.db, env.workspace.workspaceId, env.box.id);
  assert.equal(boxes.length, 1, 'one package unless somebody says otherwise');
  assert.equal(boxes[0].weightGrams, 1800, 'two pairs at 900g');
  assert.equal(boxes[0].estimated, true, 'and Foundry says it added that up rather than weighed it');

  shipping.service.setPackages(env.db, env.ctx, env.box.id, [{ weightGrams: 2100 }]);
  const measured = shipping.service.packagesFor(env.db, env.workspace.workspaceId, env.box.id);
  assert.equal(measured[0].weightGrams, 2100);
  assert.equal(measured[0].estimated, false, 'what somebody put on the scales wins');
  env.db.close();
});

test('a carrier is not asked anything until Foundry has what a carrier needs', async () => {
  const env = setup({ address: 'somewhere in town' });
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    const quoted = await shipping.service.quote(env.db, env.ctx, env.box.id);
    assert.equal(quoted.rates.length, 0);
    assert.equal(carrier.state.quoted, 0, 'no pointless call to the carrier');
    const why = quoted.blocked.map((problem) => problem.what).join(' ');
    assert.match(why, /missing the street/i);
    assert.match(why, /will not fill it in/i, 'and it does not invent where somebody lives');
  } finally { undo(); env.db.close(); }
});

/* ------------------------------------------------------------- the rates */

test('rates come back with prices and dates, and buying nothing has happened', async () => {
  const env = setup();
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    const quoted = await shipping.service.quote(env.db, env.ctx, env.box.id);
    assert.equal(quoted.rates.length, 3);
    assert.equal(quoted.promisedDate, '2026-09-14', 'what the customer was told');

    const usps = quoted.rates.find((rate) => rate.carrier === 'usps');
    assert.equal(usps.amountMinor, 1680);
    assert.equal(usps.deliveryDate, '2026-09-15');
    assert.equal(carrier.state.bought.length, 0, 'asking a price commits nobody');

    // Cheapest overall is USPS, but it misses the promised date.
    const advice = shipping.rules.recommend(quoted.rates, quoted.promisedDate);
    assert.equal(advice.rate.carrier, 'ups', 'cheapest that still keeps the promise');
    assert.match(advice.because, /arrives by 2026-09-14/);
  } finally { undo(); env.db.close(); }
});

/* -------------------------------------------------------------- the rule */

test('a rule buys within its limits, and asks the moment it is outside them', async () => {
  const env = setup();
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    const quoted = await shipping.service.quote(env.db, env.ctx, env.box.id);

    shipping.rules.save(env.db, env.ctx, {
      carrier: 'ups', service: 'Ground', maxCostMinor: 2500, requireByPromised: true,
      statedText: 'Use UPS Ground automatically if it arrives by the promised date and costs under $25.',
    });
    const covered = shipping.rules.decide(env.db, env.workspace.workspaceId, quoted.rates,
      { promisedDate: quoted.promisedDate });
    assert.equal(covered.rate.carrier, 'ups');
    assert.match(covered.because, /\$18\.42/);
    assert.match(covered.because, /promised 2026-09-14/);

    // The same parcel, promised a day earlier than any carrier can manage.
    const tight = shipping.rules.decide(env.db, env.workspace.workspaceId, quoted.rates,
      { promisedDate: '2026-09-10' });
    assert.equal(tight.rate, null, 'a rule cannot make a carrier arrive sooner than it said');
    assert.match(tight.because, /No rule covers this parcel/);
    assert.match(tight.because, /arriving 2026-09-14/, 'and it says what the carrier actually offered');
  } finally { undo(); env.db.close(); }
});

test('a rate with no delivery date never counts as arriving on time', () => {
  const env = setup();
  const rates = [{ id: 'r1', carrier: 'ups', carrierName: 'UPS', service: 'Ground',
    amountMinor: 900, currency: 'USD', deliveryDays: null, deliveryDate: null, guaranteed: false }];
  shipping.rules.save(env.db, env.ctx, { carrier: 'ups', maxCostMinor: 2500, requireByPromised: true });
  const decided = shipping.rules.decide(env.db, env.workspace.workspaceId, rates,
    { promisedDate: '2026-09-14' });
  assert.equal(decided.rate, null,
    'a carrier that declines to give a date is not a carrier promising one');
  env.db.close();
});

/* ------------------------------------------------------------- the label */

test('buying the label records postage but only physical handoff ships the order', async () => {
  const env = setup();
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    const quoted = await shipping.service.quote(env.db, env.ctx, env.box.id);
    const ups = quoted.rates.find((rate) => rate.carrier === 'ups');
    const bought = await shipping.service.buyLabel(env.db, env.ctx, env.box.id, ups.id);

    assert.equal(bought.trackingNumber, TRACKING);
    assert.equal(bought.label, 'https://carrier.test/labels/shp_fake.pdf');
    assert.deepEqual(carrier.state.bought, ['rate_ups'], 'the rate that was chosen is the rate that was bought');

    const row = env.db.prepare('SELECT * FROM sales_shipments WHERE id = ?').get(env.box.id);
    assert.equal(row.status, 'PACKED', 'a purchased label does not claim the parcel physically left');
    assert.equal(row.handover, null);
    assert.equal(row.tracking_number, TRACKING);
    assert.equal(row.tracking_url, 'https://carrier.test/track/1Z999AA10123456784',
      'the carrier\'s own link, not one Foundry assembled');
    assert.equal(Number(row.shipping_cost_minor), 1842);
    assert.equal(row.expected_delivery_date, '2026-09-14');

    // The stock stays put while the labelled parcel is still in the building.
    const left = env.db.prepare(`SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances
      WHERE workspace_id = ? AND sku_id = ?`).get(env.workspace.workspaceId, env.item.skuId).n;
    assert.equal(Number(left), 40);

    // And the postage is an expense, not part of what the stock cost.
    if (ledger.settings(env.db, env.workspace.workspaceId).enabled) {
      const posted = env.db.prepare(`SELECT COALESCE(SUM(l.debit_minor), 0) AS n
        FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id = l.account_id
        WHERE a.system_key = 'SHIPPING_EXPENSE' AND l.workspace_id = ?`)
        .get(env.workspace.workspaceId).n;
      assert.equal(Number(posted), 1842, 'postage reaches the books on its own');
    }

    // Buying twice buys once.
    const again = await shipping.service.buyLabel(env.db, env.ctx, env.box.id, ups.id);
    assert.equal(again.replayed, true);
    assert.equal(carrier.state.bought.length, 1);

    const handedOver = shipments.ship(env.db, env.ctx, env.box.id, { handover: 'CARRIER' });
    assert.equal(handedOver.status, 'SHIPPED');
    assert.equal(handedOver.handover, 'CARRIER');
    assert.equal(handedOver.tracking_number, TRACKING, 'the bought label details survive handoff');
    const afterHandoff = env.db.prepare(`SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances
      WHERE workspace_id = ? AND sku_id = ?`).get(env.workspace.workspaceId, env.item.skuId).n;
    assert.equal(Number(afterHandoff), 38, 'stock moves exactly when the parcel leaves');
  } finally { undo(); env.db.close(); }
});

/* ----------------------------------------------------------- the tracking */

test('the carrier says where the parcel is, and the order stops guessing', () => {
  const env = setup();
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    env.db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', tracking_number = ?,
      carrier = 'ups', provider = 'easypost', shipped_at = ? WHERE id = ?`)
      .run(TRACKING, '2026-09-11T10:00:00.000Z', env.box.id);

    const moving = shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({
      id: 'evt_1', status: 'IN_TRANSIT', detail: 'Departed facility',
      events: [{ object_id: 'scan_1', status: 'IN_TRANSIT', datetime: '2026-09-11T18:00:00Z',
        message: 'Departed facility', location: 'Newark, NJ' }],
    }));
    assert.equal(moving.applied, true);
    assert.match(moving.outcome, /in transit/);

    // The same scan twice is one scan.
    const again = shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({
      id: 'evt_1', status: 'IN_TRANSIT',
      events: [{ object_id: 'scan_1', status: 'IN_TRANSIT', datetime: '2026-09-11T18:00:00Z' }],
    }));
    assert.equal(again.replayed, true);
    assert.equal(shipping.tracking.eventsFor(env.db, env.workspace.workspaceId, env.box.id).length, 1);

    // Delivered closes the shipment, because that is a business fact.
    shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({
      id: 'evt_2', status: 'DELIVERED',
      events: [{ object_id: 'scan_2', status: 'DELIVERED', datetime: '2026-09-14T15:20:00Z',
        message: 'Left with resident' }],
    }));
    const row = env.db.prepare('SELECT * FROM sales_shipments WHERE id = ?').get(env.box.id);
    assert.equal(row.tracking_status, 'DELIVERED');
    assert.equal(row.status, 'DELIVERED', 'the shipment itself is closed, not just labelled');
    assert.ok(row.delivered_at);
  } finally { undo(); env.db.close(); }
});

test('a late depot scan does not un-deliver a parcel the customer already has', () => {
  const env = setup();
  const undo = withCarrier(fakeCarrier());
  try {
    env.db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', tracking_number = ?,
      provider = 'easypost' WHERE id = ?`).run(TRACKING, env.box.id);
    shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({
      id: 'evt_d', status: 'DELIVERED',
      events: [{ object_id: 's1', status: 'DELIVERED', datetime: '2026-09-14T15:20:00Z' }],
    }));
    shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({
      id: 'evt_late', status: 'IN_TRANSIT',
      events: [{ object_id: 's2', status: 'IN_TRANSIT', datetime: '2026-09-13T09:00:00Z' }],
    }));
    assert.equal(env.db.prepare('SELECT tracking_status FROM sales_shipments WHERE id = ?')
      .get(env.box.id).tracking_status, 'DELIVERED');
    env.db.close();
  } finally { undo(); }
});

test('a parcel that went wrong reaches a person, with what the carrier said', () => {
  const env = setup();
  const undo = withCarrier(fakeCarrier());
  try {
    env.db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', tracking_number = ?,
      provider = 'easypost', expected_delivery_date = '2026-09-14' WHERE id = ?`)
      .run(TRACKING, env.box.id);
    shipping.tracking.receiveEvent(env.db, env.ctx, 'easypost', carrierEvent({
      id: 'evt_x', status: 'RETURNED', detail: 'Refused by recipient',
      events: [{ object_id: 's9', status: 'RETURNED', datetime: '2026-09-15T09:00:00Z',
        message: 'Refused by recipient' }],
    }));

    const trouble = needsYou.fromLateShipments(env.db, env.workspace.workspaceId);
    assert.equal(trouble.length, 1);
    assert.match(trouble[0].title, /did not reach Moshe Ekstein/);
    assert.match(trouble[0].happened, /Refused by recipient/);
    assert.equal(trouble[0].href, `/fulfilment/${env.box.id}`);
    env.db.close();
  } finally { undo(); }
});

test('polling is the fallback, and it only asks about parcels that have gone quiet', async () => {
  const env = setup();
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    env.db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', tracking_number = ?,
      provider = 'easypost', tracked_at = ? WHERE id = ?`)
      .run(TRACKING, new Date().toISOString(), env.box.id);
    const quiet = await shipping.tracking.sweep(env.db, env.ctx, {});
    assert.equal(quiet.checked, 0, 'a parcel that reported a minute ago is not asked about again');

    env.db.prepare('UPDATE sales_shipments SET tracked_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', env.box.id);
    carrier.state.trackers.set(TRACKING, { status: 'OUT_FOR_DELIVERY', detail: 'On the van',
      events: [{ externalEventId: 'poll_1', status: 'OUT_FOR_DELIVERY',
        occurredAt: '2026-09-14T08:00:00Z' }] });
    const swept = await shipping.tracking.sweep(env.db, env.ctx, {});
    assert.equal(swept.checked, 1);
    assert.equal(swept.updated, 1);
    assert.equal(env.db.prepare('SELECT tracking_status FROM sales_shipments WHERE id = ?')
      .get(env.box.id).tracking_status, 'OUT_FOR_DELIVERY');
  } finally { undo(); env.db.close(); }
});

/* ------------------------------------------------- a number somebody has */

test('"track this number" attaches it to a parcel, and refuses to invent one', async () => {
  const env = setup();
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    const nowhere = await shipping.tracking.trackNumber(env.db, env.ctx, TRACKING);
    assert.equal(nowhere.tracked, false);
    assert.match(nowhere.because, /no shipment with that tracking number/i);
    assert.match(nowhere.because, /goods and a customer rather than to nothing/);

    carrier.state.trackers.set(TRACKING, { status: 'IN_TRANSIT', events: [] });
    const attached = await shipping.tracking.trackNumber(env.db, env.ctx, TRACKING,
      { shipmentId: env.box.id });
    assert.equal(attached.tracked, true);
    assert.equal(attached.live, true);
    const row = env.db.prepare('SELECT tracking_number, carrier, tracking_url FROM sales_shipments WHERE id = ?')
      .get(env.box.id);
    assert.equal(row.tracking_number, TRACKING);
    assert.equal(row.carrier, 'ups', 'the carrier is read off the number itself');
    assert.match(row.tracking_url, /ups\.com/);
  } finally { undo(); env.db.close(); }
});

/* --------------------------------------------------- doing it unasked */

test('within authority Foundry buys the label itself, and outside it does nothing but say why', async () => {
  /*
   * Three permissions, all of which have to hold: the mode has to let Foundry
   * act, the owner has to have granted buying labels specifically, and a rule
   * has to cover this parcel at this price by this date. Each is asserted
   * separately, because "it did not ship" is only useful next to which one
   * stopped it.
   */
  const modes = require('../../src/autopilot/modes');
  const capabilities = require('../../src/autopilot/capabilities');

  const env = setup();
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    shipping.rules.save(env.db, env.ctx, {
      carrier: 'ups', service: 'Ground', maxCostMinor: 2500, requireByPromised: true,
    });

    // Nothing granted yet: a rule on its own is not permission to spend.
    const watching = await shipping.service.shipWithinAuthority(env.db, env.ctx, env.box.id);
    assert.equal(watching.bought, false);
    assert.match(watching.because, /watch only|ask before acting|authorised/i);
    assert.equal(carrier.state.bought.length, 0);

    modes.setMode(env.db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);

    // The mode alone is not enough either.
    const unGranted = await shipping.service.shipWithinAuthority(env.db, env.ctx, env.box.id);
    assert.equal(unGranted.bought, false);
    assert.match(unGranted.because, /Nobody has authorised/);
    assert.equal(carrier.state.bought.length, 0);

    capabilities.set(env.db, env.ctx, env.membership, 'shipping_labels', true);
    const done = await shipping.service.shipWithinAuthority(env.db, env.ctx, env.box.id);
    assert.equal(done.bought, true);
    assert.equal(done.carrier, 'ups');
    assert.match(done.because, /\$18\.42/);
    assert.equal(env.db.prepare('SELECT status FROM sales_shipments WHERE id = ?')
      .get(env.box.id).status, 'PACKED', 'automation may buy postage, but cannot invent a physical handoff');
    assert.equal(env.db.prepare('SELECT bought_by_rule_id FROM sales_shipments WHERE id = ?')
      .get(env.box.id).bought_by_rule_id, done.rule.id, 'the rule that spent the money is named');
  } finally { undo(); env.db.close(); }
});

test('a parcel no rule covers is left alone, with the reason, and nothing is spent', async () => {
  const modes = require('../../src/autopilot/modes');
  const capabilities = require('../../src/autopilot/capabilities');

  const env = setup({ neededBy: '2026-09-10' });
  const carrier = fakeCarrier();
  const undo = withCarrier(carrier);
  try {
    shipping.rules.save(env.db, env.ctx, { carrier: 'ups', service: 'Ground',
      maxCostMinor: 2500, requireByPromised: true });
    modes.setMode(env.db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
    capabilities.set(env.db, env.ctx, env.membership, 'shipping_labels', true);

    const swept = await shipping.service.sweep(env.db, env.ctx, {});
    assert.equal(swept.considered, 1);
    assert.equal(swept.bought, 0, 'nothing arrives by the promised date, so nothing is bought');
    assert.match(swept.results[0].because, /No rule covers this parcel/);
    assert.equal(carrier.state.bought.length, 0);
    assert.equal(env.db.prepare('SELECT status FROM sales_shipments WHERE id = ?')
      .get(env.box.id).status, 'PACKED', 'the parcel waits for a person');
  } finally { undo(); env.db.close(); }
});
