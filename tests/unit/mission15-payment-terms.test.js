'use strict';

/*
 * Payment terms, and the holds they put on an order.
 *
 * Foundry could always record that money arrived. What it could not do was know
 * money was supposed to arrive first — so an order with nothing paid on it
 * shipped exactly like one paid in full. These tests are about the difference.
 *
 * The claims: a hold refuses in words and names the amount; a deposit releases
 * picking but not necessarily shipping; the owner can let one order past and it
 * is recorded; and no figure here is invented — paid and remaining come from
 * the invoice the accounting engine maintains.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const terms = require('../../src/sales/payment-terms');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const receivables = require('../../src/accounting/receivables');
const payments = require('../../src/accounting/payments');
const prices = require('../../src/pricing/price-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '15.00', currency: 'USD' });
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  return { db, workspace, ctx: workspace.ctx, membership, item };
}

/** An order for $1,500: 100 shirts at $15, invoiced and open. */
function orderWorth1500(env) {
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'ABC School', email: 'orders@abcschool.test' });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 200 });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 100 }],
  }).id);
  const { invoice } = receivables.createDraft(env.db, env.ctx, env.membership, {
    customerId: customer.id, salesOrderId: order.id, issueDate: '2026-09-02', dueDate: '2026-10-02',
    lines: [{ description: '100 Black Small Shirt', quantity: 100, unitPriceMinor: 1500 }],
  });
  receivables.open(env.db, env.ctx, env.membership, invoice.id);
  return { customer, order, invoiceId: invoice.id };
}

/*
 * A receipt allocated to the invoice.
 *
 * The allocation is the point: an unallocated receipt is a customer deposit
 * sitting on account, which is a real thing and not the same as an invoice
 * being paid. The engine already knew that; this helper has to say which it
 * means.
 */
const pay = (env, customer, invoiceId, minor, key) => payments.record(env.db, env.ctx, env.membership, {
  direction: 'CUSTOMER_RECEIPT', customerId: customer.id,
  paymentDate: '2026-09-03', amountMinor: minor, method: 'card', sourceKey: key,
  allocations: [{ invoiceId, amountMinor: minor }],
});

const position = (env, order) => terms.positionForOrder(env.db, env.workspace.workspaceId,
  env.db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(order.id));

test('with nothing agreed, nothing is held', () => {
  const env = setup();
  const { order } = orderWorth1500(env);
  const p = position(env, order);
  assert.equal(p.terms.kind, 'ON_ACCOUNT');
  assert.equal(p.blocksPicking, false);
  assert.equal(p.blocksShipping, false);
  assert.equal(p.totalMinor, 150000);
  assert.equal(p.remainingMinor, 150000);
  assert.equal(p.status, 'Unpaid');
  assert.equal(p.dueNowMinor, 0, 'an open invoice on account is not "due now"');
});

test('pay before fulfilment holds the picking, and says how much', () => {
  const env = setup();
  const { customer, order, invoiceId } = orderWorth1500(env);
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'BEFORE_FULFILMENT' });

  const p = position(env, order);
  assert.equal(p.blocksPicking, true);
  assert.match(p.heldReason.pick, /\$1500\.00 is still owed/);

  assert.throws(() => shipments.startPicking(env.db, env.ctx, order.id),
    /pays before anything is picked.*\$1500\.00 is still owed/s);

  pay(env, customer, invoiceId, 150000, 'test:paid-in-full');
  const after = position(env, order);
  assert.equal(after.status, 'Paid');
  assert.equal(after.blocksPicking, false);
  const box = shipments.startPicking(env.db, env.ctx, order.id);
  assert.equal(box.units, 100, 'paid, so it picks');
});

test('a deposit releases picking and the balance holds the shipping', () => {
  const env = setup();
  const { customer, order, invoiceId } = orderWorth1500(env);
  terms.setTerms(env.db, env.ctx, {
    customerId: customer.id, kind: 'DEPOSIT', depositPercent: 30, holdShipping: true,
  });

  let p = position(env, order);
  assert.equal(p.depositMinor, 45000, '30% of $1,500');
  assert.equal(p.dueNowMinor, 45000);
  assert.equal(p.blocksPicking, true);
  assert.match(p.heldReason.pick, /deposit of \$450\.00 is due/);

  pay(env, customer, invoiceId, 45000, 'test:deposit');
  p = position(env, order);
  assert.equal(p.paidMinor, 45000);
  assert.equal(p.remainingMinor, 105000);
  assert.equal(p.dueNowMinor, 0, 'the deposit is covered');
  assert.equal(p.status, 'Partly paid');
  assert.equal(p.blocksPicking, false, 'deposit paid, so the warehouse may start');
  assert.equal(p.blocksShipping, true, 'but the balance still holds the parcel');
  assert.match(p.heldReason.ship, /\$1050\.00 is still owed/);

  const box = shipments.startPicking(env.db, env.ctx, order.id);
  shipments.markPacked(env.db, env.ctx, box.id, {});
  assert.throws(() => shipments.ship(env.db, env.ctx, box.id, {}),
    /\$1050\.00 is still owed.*box stays packed/s);

  pay(env, customer, invoiceId, 105000, 'test:balance');
  assert.equal(position(env, order).blocksShipping, false);
  const shipped = shipments.ship(env.db, env.ctx, box.id, {});
  assert.equal(shipped.status, 'SHIPPED', 'paid in full, so it goes');
});

test('the owner can let one order past, and it is on the record', () => {
  const env = setup();
  const { customer, order } = orderWorth1500(env);
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'BEFORE_FULFILMENT' });
  assert.throws(() => shipments.startPicking(env.db, env.ctx, order.id), /pays before anything is picked/);

  terms.overrideHold(env.db, env.ctx, order.id, 'Long-standing customer, I called them.');
  const p = position(env, order);
  assert.equal(p.blocksPicking, false);
  assert.equal(p.override.reason, 'Long-standing customer, I called them.');
  assert.ok(p.heldReason.pick, 'the hold is still described, so the page can say it was lifted');

  const box = shipments.startPicking(env.db, env.ctx, order.id);
  shipments.markPacked(env.db, env.ctx, box.id, {});
  assert.equal(shipments.ship(env.db, env.ctx, box.id, {}).status, 'SHIPPED');

  terms.clearOverride(env.db, env.ctx, order.id);
  assert.equal(position(env, order).blocksPicking, true, 'lifting it once does not lift it forever');
});

test('a customer rule beats the house rule, and the house rule beats nothing', () => {
  const env = setup();
  const { customer } = orderWorth1500(env);

  assert.equal(terms.forCustomer(env.db, env.workspace.workspaceId, customer.id).source, 'nothing agreed');

  terms.setTerms(env.db, env.ctx, { kind: 'BEFORE_FULFILMENT' });
  let mine = terms.forCustomer(env.db, env.workspace.workspaceId, customer.id);
  assert.equal(mine.kind, 'BEFORE_FULFILMENT');
  assert.equal(mine.source, 'your rule for every customer');

  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'ON_ACCOUNT', netDays: 30 });
  mine = terms.forCustomer(env.db, env.workspace.workspaceId, customer.id);
  assert.equal(mine.netDays, 30);
  assert.equal(mine.source, 'agreed with this customer');
  assert.equal(terms.describe(mine), 'Net 30.');

  terms.clearTerms(env.db, env.ctx, customer.id);
  assert.equal(terms.forCustomer(env.db, env.workspace.workspaceId, customer.id).kind, 'BEFORE_FULFILMENT',
    'removing their own terms falls back to the house rule');
});

test('terms that cannot mean anything are refused in words', () => {
  const env = setup();
  assert.throws(() => terms.setTerms(env.db, env.ctx, { kind: 'WHENEVER' }),
    /on account, before fulfilment, or with a deposit/);
  assert.throws(() => terms.setTerms(env.db, env.ctx, { kind: 'DEPOSIT' }),
    /how much of the order they pay up front/);
  assert.throws(() => terms.setTerms(env.db, env.ctx, { kind: 'DEPOSIT', depositPercent: 30, depositMinor: 5000 }),
    /not both/);
  assert.throws(() => terms.setTerms(env.db, env.ctx, { kind: 'DEPOSIT', depositPercent: 140 }),
    /between 1 and 100/);
  assert.throws(() => terms.setTerms(env.db, env.ctx, { kind: 'ON_ACCOUNT', netDays: -5 }),
    /whole number of days/);
});

test('an order with no invoice is not held, because nothing has been asked for', () => {
  const env = setup();
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'Delta Cleaning' });
  inventory.receive(env.db, env.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20 });
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'BEFORE_FULFILMENT' });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity: 5 }],
  }).id);

  const p = position(env, order);
  assert.equal(p.invoiced, false);
  assert.equal(p.status, 'Not invoiced');
  assert.equal(p.blocksPicking, false,
    'holding an order nobody has billed for would be refusing to work over a debt that does not exist');
  assert.equal(shipments.startPicking(env.db, env.ctx, order.id).units, 5);
});

test('a deposit as a fixed amount works the same as a share', () => {
  const env = setup();
  const { customer, order, invoiceId } = orderWorth1500(env);
  terms.setTerms(env.db, env.ctx, { customerId: customer.id, kind: 'DEPOSIT', depositMinor: 50000 });

  let p = position(env, order);
  assert.equal(p.depositMinor, 50000);
  assert.equal(p.dueNowMinor, 50000);

  pay(env, customer, invoiceId, 20000, 'test:part-deposit');
  p = position(env, order);
  assert.equal(p.dueNowMinor, 30000, 'part of the deposit is still owed');
  assert.equal(p.blocksPicking, true);

  pay(env, customer, invoiceId, 30000, 'test:rest-of-deposit');
  assert.equal(position(env, order).dueNowMinor, 0);
  assert.equal(position(env, order).blocksPicking, false);
});
