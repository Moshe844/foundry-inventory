'use strict';

/**
 * Phase 3 of the assistant reliability programme: purchase orders from a
 * sentence carry every line or nothing (A3), the rest of the business is
 * queryable (G1), and every tool and model call has a typed boundary and a
 * record (the tool registry and ai_calls).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../../src/domain/auth-service');
const supplierService = require('../../src/purchasing/supplier-service');
const actionService = require('../../src/actions/action-service');
const intentService = require('../../src/actions/intent-service');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll } = require('../helpers');

test.after(cleanupAll);

function purchaseLine(item, quantity, supplier = 'Acme Trade Supply', extra = {}) {
  return intentService.normaliseLine({
    actionType: 'purchase', item, variant: '', quantity, sourceLocation: '', destinationLocation: '',
    supplier, purchaseUnit: '', adjustmentTarget: -1, reasonCode: '', ...extra,
  });
}

function setup() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  const pack = makeQuantityItem(db, w.ctx, { name: 'Trail Ration Pack', baseCode: 'TRP' });
  const acme = supplierService.createSupplier(db, w.ctx, membership, { name: 'Acme Trade Supply' });
  const lakeside = supplierService.createSupplier(db, w.ctx, membership, { name: 'Lakeside Textiles' });
  supplierService.linkItem(db, w.ctx, membership, { supplierId: acme.id, skuId: elbow.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 2 });
  supplierService.linkItem(db, w.ctx, membership, { supplierId: acme.id, skuId: pack.skuId, purchaseUnit: 'box', unitsPerPurchaseUnit: 6, lastUnitCost: 24 });
  return { db, w, membership, elbow, pack, acme, lakeside };
}

// A3. Before: "That order names 2 products … prepared nothing rather than order only the first."
test('an order naming two products is one draft with both lines, and says two asked for, two carried', async () => {
  const { db, w, membership, elbow, pack, acme } = setup();
  const result = await actionService.interpret(db, w.ctx, membership,
    'Create a PO for 12 Copper Elbow and 6 Trail Ration Pack from Acme Trade Supply.',
    { parsedIntent: { lines: [purchaseLine('Copper Elbow', 12), purchaseLine('Trail Ration Pack', 6)], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.equal(result.kind, 'purchase_order', JSON.stringify(result));
  assert.equal(result.order.supplierId, acme.id);
  assert.equal(result.order.status, 'DRAFT', 'a draft — nothing ordered until approved');
  const lines = db.prepare('SELECT sku_id, quantity_units, quantity_purchase_units FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY line_number').all(result.order.id);
  assert.deepEqual(lines.map((l) => [l.sku_id, l.quantity_units, l.quantity_purchase_units]), [[elbow.skuId, 12, 12], [pack.skuId, 6, 1]]);
  assert.match(result.assumptions.join(' '), /2 lines asked for, 2 on the order: 12 units of Copper Elbow; 1 box of Trail Ration Pack\./);
  assert.deepEqual(result.order.sourceDetail.requestedLines, ['12 Copper Elbow', '6 Trail Ration Pack']);
  assert.equal(result.order.sourceDetail.preparedLines, 2);
});

test('a line that cannot be resolved stops the whole order and is named by line; nothing is drafted or linked', async () => {
  const { db, w, membership } = setup();
  const result = await actionService.interpret(db, w.ctx, membership,
    'Create a PO for 12 Copper Elbow and 6 Widgets from Acme Trade Supply.',
    { parsedIntent: { lines: [purchaseLine('Copper Elbow', 12), purchaseLine('Widgets', 6)], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.notEqual(result.kind, 'purchase_order');
  assert.match(String(result.question || result.message), /^Line 2 of 2 \(6 Widgets\): /);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n, 0);
});

test('lines from different suppliers are not one order: the split is said, nothing drafted', async () => {
  const { db, w, membership, lakeside, pack } = setup();
  supplierService.linkItem(db, w.ctx, membership, { supplierId: lakeside.id, skuId: pack.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 5 });
  const result = await actionService.interpret(db, w.ctx, membership,
    'Order 12 Copper Elbow from Acme Trade Supply and 6 Trail Ration Pack from Lakeside Textiles.',
    { parsedIntent: { lines: [purchaseLine('Copper Elbow', 12), purchaseLine('Trail Ration Pack', 6, 'Lakeside Textiles')], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.equal(result.kind, 'unsupported');
  assert.match(result.message, /different suppliers — Copper Elbow from Acme Trade Supply; Trail Ration Pack from Lakeside Textiles — and a purchase order goes to one supplier/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n, 0);
});

test('a cost said once in the sentence is not copied onto every line of a list; a cost on a line is kept', async () => {
  const { db, w, membership } = setup();
  const result = await actionService.interpret(db, w.ctx, membership,
    'Order 12 Copper Elbow at $2.50 each and 6 Trail Ration Pack from Acme Trade Supply.',
    { parsedIntent: { lines: [purchaseLine('Copper Elbow', 12, 'Acme Trade Supply', { unitCost: 2.5 }), purchaseLine('Trail Ration Pack', 6)], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.equal(result.kind, 'purchase_order', JSON.stringify(result));
  const lines = db.prepare('SELECT unit_cost FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY line_number').all(result.order.id);
  assert.equal(Number(lines[0].unit_cost), 2.5);
  assert.notEqual(Number(lines[1].unit_cost), 2.5, 'the pack keeps its own supplier cost, not the elbow price');
});
