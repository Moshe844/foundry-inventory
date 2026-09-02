'use strict';

/*
 * The forward half of the Home briefing.
 *
 * The claim is that these lines are counted from records and name dates
 * somebody gave, never dates Foundry worked out. An employee who says "expected
 * Thursday" is repeating what the supplier told them; a system that guesses it
 * has invented a promise the owner will be held to.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const whatsNext = require('../../src/attention/whats-next');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

const NOW = new Date('2026-09-02T09:00:00.000Z');
const inDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  return { db, workspace, ctx: workspace.ctx, item };
}

const build = (env) => whatsNext.build(env.db, env.workspace.workspaceId, { now: NOW.getTime() });

test('a quiet inventory has nothing to report, and says nothing', () => {
  const env = setup();
  assert.deepEqual(build(env), [], 'no lines invented to fill the space');
});

test('the briefing counts what is packed and what is ready to pick', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School' });

  const first = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 5 }],
  }).id);
  sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 3 }],
  }).id);

  let lines = build(env).map((line) => line.text);
  assert.ok(lines.some((text) => text === '2 orders are ready to pick.'), lines.join(' | '));

  const box = shipments.startPicking(env.db, env.ctx, first.id);
  shipments.markPacked(env.db, env.ctx, box.id, {});
  lines = build(env).map((line) => line.text);
  assert.ok(lines.some((text) => text === '1 shipment is packed and waiting for a carrier.'), lines.join(' | '));
  assert.ok(lines.some((text) => text === '1 order is ready to pick.'),
    'the order now in a box is no longer waiting for one');
});

test('a date the customer gave is said as a day; a date nobody gave is not said at all', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20 });
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School' });

  sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, neededBy: inDays(2), lines: [{ skuId: env.item.skuId, quantity: 4 }],
  }).id);
  const lines = build(env).map((line) => line.text);
  assert.ok(lines.some((text) => /ABC School wants SO-\d+ Friday\./.test(text)), lines.join(' | '));

  // A second workspace, same order, no date: no line claims one.
  const quiet = setup();
  inventory.receive(quiet.db, quiet.ctx, { skuId: quiet.item.skuId, locationId: quiet.workspace.main.id, quantity: 20 });
  const other = sales.createCustomer(quiet.db, quiet.ctx, { name: 'Delta Cleaning' });
  sales.confirm(quiet.db, quiet.ctx, sales.createOrder(quiet.db, quiet.ctx, {
    customerId: other.id, lines: [{ skuId: quiet.item.skuId, quantity: 4 }],
  }).id);
  assert.ok(!build(quiet).some((line) => /wants/.test(line.text)),
    'nobody said when they wanted it, so nothing says when they wanted it');
});

test('a date already past is reported as past, not as a day of the week', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20 });
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School' });
  sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, neededBy: inDays(-3), lines: [{ skuId: env.item.skuId, quantity: 4 }],
  }).id);

  const late = build(env).find((line) => line.tone === 'late');
  assert.ok(late, 'an overdue order is marked late');
  assert.match(late.text, /was wanted by 2026-08-30/);
});

test('dates far out keep their date, because a weekday three weeks away is a different one', () => {
  const today = new Date('2026-09-02T00:00:00.000Z');
  assert.equal(whatsNext.when('2026-09-02', today).text, 'today');
  assert.equal(whatsNext.when('2026-09-03', today).text, 'tomorrow');
  assert.equal(whatsNext.when('2026-09-04', today).text, 'Friday');
  assert.equal(whatsNext.when('2026-09-08', today).text, 'Tuesday');
  assert.equal(whatsNext.when('2026-09-24', today).text, 'on 2026-09-24');
  assert.equal(whatsNext.when('2026-08-28', today).text, 'overdue');
  assert.equal(whatsNext.when(null, today), null);
});

test('the briefing stays short however much is going on', () => {
  const env = setup();
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 400 });
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School' });
  for (let n = 0; n < 12; n += 1) {
    const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
      customerId: customer.id, neededBy: inDays(1), lines: [{ skuId: env.item.skuId, quantity: 2 }],
    }).id);
    if (n % 2 === 0) {
      const box = shipments.startPicking(env.db, env.ctx, order.id);
      shipments.markPacked(env.db, env.ctx, box.id, {});
    }
  }
  const lines = build(env);
  assert.ok(lines.length <= 4, `a briefing is not a report: ${lines.length} lines`);
  for (const line of lines) assert.ok(line.href && line.text, 'every line goes somewhere');
});
