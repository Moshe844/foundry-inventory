'use strict';

/*
 * One purchase, five separate truths.
 *
 *   ORDERED    we committed to buy it
 *   INVOICED   the supplier says we owe money
 *   INCOMING   the supplier says it is on the way
 *   RECEIVED   it physically arrived
 *   PAID       money left our account
 *
 * They are related and they are not interchangeable. Receiving goods does not
 * pay for them. Paying for goods does not deliver them. An invoice proves
 * neither. The whole story has to hold together without any one event
 * corrupting the others — which is what these tests are for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const payables = require('../../src/accounting/payables');
const payments = require('../../src/accounting/payments');
const supplierPayment = require('../../src/actions/supplier-payment');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

// The books open today; a bill dated before that is refused, so the fixture is dated today.
const TODAY = new Date().toISOString().slice(0, 10);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'ABC Buyer' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small', baseCode: 'BLACK-S' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, {
    name: 'ABC Apparel', email: 'orders@abcapparel.test', currency: 'USD',
  });
  return { db, workspace, ctx: workspace.ctx, membership, item, supplier };
}

/** PO for 24 Black Small at $10, placed. Then ABC bills $240 for it. */
function orderedAndInvoiced(env) {
  const draft = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: env.supplier.id,
    lines: [{ skuId: env.item.skuId, quantityUnits: 24, unitCost: 10, supplierSku: 'BLACK-S' }],
  });
  const order = poService.approve(env.db, env.ctx, env.membership, draft.id,
    { expectedHash: draft.integrityHash, markOrdered: true });

  const poLine = env.db.prepare('SELECT id FROM purchase_order_lines WHERE purchase_order_id = ?').get(order.id);
  const bill = payables.createDraft(env.db, env.ctx, env.membership, {
    supplierId: env.supplier.id, purchaseOrderId: order.id, billNumber: '9281',
    issueDate: TODAY, dueDate: '2026-09-30',
    lines: [{ description: '24 Black Small', quantity: 24, unitCostMinor: 1000,
      skuId: env.item.skuId, purchaseOrderLineId: poLine.id }],
  });
  payables.open(env.db, env.ctx, env.membership, bill.bill.id);
  return { order, billId: bill.bill.id };
}

const onHand = (env) => env.db.prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS q
  FROM movements WHERE workspace_id = ?`).get(env.workspace.workspaceId).q;
const theBill = (env, id) => env.db.prepare('SELECT * FROM accounting_supplier_bills WHERE id = ?').get(id);
const outstanding = (env, id) => Number(theBill(env, id).balance_minor);
const paid = (env, id) => Number(theBill(env, id).total_minor) - outstanding(env, id);

test('Test D: receiving the goods moves stock and leaves the debt alone', () => {
  const env = setup();
  const { order, billId } = orderedAndInvoiced(env);

  assert.equal(onHand(env), 0, 'nothing has arrived yet');
  assert.equal(outstanding(env, billId), 24000, '$240.00 is owed');

  const line = env.db.prepare('SELECT id, destination_location_id FROM purchase_order_lines WHERE purchase_order_id = ?')
    .get(order.id);
  receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'arrived-1',
    lines: [{ lineId: line.id, quantityUnits: 24,
      locationId: line.destination_location_id || env.workspace.main.id }],
  });

  assert.equal(onHand(env), 24, 'the goods are on the shelf');
  assert.equal(outstanding(env, billId), 24000,
    'receiving goods is not paying for them — the $240.00 still stands');
});

test('Test E: a part payment moves money and no stock', () => {
  const env = setup();
  const { order, billId } = orderedAndInvoiced(env);
  const line = env.db.prepare('SELECT id, destination_location_id FROM purchase_order_lines WHERE purchase_order_id = ?')
    .get(order.id);
  receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'arrived-1',
    lines: [{ lineId: line.id, quantityUnits: 24, locationId: line.destination_location_id || env.workspace.main.id }],
  });

  const before = onHand(env);
  payments.record(env.db, env.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: env.supplier.id,
    paymentDate: '2026-09-10', amountMinor: 10000, method: 'bank_transfer',
    sourceKey: 'paid-100', allocations: [{ billId, amountMinor: 10000 }],
  });

  const bill = theBill(env, billId);
  assert.equal(paid(env, billId), 10000, '$100.00 paid');
  assert.equal(outstanding(env, billId), 14000, '$140.00 left');
  assert.equal(bill.status, 'PARTIALLY_PAID');
  assert.equal(onHand(env), before, 'paying a supplier moves no stock');
});

test('Test F: the final payment settles it, and still moves no stock', () => {
  const env = setup();
  const { order, billId } = orderedAndInvoiced(env);
  const line = env.db.prepare('SELECT id, destination_location_id FROM purchase_order_lines WHERE purchase_order_id = ?')
    .get(order.id);
  receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'arrived-1',
    lines: [{ lineId: line.id, quantityUnits: 24, locationId: line.destination_location_id || env.workspace.main.id }],
  });
  payments.record(env.db, env.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: env.supplier.id, paymentDate: '2026-09-10',
    amountMinor: 10000, method: 'bank_transfer', sourceKey: 'paid-100',
    allocations: [{ billId, amountMinor: 10000 }],
  });

  const before = onHand(env);
  payments.record(env.db, env.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: env.supplier.id, paymentDate: '2026-09-25',
    amountMinor: 14000, method: 'bank_transfer', sourceKey: 'paid-140',
    allocations: [{ billId, amountMinor: 14000 }],
  });

  const bill = theBill(env, billId);
  assert.equal(paid(env, billId), 24000, '$240.00 paid in full');
  assert.equal(outstanding(env, billId), 0);
  assert.equal(bill.status, 'PAID');
  assert.equal(onHand(env), before, 'and the shelf is exactly where receiving left it');
});

test('paying before the goods come does not deliver them', () => {
  /*
   * The mirror of Test D, and the one that catches a system quietly treating
   * "settled" as "done". Money can move first; stock does not follow it.
   */
  const env = setup();
  const { billId } = orderedAndInvoiced(env);

  payments.record(env.db, env.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: env.supplier.id, paymentDate: '2026-09-05',
    amountMinor: 24000, method: 'bank_transfer', sourceKey: 'paid-up-front',
    allocations: [{ billId, amountMinor: 24000 }],
  });

  assert.equal(theBill(env, billId).status, 'PAID');
  assert.equal(onHand(env), 0, 'paid for, and still not here');
});

test('the same payment recorded twice is one payment', () => {
  const env = setup();
  const { billId } = orderedAndInvoiced(env);
  const pay = () => payments.record(env.db, env.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: env.supplier.id, paymentDate: '2026-09-10',
    amountMinor: 10000, method: 'bank_transfer', sourceKey: 'paid-100',
    allocations: [{ billId, amountMinor: 10000 }],
  });
  pay();
  pay();
  assert.equal(paid(env, billId), 10000, 'a retry must not pay a supplier twice');
});

test('paying in words: "I paid ABC $100 toward invoice #9281"', () => {
  /*
   * The reading is the model's job and it does it — this is everything after:
   * which bill was meant, how much is left, and the fact that no stock moves.
   */
  const env = setup();
  const { billId } = orderedAndInvoiced(env);
  const before = onHand(env);

  const planned = supplierPayment.plan(env.db, env.ctx, {
    supplierText: 'ABC', amountMinor: 10000, reference: '9281', instruction: 'I paid ABC $100 toward invoice #9281',
  });
  assert.equal(planned.kind, 'supplier_payment');
  assert.equal(planned.bill.id, billId);
  assert.equal(planned.amountMinor, 10000);
  assert.equal(planned.remainingAfterMinor, 14000);

  const done = supplierPayment.record(env.db, env.ctx, env.membership, planned);
  assert.equal(Number(done.bill.balance_minor), 14000);
  assert.equal(done.bill.status, 'PARTIALLY_PAID');
  assert.equal(onHand(env), before, 'paying moved no stock');
});

test('"I paid the remaining $140" finishes it without naming anything', () => {
  /*
   * No supplier, no invoice number, and still unambiguous when one bill is
   * outstanding. Reading "the remaining" off that bill is not Foundry
   * inventing a figure — it is the only figure the sentence could mean.
   */
  const env = setup();
  const { billId } = orderedAndInvoiced(env);
  supplierPayment.record(env.db, env.ctx, env.membership,
    supplierPayment.plan(env.db, env.ctx, { supplierText: '', amountMinor: 10000, reference: '9281' }));

  const planned = supplierPayment.plan(env.db, env.ctx,
    { supplierText: '', amountMinor: null, reference: '', instruction: 'I paid the remaining $140' });
  assert.equal(planned.kind, 'supplier_payment');
  assert.equal(planned.amountMinor, 14000, 'the rest of it');

  const done = supplierPayment.record(env.db, env.ctx, env.membership, planned);
  assert.equal(Number(done.bill.balance_minor), 0);
  assert.equal(done.bill.status, 'PAID');
  assert.equal(onHand(env), 0, 'and the shelf never moved');
  assert.equal(billId, done.bill.id);
});

test('paying more than is owed records nothing and says both figures', () => {
  const env = setup();
  orderedAndInvoiced(env);
  const planned = supplierPayment.plan(env.db, env.ctx,
    { supplierText: 'ABC', amountMinor: 50000, reference: '9281' });
  assert.equal(planned.kind, 'question');
  assert.match(planned.question, /240\.00 outstanding/);
  assert.match(planned.question, /500\.00/);
  assert.match(planned.question, /has not recorded anything/);
});

test('two outstanding bills is a question, not a guess', () => {
  const env = setup();
  orderedAndInvoiced(env);
  const second = payables.createDraft(env.db, env.ctx, env.membership, {
    // TODAY, not a fixed date. This read '2026-09-03' and passed until the
    // clock rolled past it, at which point the bill was dated before the
    // accounting start date and the ledger refused it — a test that fails by
    // calendar rather than by code.
    supplierId: env.supplier.id, billNumber: '9282', issueDate: TODAY,
    lines: [{ description: 'More', quantity: 1, unitCostMinor: 5000 }],
  });
  payables.open(env.db, env.ctx, env.membership, second.bill.id);

  const planned = supplierPayment.plan(env.db, env.ctx,
    { supplierText: 'ABC', amountMinor: 5000, reference: '' });
  assert.equal(planned.kind, 'question');
  assert.match(planned.question, /2 bills outstanding/);
  assert.equal(planned.choices.length, 2, 'and it lists them rather than picking one');
});

test('a supplier Foundry has never heard of is said plainly', () => {
  const env = setup();
  orderedAndInvoiced(env);
  const planned = supplierPayment.plan(env.db, env.ctx,
    { supplierText: 'Nobody Ltd', amountMinor: 1000, reference: '' });
  assert.equal(planned.kind, 'question');
  assert.match(planned.question, /no supplier called/i);
});

test('a disputed bill is not reported as nothing owed', () => {
  /*
   * Found while testing this: a bill Foundry had flagged as disagreeing with
   * its order was excluded from "what is outstanding", so asking to pay it
   * answered "nothing is outstanding" — for $240 that was very much owed.
   */
  const env = setup();
  const { billId } = orderedAndInvoiced(env);
  env.db.prepare("UPDATE accounting_supplier_bills SET status = 'DISPUTED' WHERE id = ?").run(billId);

  const planned = supplierPayment.plan(env.db, env.ctx,
    { supplierText: 'ABC', amountMinor: 10000, reference: '9281' });
  assert.equal(planned.kind, 'question');
  assert.match(planned.question, /240\.00 outstanding/, 'the money is still owed and Foundry says so');
  assert.match(planned.question, /found a difference/);
});
