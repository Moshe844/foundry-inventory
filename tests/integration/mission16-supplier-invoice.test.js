'use strict';

/*
 * A supplier invoice arrives. What changes, and what does not.
 *
 * An invoice is a demand for money. It is not a delivery note. The whole
 * point of these tests is the line that keeps being crossed: on-hand stock
 * must not move because a bill turned up, no matter how confident the paper
 * sounds about what is in the box.
 *
 *   ORDERED    we committed to buy it
 *   INVOICED   the supplier says we owe money      <- this is all an invoice proves
 *   INCOMING   the supplier says it is on the way
 *   RECEIVED   it physically arrived
 *   PAID       money left our account
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const intake = require('../../src/foundry/document-intake');
const invoiceIntake = require('../../src/foundry/supplier-invoice-intake');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

// The books open the day the test runs; a date before that is refused, so fixtures are dated today.
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
  suppliers.linkItem(db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, supplierSku: 'BLACK-S',
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 10, isPreferred: true,
  });
  return { db, workspace, ctx: workspace.ctx, membership, item, supplier };
}

/** ABC Apparel's invoice #9281: 24 Black Small at $10, $240, due Sep 30. */
function invoice(overrides = {}) {
  return intake.normalise({
    documentType: 'supplier_invoice',
    goodsHaveArrived: false,
    referencedOrderNumber: '',
    businessDescription: 'Apparel supplier invoice.',
    unitLabel: 'unit',
    supplierName: 'ABC Apparel',
    supplierCodeLabel: 'Style #',
    supplierEmail: 'orders@abcapparel.test',
    documentNumber: '9281',
    documentDate: TODAY,
    paymentTerms: 'Due Sep 30',
    currency: 'USD',
    destinationName: 'Main Warehouse',
    destinationAddress: '',
    lines: [{ styleName: 'Black Small', color: '', variantDimension: '', size: '',
      supplierSku: 'BLACK-S', description: '24 Black Small', quantity: 24, unitCost: 10, sellingPrice: -1 }],
    charges: [],
    documentTotal: 240,
    warnings: [],
    ...overrides,
  });
}

/** An order for the same 24 units, placed and waiting. */
function orderFor24(env) {
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: env.supplier.id,
    lines: [{ skuId: env.item.skuId, quantityUnits: 24, unitCost: 10, supplierSku: 'BLACK-S' }],
  });
  return poService.approve(env.db, env.ctx, env.membership, order.id,
    { expectedHash: order.integrityHash, markOrdered: true });
}

function importIt(env, interpretation, documentIntent = null) {
  const prepared = intake.prepareFromInterpretation(env.db, env.ctx, env.membership,
    { filename: 'invoice-9281.pdf', buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' },
    interpretation, 'raw');
  const applied = intake.apply(env.db, env.ctx, env.membership, prepared.understandingId, null, { documentIntent });
  return typeof applied.result === 'string' ? JSON.parse(applied.result) : applied.result;
}

const onHand = (env) => env.db.prepare(`SELECT COALESCE(SUM(quantity_delta), 0) AS q
  FROM movements WHERE workspace_id = ?`).get(env.workspace.workspaceId).q;
const orders = (env) => env.db.prepare('SELECT * FROM purchase_orders WHERE workspace_id = ?')
  .all(env.workspace.workspaceId);
const bills = (env) => env.db.prepare('SELECT * FROM accounting_supplier_bills WHERE workspace_id = ?')
  .all(env.workspace.workspaceId);

test('Test B: an invoice matching an existing order bills it and moves no stock', () => {
  const env = setup();
  const order = orderFor24(env);

  const result = importIt(env, invoice({ referencedOrderNumber: order.poNumber }));

  assert.equal(result.billedAgainstOrder, order.poNumber, 'the invoice found its order');
  assert.deepEqual(result.billDifferences, [], 'and agrees with it line for line');
  assert.equal(result.billedMinor, 24000, '$240.00 is owed');

  assert.equal(onHand(env), 0, 'an invoice is not a delivery');
  assert.equal(orders(env).length, 1, 'the existing order was matched, not duplicated');
  assert.equal(orders(env)[0].status, 'ORDERED', '24 units are still expected');
  assert.equal(bills(env).length, 1);
});

test('Test B: a supplier billing more than was ordered is reported, not absorbed', () => {
  const env = setup();
  const order = orderFor24(env);

  const result = importIt(env, invoice({
    referencedOrderNumber: order.poNumber,
    lines: [{ styleName: 'Black Small', color: '', variantDimension: '', size: '',
      supplierSku: 'BLACK-S', description: '30 Black Small', quantity: 30, unitCost: 12, sellingPrice: -1 }],
  }));

  assert.ok(result.billDifferences.length >= 2, 'both the quantity and the price disagree');
  assert.ok(result.billDifferences.some((d) => /ordered 24, billed 30/.test(d)));
  assert.ok(result.billDifferences.some((d) => /ordered at 10\.00, billed at 12\.00/.test(d)));
  assert.equal(onHand(env), 0, 'and still nothing moved');
});

test('Test C: an invoice with no order records the money and asks one question', () => {
  /*
   * Businesses buy things outside Foundry. The invoice is not discarded and no
   * purchasing history is invented — the money is real either way, and whether
   * goods are coming is a question only the owner can answer.
   */
  const env = setup();
  const result = importIt(env, invoice());

  assert.equal(result.billedAgainstOrder, null, 'there was no order to match');
  assert.equal(result.billedMinor, 24000, 'but $240.00 is owed regardless');
  assert.equal(bills(env).length, 1);

  assert.equal(onHand(env), 0, 'on hand is unchanged');
  assert.equal(orders(env).length, 0, 'and no purchase was invented');
});

test('Test C: confirming the goods are coming creates the incoming purchase', () => {
  const env = setup();
  const result = importIt(env, invoice(), 'Yes, they are coming');

  assert.equal(bills(env).length, 1, '$240.00 is still owed');
  assert.equal(result.billedMinor, 24000);

  const placed = orders(env);
  assert.equal(placed.length, 1, 'now there is a purchase to expect');
  assert.equal(placed[0].status, 'ORDERED');
  assert.equal(result.unitsOnOrder, 24, '24 units are incoming');
  assert.equal(onHand(env), 0, 'and still nothing has arrived');
});

test('an invoice quoting an order that does not exist does not attach itself to another', () => {
  /*
   * A wrong match is worse than no match: it marks a different order as
   * billed, and nobody looks at an order that says it is settled.
   */
  const env = setup();
  orderFor24(env);
  const found = invoiceIntake.findOrder(env.db, env.workspace.workspaceId,
    invoice({ referencedOrderNumber: 'PO-DOES-NOT-EXIST' }), env.supplier.id);
  assert.equal(found, null);
});

test('order numbers match despite punctuation and case', () => {
  const env = setup();
  const order = orderFor24(env);
  const messy = order.poNumber.toLowerCase().replace(/-/g, ' ');
  const found = invoiceIntake.findOrder(env.db, env.workspace.workspaceId,
    invoice({ referencedOrderNumber: messy }), env.supplier.id);
  assert.ok(found, `"${messy}" should still find ${order.poNumber}`);
  assert.equal(found.po_number, order.poNumber);
});
