'use strict';

/**
 * Mission 6: suppliers, replenishment, purchase orders and receiving.
 *
 * The tests that matter most are the ones about restraint. Recommending a
 * purchase is easy; the hard parts are not recommending one when stock is
 * already on its way, not recommending it twice, not receiving a delivery
 * twice, and not quietly accepting more than was ordered. Those are the cases
 * that cost a real business real money, so they are the ones pinned hardest.
 *
 * Every number asserted here is arithmetic. No AI provider is used anywhere in
 * this file — the replenishment engine has to be right on its own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const suppliers = require('../../src/purchasing/supplier-service');
const policies = require('../../src/purchasing/policy-service');
const replenishment = require('../../src/purchasing/replenishment');
const queryService = require('../../src/attention/query-service');
const policyService = require('../../src/purchasing/policy-service');
const position = require('../../src/purchasing/position');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const permissions = require('../../src/actions/permissions');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const {
  makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace, makeQuantityItem, makeLotItem, makeSerialItem,
} = require('../helpers');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Harbour Clothing' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

/** A supplier who sells in cases of 12, minimum 2 cases, 21 days. */
function abcFootwear(env, overrides = {}) {
  return suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'ABC Footwear',
    contactName: 'Dana Ruiz',
    email: 'orders@abcfootwear.test',
    defaultLeadTimeDays: 21,
    currency: 'USD',
    paymentTerms: 'Net 30',
    ...overrides,
  });
}

function linkCase(env, supplier, skuId, overrides = {}) {
  return suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    skuId,
    supplierSku: 'OX-NV-08',
    purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12,
    minimumOrderQuantity: 2,
    orderMultiple: 1,
    leadTimeDays: 21,
    lastUnitCost: 8.2,
    ...overrides,
  });
}

/** Issues `count` movements of `each` units, spread over the last month. */
function tradeHistory(db, ctx, skuId, locationId, { count = 6, each = 5 } = {}) {
  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const stmt = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  for (let i = 0; i < count; i += 1) {
    const result = engine.issue(db, ctx, { skuId, locationId, quantity: each, reasonCode: 'sold' });
    const when = new Date(Date.now() - (28 - i * 4) * DAY).toISOString();
    for (const id of result.movementIds) stmt.run(when, id);
  }
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );
}

// --- suppliers ---------------------------------------------------------------

test('a supplier is created and belongs to one inventory', () => {
  const env = setup();
  const supplier = abcFootwear(env);

  assert.equal(supplier.name, 'ABC Footwear');
  assert.equal(supplier.defaultLeadTimeDays, 21);
  assert.equal(supplier.status, 'active');
  assert.equal(suppliers.listSuppliers(env.db, env.workspace.workspaceId).length, 1);

  const other = seedAnotherWorkspace(env.db, env.workspace.accountId);
  assert.equal(suppliers.listSuppliers(env.db, other.workspaceId).length, 0);
  assert.throws(() => suppliers.getSupplier(env.db, other.workspaceId, supplier.id), /not in this inventory/);
});

test('each supplier keeps its own product-code wording and remembers old invoice labels', () => {
  const env = setup();
  let supplier = abcFootwear(env, { itemCodeLabel: 'Style #' });
  assert.equal(supplier.itemCodeLabel, 'Style #');

  supplier = suppliers.updateSupplier(env.db, env.ctx, env.membership, supplier.id,
    { itemCodeLabel: 'Vendor Item No.' });
  assert.equal(supplier.itemCodeLabel, 'Vendor Item No.');
  assert.ok(supplier.itemCodeAliases.includes('Style #'));

  supplier = suppliers.rememberItemCodeAlias(env.db, env.workspace.workspaceId, supplier.id, 'Catalogue Ref');
  assert.ok(supplier.itemCodeAliases.includes('Catalogue Ref'));
  const vocabulary = suppliers.documentVocabulary(env.db, env.workspace.workspaceId)[0];
  assert.equal(vocabulary.preferredItemCodeLabel, 'Vendor Item No.');
  assert.ok(vocabulary.recognizedItemCodeLabels.includes('Supplier SKU'));
  assert.ok(vocabulary.recognizedItemCodeLabels.includes('Catalogue Ref'));
  env.db.close();
});

test('the same supplier name in two inventories stays two suppliers', () => {
  const env = setup();
  const other = seedAnotherWorkspace(env.db, env.workspace.accountId);
  const membership = authService.getMembership(env.db, other.workspaceId, other.accountId);

  const first = abcFootwear(env);
  const second = suppliers.createSupplier(env.db, other.ctx, membership, { name: 'ABC Footwear' });

  assert.notEqual(first.id, second.id);
  // …and a duplicate within one inventory is still refused.
  assert.throws(() => abcFootwear(env), /already a supplier called/);
});

test('an item can have several suppliers, and one of them is preferred', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const abc = abcFootwear(env);
  const xyz = suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'XYZ Shoes',
    defaultLeadTimeDays: 7,
  });

  linkCase(env, abc, item.skuId, { lastUnitCost: 8.2, isPreferred: true });
  linkCase(env, xyz, item.skuId, { lastUnitCost: 8.7, purchaseUnit: 'box', unitsPerPurchaseUnit: 6, leadTimeDays: 7 });

  const options = suppliers.suppliersForSku(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(options.length, 2);
  assert.equal(options[0].supplierName, 'ABC Footwear');
  assert.equal(options[0].isPreferred, true);
  assert.equal(options[1].unitsPerPurchaseUnit, 6);

  // Marking the second preferred moves the flag rather than adding a second.
  linkCase(env, xyz, item.skuId, { isPreferred: true, purchaseUnit: 'box', unitsPerPurchaseUnit: 6 });
  const after = suppliers.suppliersForSku(env.db, env.workspace.workspaceId, item.skuId);
  assert.deepEqual(after.filter((s) => s.isPreferred).map((s) => s.supplierName), ['XYZ Shoes']);
});

// --- purchase units ----------------------------------------------------------

test('inventory units become whole purchase units, minimum and multiple applied in order', () => {
  const supplierItem = {
    supplierName: 'ABC Footwear',
    purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12,
    minimumOrderQuantity: 2,
    orderMultiple: 1,
  };

  // 40 needed → 4 cases (48), because you cannot buy a third of a case.
  const rounded = suppliers.toPurchaseUnits(40, supplierItem);
  assert.equal(rounded.purchaseUnits, 4);
  assert.equal(rounded.units, 48);
  assert.match(rounded.steps[0].detail, /40 needed ÷ 12 per case = 4/);

  // 6 needed → 1 case by packing, lifted to 2 by the minimum.
  const minimum = suppliers.toPurchaseUnits(6, supplierItem);
  assert.equal(minimum.purchaseUnits, 2);
  assert.equal(minimum.units, 24);
  assert.match(minimum.steps[1].detail, /minimum of 2/);

  // An order multiple of 5 rounds 3 cases up to 5.
  const multiple = suppliers.toPurchaseUnits(30, { ...supplierItem, minimumOrderQuantity: 0, orderMultiple: 5 });
  assert.equal(multiple.purchaseUnits, 5);
  assert.equal(multiple.units, 60);
  assert.match(multiple.steps[1].detail, /multiples of 5/);
});

// --- replenishment -----------------------------------------------------------

test('a line below its reorder point is recommended, with every input shown', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });   // 30 in 30 days

  const line = replenishment.evaluateOne(env.db, env.workspace.workspaceId, item.skuId);

  assert.equal(line.recommend, true);
  assert.equal(line.onHand, 10);
  assert.equal(line.onOrder, 0);
  assert.equal(line.leadTimeDays, 21);
  assert.equal(line.leadTimeAssumed, false);

  // The method is asserted rather than one fixture's rounding. Usage is
  // averaged over the days actually observed — 30 issued across 28 days of
  // history is 1.07 a day, not 1.00 — and that deliberate Mission 3 behaviour
  // must flow through the arithmetic rather than being flattened here.
  const usage = line.usagePerDay;
  const { safetyDays, coverDays, reviewPeriodDays } = replenishment.DEFAULTS;
  const expectedSafety = Math.ceil(usage * safetyDays);
  const expectedReorderPoint = Math.ceil(usage * (21 + reviewPeriodDays)) + expectedSafety;
  const expectedTarget = expectedReorderPoint + Math.ceil(usage * coverDays);
  const expectedShortfall = expectedTarget - line.onHand;
  const expectedCases = Math.max(2, Math.ceil(expectedShortfall / 12));

  assert.equal(line.safetyStock, expectedSafety);
  assert.equal(line.reorderPoint, expectedReorderPoint);
  assert.equal(line.target, expectedTarget);
  assert.equal(line.shortfall, expectedShortfall);
  assert.equal(line.quantityPurchaseUnits, expectedCases);
  assert.equal(line.quantityUnits, expectedCases * 12);
  assert.equal(line.estimatedCost, replenishment.round(expectedCases * 12 * 8.2, 2));

  // With this fixture that comes out at 6 cases — a whole-pack quantity, never
  // the raw shortfall.
  assert.equal(line.quantityUnits % 12, 0);
  assert.ok(line.quantityUnits >= line.shortfall);

  const labels = line.evidence.map((e) => e.label);
  for (const required of ['On hand', 'On order', 'Inventory position', 'Lead time', 'Safety stock', 'Reorder point', 'Order up to', 'Shortfall', 'Supplier', 'Purchase unit', 'Recommended']) {
    assert.ok(labels.includes(required), `evidence is missing "${required}"`);
  }
  assert.ok(line.calculation.length >= 5, 'the calculation should be shown step by step');
});

test('stock already on order counts, and can turn a purchase into no purchase', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 60 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });   // 30 left

  const before = replenishment.evaluateOne(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(before.recommend, true, 'below the reorder point with nothing incoming');
  assert.ok(before.onHand < before.reorderPoint);

  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 5 }],       // 60 units
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);

  const after = replenishment.evaluateOne(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(after.recommend, false);
  assert.equal(after.reason, 'covered_by_incoming');
  assert.equal(after.onOrder, 60);
  assert.equal(after.position, 90);
  assert.ok(after.position > after.reorderPoint);
  assert.match(after.explanation, /already on order/);
  assert.match(after.explanation, /Incoming stock currently covers/);
});

test('asking again and again does not create more demand', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });

  const first = replenishment.evaluateWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(first.recommendations.length, 1);

  // Act on it, exactly as the review screen does.
  const line = first.recommendations[0];
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: line.supplier.supplierId,
    source: 'foundry_recommendation',
    lines: [{ skuId: line.skuId, quantityPurchaseUnits: line.quantityPurchaseUnits }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);

  // Asking three more times must not produce three more orders.
  for (let i = 0; i < 3; i += 1) {
    const again = replenishment.evaluateWorkspace(env.db, env.workspace.workspaceId);
    assert.equal(again.recommendations.length, 0, 'the open order already covers it');
    assert.equal(again.covered.length, 1);
  }
});

test('a draft order is not incoming stock', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });

  poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 5 }],
  });

  const line = replenishment.evaluateOne(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(line.onOrder, 0, 'nobody has committed to a draft');
  assert.equal(line.recommend, true);
});

test('a line with no usage history is not guessed at', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 5 });

  const line = replenishment.evaluateOne(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(line.recommend, false);
  assert.equal(line.reason, 'no_usage_evidence');
  assert.match(line.explanation, /not enough to estimate usage/);
});

test('a configured policy replaces the derived figures', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });

  policies.setPolicy(env.db, env.ctx, env.membership, item.skuId, {
    reorderPoint: 20,
    targetStock: 100,
    safetyStock: 15,
  });

  const line = replenishment.evaluateOne(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(line.reorderPoint, 20);
  assert.equal(line.target, 100);
  assert.equal(line.safetyStock, 15);
  // 10 on hand is below 20, so order up to 100: 90 short → 8 cases (96).
  assert.equal(line.shortfall, 90);
  assert.equal(line.quantityPurchaseUnits, 8);
  assert.equal(line.quantityUnits, 96);
  assert.match(line.evidence.find((e) => e.label === 'Reorder point').note, /configured/);
});

test('a policy cannot set a target below its own reorder point', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  assert.throws(
    () => policies.setPolicy(env.db, env.ctx, env.membership, item.skuId, { reorderPoint: 50, targetStock: 20 }),
    /at least the reorder point/
  );
});

test('with no lead time anywhere, the assumption is stated rather than hidden', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, { name: 'Nameless Supply' });
  suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: item.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
  });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });

  const line = replenishment.evaluateOne(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(line.leadTimeAssumed, true);
  assert.equal(line.leadTimeDays, replenishment.DEFAULTS.leadTimeDays);
  assert.match(line.evidence.find((e) => e.label === 'Lead time').note, /assumed/);
  assert.match(line.explanation, /assumed/);
});

test('a shortfall with no supplier says so instead of recommending nothing', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });

  const line = replenishment.evaluateOne(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(line.recommend, false);
  assert.equal(line.reason, 'no_supplier');
  assert.match(line.headline, /no supplier on file/);
});

// --- supplier selection ------------------------------------------------------

test('the cheaper supplier wins, unless stock runs out before it could arrive', () => {
  const cheapSlow = {
    id: 'a', supplierId: 'sa', supplierName: 'Supplier A',
    lastUnitCost: 8.2, effectiveLeadTimeDays: 21, isPreferred: false, isActive: true,
  };
  const dearFast = {
    id: 'b', supplierId: 'sb', supplierName: 'Supplier B',
    lastUnitCost: 8.7, effectiveLeadTimeDays: 7, isPreferred: false, isActive: true,
  };

  const relaxed = replenishment.chooseSupplier([cheapSlow, dearFast], { daysOfStockRemaining: 60 });
  assert.equal(relaxed.supplierItem.supplierName, 'Supplier A');
  assert.match(relaxed.because, /cheapest/);

  const urgent = replenishment.chooseSupplier([cheapSlow, dearFast], { daysOfStockRemaining: 10 });
  assert.equal(urgent.supplierItem.supplierName, 'Supplier B');
  assert.match(urgent.because, /costs 0.5 more per unit, but is likely to arrive before/);

  // A policy's preferred supplier beats both.
  const pinned = replenishment.chooseSupplier([cheapSlow, dearFast], {
    daysOfStockRemaining: 10,
    preferredSupplierId: 'sa',
  });
  assert.equal(pinned.supplierItem.supplierName, 'Supplier A');
  assert.match(pinned.because, /preferred supplier for this line/);
});

// --- purchase orders ---------------------------------------------------------

test('a purchase order is numbered, priced and left waiting for a person', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 4 }],
  });

  assert.equal(order.poNumber, 'PO-1001');
  assert.equal(order.status, 'DRAFT');
  assert.equal(order.lines[0].quantityUnits, 48);
  assert.equal(order.lines[0].unitCost, 8.2);
  assert.equal(order.lines[0].lineTotal, 393.6);
  assert.equal(order.subtotal, 393.6);
  assert.equal(order.supplierSku, undefined);
  assert.equal(order.lines[0].supplierSku, 'OX-NV-08');
  // 21 days from a real supplier lead time, not a guess.
  assert.equal(order.expectedDateSource, 'supplier_item');
  assert.ok(order.expectedDate);

  // Nothing has arrived and nothing is on order until it is approved.
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, item.skuId).onOrder, 0);

  const second = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 2 }],
  });
  assert.equal(second.poNumber, 'PO-1002');
});

test('approving records who, when, and exactly what was approved', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 4 }],
  });

  const approved = poService.approve(env.db, env.ctx, env.membership, order.id, {
    expectedHash: order.integrityHash,
  });
  assert.equal(approved.status, 'ORDERED');
  assert.ok(approved.approvedAt);
  assert.equal(approved.approvedByUserId, env.ctx.actorId);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, item.skuId).onOrder, 48);

  // Approving again is the same answer, not a second order.
  const again = poService.approve(env.db, env.ctx, env.membership, order.id);
  assert.equal(again.approvedAt, approved.approvedAt);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, item.skuId).onOrder, 48);

  const events = poService.eventsFor(env.db, env.workspace.workspaceId, order.id).map((e) => e.event);
  assert.deepEqual(events, ['created', 'approved']);
});

test('approving something that changed underneath is refused', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 4 }],
  });

  assert.throws(
    () => poService.approve(env.db, env.ctx, env.membership, order.id, { expectedHash: 'something-else' }),
    /changed since you looked at it/
  );
  assert.equal(poService.get(env.db, env.workspace.workspaceId, order.id).status, 'DRAFT');
});

test('cancelling an unreceived order removes it from what is incoming', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 4 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, item.skuId).onOrder, 48);

  poService.cancel(env.db, env.ctx, env.membership, order.id, { reason: 'Supplier discontinued the line' });
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, item.skuId).onOrder, 0);
  assert.equal(poService.get(env.db, env.workspace.workspaceId, order.id).status, 'CANCELLED');
});

// --- receiving ---------------------------------------------------------------

function orderedAndApproved(env, skuId, supplier, purchaseUnits = 4) {
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    destinationLocationId: env.workspace.main.id,
    lines: [{ skuId, quantityPurchaseUnits: purchaseUnits }],
  });
  return poService.approve(env.db, env.ctx, env.membership, order.id);
}

test('receiving in full adds stock through the ledger and closes the order', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = orderedAndApproved(env, item.skuId, supplier);

  const done = receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'receipt-1',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 48 }],
  });

  assert.equal(done.replayed, false);
  assert.equal(done.order.status, 'RECEIVED');
  assert.equal(done.order.outstandingUnits, 0);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 48);

  // The stock arrived as a real movement, referencing the order.
  const movements = env.db
    .prepare("SELECT * FROM movements WHERE workspace_id = ? AND operation = 'receive'")
    .all(env.workspace.workspaceId);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].quantity_delta, 48);
  assert.equal(movements[0].reference, order.poNumber);
  assert.equal(movements[0].notes, receiving.RECEIPT_NOTE);

  // And it is no longer incoming.
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, item.skuId).onOrder, 0);
  assert.equal(receiving.verifyReceipt(env.db, env.workspace.workspaceId, done.receipt.id).verified, true);
});

test('receiving part of an order leaves the rest outstanding', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = orderedAndApproved(env, item.skuId, supplier, 9);        // 108 units

  const first = receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'receipt-part-1',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 80 }],
  });

  assert.equal(first.order.status, 'PARTIALLY_RECEIVED');
  assert.equal(first.order.outstandingUnits, 28);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 80);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, item.skuId).onOrder, 28);

  const rest = receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'receipt-part-2',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 28 }],
  });
  assert.equal(rest.order.status, 'RECEIVED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 108);
  assert.equal(receiving.receiptsFor(env.db, env.workspace.workspaceId, order.id).length, 2);
});

test('receiving the same delivery twice receives it once', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = orderedAndApproved(env, item.skuId, supplier);

  const key = `po-receipt:${order.id}:van-monday`;
  const first = receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: key,
    lines: [{ lineId: order.lines[0].id, quantityUnits: 24 }],
  });
  const second = receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: key,
    lines: [{ lineId: order.lines[0].id, quantityUnits: 24 }],
  });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.receipt.id, first.receipt.id);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 24);
  assert.equal(
    env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE operation = 'receive'").get().n,
    1
  );
});

test('more than was ordered is refused until somebody says otherwise', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = orderedAndApproved(env, item.skuId, supplier);          // 48 ordered

  let refusal = null;
  try {
    receiving.receive(env.db, env.ctx, env.membership, order.id, {
      idempotencyKey: 'over-1',
      lines: [{ lineId: order.lines[0].id, quantityUnits: 58 }],
    });
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal, 'an over-receipt must not go through silently');
  assert.match(refusal.message, /10 unit\(s\) above the purchase order/);
  assert.equal(refusal.overReceipt[0].overBy, 10);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 0);

  // Accepted knowingly, it goes in and the discrepancy is on record.
  const accepted = receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'over-2',
    approveOverReceipt: true,
    lines: [{ lineId: order.lines[0].id, quantityUnits: 58 }],
  });
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 58);
  assert.equal(accepted.receipt.overReceiptApproved, true);
  assert.equal(accepted.receipt.lines[0].overByUnits, 10);
  assert.equal(accepted.order.status, 'RECEIVED');
});

test('cancelling a partly received order keeps the stock that arrived', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = orderedAndApproved(env, item.skuId, supplier, 9);       // 108

  receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'partial-then-cancel',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 80 }],
  });
  poService.cancel(env.db, env.ctx, env.membership, order.id, { reason: 'Rest is back-ordered' });

  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 80);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, item.skuId).onOrder, 0);
  assert.equal(poService.get(env.db, env.workspace.workspaceId, order.id).status, 'CANCELLED');
  assert.equal(
    env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE operation = 'receive'").get().n,
    1,
    'a cancellation must never reverse stock that physically arrived'
  );
});

test('a lot-tracked delivery opens the batch it arrived in', () => {
  const env = setup();
  const item = makeLotItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: item.skuId, purchaseUnit: 'case', unitsPerPurchaseUnit: 10,
  });
  const order = orderedAndApproved(env, item.skuId, supplier, 5);       // 50

  const done = receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'lot-receipt',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 50, lotCode: 'B-2609', expiresAt: '2027-01-31' }],
  });

  assert.equal(done.order.status, 'RECEIVED');
  const lot = env.db.prepare('SELECT * FROM lots WHERE workspace_id = ?').get(env.workspace.workspaceId);
  assert.equal(lot.code, 'B-2609');
  assert.equal(done.receipt.lines[0].lotCode, 'B-2609');

  // And a lot-tracked line will not be received without saying which batch.
  const another = orderedAndApproved(env, item.skuId, supplier, 1);
  assert.throws(
    () =>
      receiving.receive(env.db, env.ctx, env.membership, another.id, {
        idempotencyKey: 'lot-missing',
        lines: [{ lineId: another.lines[0].id, quantityUnits: 10 }],
      }),
    /which batch arrived/
  );
});

test('a serial-tracked delivery is counted by the serials, not by a typed number', () => {
  const env = setup();
  const item = makeSerialItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: item.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
  });
  const order = orderedAndApproved(env, item.skuId, supplier, 3);

  const done = receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'serial-receipt',
    // Two serials with a claim of three: the list is the truth.
    lines: [{ lineId: order.lines[0].id, quantityUnits: 3, serials: ['SN-1', 'SN-2'] }],
  });

  assert.equal(done.receipt.totalUnits, 2);
  assert.equal(done.order.status, 'PARTIALLY_RECEIVED');
  assert.equal(done.order.outstandingUnits, 1);
  const serials = env.db
    .prepare('SELECT serial FROM serial_units WHERE workspace_id = ? ORDER BY serial')
    .all(env.workspace.workspaceId)
    .map((r) => r.serial);
  assert.deepEqual(serials, ['SN-1', 'SN-2']);
});

// --- cost history ------------------------------------------------------------

test('what a product last cost is answerable, and a change is measured', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId, { lastUnitCost: 7.9 });

  const first = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, lines: [{ skuId: item.skuId, quantityPurchaseUnits: 2, unitCost: 7.9 }],
  });
  poService.approve(env.db, env.ctx, env.membership, first.id);

  const second = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, lines: [{ skuId: item.skuId, quantityPurchaseUnits: 2, unitCost: 8.4 }],
  });
  poService.approve(env.db, env.ctx, env.membership, second.id);

  const history = poService.costHistory(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(history.length, 2);
  assert.equal(history[0].unitCost, 8.4);
  assert.equal(history[1].unitCost, 7.9);

  const change = poService.lastPriceChange(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(change.previous.unitCost, 7.9);
  assert.equal(change.current.unitCost, 8.4);
  assert.equal(change.percent, 6.3);
  assert.equal(change.sameSupplier, true);
});

// --- permissions and isolation ----------------------------------------------

test('purchasing permissions are separate from handling stock', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = orderedAndApproved(env, item.skuId, supplier);

  const staff = { role: 'staff' };
  // Staff can see purchasing and book in a delivery…
  assert.equal(permissions.can(staff, permissions.VIEW_PURCHASING), true);
  assert.equal(permissions.can(staff, permissions.RECEIVE_PO), true);
  assert.doesNotThrow(() =>
    receiving.receive(env.db, env.ctx, staff, order.id, {
      idempotencyKey: 'staff-receipt',
      lines: [{ lineId: order.lines[0].id, quantityUnits: 12 }],
    })
  );

  // …but cannot commit the business to a purchase, add suppliers, or set policy.
  assert.throws(
    () => poService.createOrder(env.db, env.ctx, staff, { supplierId: supplier.id, lines: [{ skuId: item.skuId, quantityUnits: 12 }] }),
    /permission/
  );
  assert.throws(() => poService.approve(env.db, env.ctx, staff, order.id), /permission/);
  assert.throws(() => suppliers.createSupplier(env.db, env.ctx, staff, { name: 'Nope' }), /permission/);
  assert.throws(() => policies.setPolicy(env.db, env.ctx, staff, item.skuId, { reorderPoint: 5 }), /permission/);
});

test('purchasing cannot reach across inventories', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);
  const order = orderedAndApproved(env, item.skuId, supplier);

  const other = seedAnotherWorkspace(env.db, env.workspace.accountId);
  const otherMembership = authService.getMembership(env.db, other.workspaceId, other.accountId);

  assert.throws(() => poService.get(env.db, other.workspaceId, order.id), /not in this inventory/);
  assert.throws(
    () => receiving.receive(env.db, other.ctx, otherMembership, order.id, {
      idempotencyKey: 'cross', lines: [{ lineId: order.lines[0].id, quantityUnits: 12 }],
    }),
    /not in this inventory/
  );
  // A supplier from another inventory cannot be put on an order here.
  const foreign = suppliers.createSupplier(env.db, other.ctx, otherMembership, { name: 'Elsewhere Supply' });
  assert.throws(
    () => poService.createOrder(env.db, env.ctx, env.membership, {
      supplierId: foreign.id, lines: [{ skuId: item.skuId, quantityUnits: 12 }],
    }),
    /not in this inventory/
  );
  assert.equal(position.positionForSku(env.db, other.workspaceId, item.skuId).onOrder, 0);
});

// --- purchasing changes what Mission 3 says ---------------------------------

const attention = require('../../src/attention/attention-engine');
const reevaluate = require('../../src/attention/reevaluate');

const findings = (env, category) =>
  attention.listAttention(env.db, env.workspace.workspaceId).filter((item) => item.category === category);

test('a stockout warning stands down once the stock is actually on order', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });  // 10 left

  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');
  const before = findings(env, 'stockout_risk');
  assert.equal(before.length, 1, 'ten left at a unit a day is a real warning');

  // A delivery is booked that lands well before the shelf empties.
  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    expectedDate: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10),
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 8 }],       // 96 units
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);

  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');
  assert.equal(findings(env, 'stockout_risk').length, 0, 'somebody already dealt with it');
});

test('being out of stock still shows, but says what is coming', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 30 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });  // exactly 0 left

  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 4 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);
  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');

  const [out] = findings(env, 'low_stock');
  assert.ok(out, 'an empty shelf is worth knowing about whatever is on its way');
  // …but it is not the same emergency, and it does not ask for another order.
  assert.equal(out.severity, 'important');
  assert.match(out.conciseSummary, /48 on order/);
  assert.match(out.recommendation, /Nothing to order/);
  assert.equal(out.metrics.onOrder, 48);
});

test('an overdue order becomes a finding, and an undated one never does', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  const late = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    expectedDate: new Date(Date.now() - 4 * DAY).toISOString().slice(0, 10),
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 5 }],       // 60 units
  });
  poService.approve(env.db, env.ctx, env.membership, late.id);
  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');

  const [finding] = findings(env, 'late_purchase_order');
  assert.ok(finding, 'four days past a date somebody typed is worth saying');
  assert.match(finding.title, new RegExp(`${late.poNumber} is 4 days past`));
  assert.match(finding.explanation, /60 unit\(s\) outstanding/);
  assert.equal(finding.metrics.daysLate, 4);

  // An order with no expected date at all is never called late: there is no
  // date to be late against, and Foundry will not invent one to accuse anybody.
  const noDateSupplier = suppliers.createSupplier(env.db, env.ctx, env.membership, { name: 'Undated Supply' });
  suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: noDateSupplier.id, skuId: item.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
  });
  const undated = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: noDateSupplier.id,
    lines: [{ skuId: item.skuId, quantityUnits: 10 }],
  });
  assert.equal(undated.expectedDateSource, 'unknown');
  assert.equal(undated.expectedDate, null);
  poService.approve(env.db, env.ctx, env.membership, undated.id);
  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');

  const stillOne = findings(env, 'late_purchase_order');
  assert.equal(stillOne.length, 1, 'only the order with a real date is reported');
});

test('receiving the delivery resolves the late finding', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  const order = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    destinationLocationId: env.workspace.main.id,
    expectedDate: new Date(Date.now() - 6 * DAY).toISOString().slice(0, 10),
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 4 }],
  });
  poService.approve(env.db, env.ctx, env.membership, order.id);
  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');
  assert.equal(findings(env, 'late_purchase_order').length, 1);

  receiving.receive(env.db, env.ctx, env.membership, order.id, {
    idempotencyKey: 'late-arrival',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 48 }],
  });
  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');

  assert.equal(findings(env, 'late_purchase_order').length, 0, 'it arrived, so it is no longer late');
});

test('a real price rise is surfaced as a fact, not an accusation', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  for (const cost of [8.2, 9.35]) {
    const order = poService.createOrder(env.db, env.ctx, env.membership, {
      supplierId: supplier.id,
      lines: [{ skuId: item.skuId, quantityPurchaseUnits: 2, unitCost: cost }],
    });
    poService.approve(env.db, env.ctx, env.membership, order.id);
  }
  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');

  const [finding] = findings(env, 'supplier_price_change');
  assert.ok(finding);
  assert.match(finding.conciseSummary, /8\.2 → 9\.35/);
  assert.match(finding.conciseSummary, /\+14%/);
  assert.match(finding.recommendation, /Worth a look/);
  // Nothing in the wording judges the supplier.
  assert.doesNotMatch(
    `${finding.title} ${finding.explanation} ${finding.recommendation}`,
    /overcharg|fraud|wrong|unfair|rip/i
  );
});

test('a small price movement is not worth reporting', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const supplier = abcFootwear(env);
  linkCase(env, supplier, item.skuId);

  for (const cost of [8.2, 8.4]) {                 // under 3%
    const order = poService.createOrder(env.db, env.ctx, env.membership, {
      supplierId: supplier.id,
      lines: [{ skuId: item.skuId, quantityPurchaseUnits: 2, unitCost: cost }],
    });
    poService.approve(env.db, env.ctx, env.membership, order.id);
  }
  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');
  assert.equal(findings(env, 'supplier_price_change').length, 0);
});

test('a workspace that buys nothing gets no purchasing findings at all', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });

  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test');
  assert.equal(findings(env, 'late_purchase_order').length, 0);
  assert.equal(findings(env, 'supplier_price_change').length, 0);
});

// --- turning purchasing on for an existing inventory --------------------------

const setupService = require('../../src/purchasing/setup-service');

test('Foundry proposes reorder points only where the history supports one', () => {
  const env = setup();
  const selling = makeQuantityItem(env.db, env.ctx, { name: 'Fast Mover', baseCode: 'FM-1' });
  const quiet = makeQuantityItem(env.db, env.ctx, { name: 'Never Sold', baseCode: 'NS-1' });

  engine.receive(env.db, env.ctx, { skuId: selling.skuId, locationId: env.workspace.main.id, quantity: 40 });
  engine.receive(env.db, env.ctx, { skuId: quiet.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, selling.skuId, env.workspace.main.id, { count: 6, each: 5 });

  const assessment = setupService.assess(env.db, env.workspace.workspaceId);

  assert.equal(assessment.summary.canPropose, 1);
  assert.equal(assessment.proposals[0].displayName, 'Fast Mover');
  assert.ok(assessment.proposals[0].proposal.reorderPoint > 0);
  assert.ok(assessment.proposals[0].derivedFrom.length, 'a proposal has to show what it came from');

  // The one that never sold gets nothing invented for it, and says why.
  assert.equal(assessment.summary.needHistory, 1);
  assert.equal(assessment.blocked[0].displayName, 'Never Sold');
  assert.match(assessment.blocked[0].because, /not enough/i);
});

test('accepting the proposals writes them, marked as derived', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 40 });
  tradeHistory(env.db, env.ctx, item.skuId, env.workspace.main.id, { count: 6, each: 5 });

  const result = setupService.applyPolicies(env.db, env.ctx, env.membership, [item.skuId]);
  assert.equal(result.count, 1);

  const policy = policies.effectivePolicy(env.db, env.workspace.workspaceId, item.skuId);
  assert.equal(policy.isSet, true);
  assert.equal(policy.source, 'foundry', 'a derived policy must be visibly derived');
  assert.ok(policy.reorderPoint > 0);

  // Re-assessing no longer proposes it — it is configured.
  const after = setupService.assess(env.db, env.workspace.workspaceId);
  assert.equal(after.summary.canPropose, 0);
  assert.equal(after.summary.alreadySet, 1);
});

test('one supplier can be attached to a whole range at once', () => {
  const env = setup();
  const first = makeQuantityItem(env.db, env.ctx, { name: 'Style A', baseCode: 'SA-1' });
  const second = makeQuantityItem(env.db, env.ctx, { name: 'Style B', baseCode: 'SB-1' });
  const supplier = abcFootwear(env);

  const result = setupService.linkSupplierToMany(env.db, env.ctx, env.membership, {
    supplierId: supplier.id,
    skuIds: [first.skuId, second.skuId],
    purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12,
    minimumOrderQuantity: 2,
    leadTimeDays: 21,
  });

  assert.equal(result.linked, 2);
  for (const skuId of [first.skuId, second.skuId]) {
    const [link] = suppliers.suppliersForSku(env.db, env.workspace.workspaceId, skuId);
    assert.equal(link.supplierName, 'ABC Footwear');
    assert.equal(link.unitsPerPurchaseUnit, 12);
    assert.equal(link.effectiveLeadTimeDays, 21);
  }
  assert.equal(setupService.assess(env.db, env.workspace.workspaceId).summary.withoutSupplier, 0);
});

test('setting purchasing up cannot be done by someone without the permission', () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx);
  const staff = { role: 'staff' };
  assert.throws(() => setupService.applyPolicies(env.db, env.ctx, staff, [item.skuId]), /permission/);
  assert.throws(
    () => setupService.linkSupplierToMany(env.db, env.ctx, staff, { supplierId: 'x', skuIds: [item.skuId] }),
    /permission/
  );
});

// --- a line Foundry cannot act on still needs ordering -----------------------
//
// Reported from the console: a SKU set to reorder at 20, sold down to 15, with
// no supplier attached. Foundry worked out it was 85 short and then answered
// "nothing needs ordering right now", with the real finding reduced to a count
// of things that "cannot be assessed".

test('a shortfall with no supplier is reported as needing ordering, not as nothing', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Test Shirt Blue M' });

  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 50 });
  policyService.setPolicy(db, workspace.ctx, membership, item.skuId, { reorderPoint: 20, targetStock: 100 });
  engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 35, reasonCode: 'sold' });

  const plan = replenishment.evaluateWorkspace(db, workspace.workspaceId, {});

  // The arithmetic was never the problem.
  assert.equal(plan.recommendations.length, 0, 'it cannot recommend without a supplier');
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].reason, 'no_supplier');
  assert.match(plan.blocked[0].headline, /85 short/);

  // What Foundry says about it is.
  const answer = queryService.execute(db, workspace.workspaceId, { intent: 'replenishment' });
  assert.doesNotMatch(answer.answer, /^Nothing needs ordering/, 'something is 85 short');
  assert.match(answer.answer, /need ordering/);
  assert.match(answer.answer, /Test Shirt Blue M/);
  assert.match(answer.answer, /85 short/);
  assert.match(answer.answer, /Add a supplier/);
  assert.equal(answer.rows.length, 1, 'and it is listed, not just counted');
});

test('with nothing short at all, it still says so plainly', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Test Shirt Blue M' });

  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 50 });
  policyService.setPolicy(db, workspace.ctx, membership, item.skuId, { reorderPoint: 20, targetStock: 100 });

  const answer = queryService.execute(db, workspace.workspaceId, { intent: 'replenishment' });
  assert.match(answer.answer, /Nothing needs ordering/);
});

test('no history is reported as not knowing, never as needing ordering', () => {
  // Found crawling a new account: a fresh product with no sales was announced
  // as "6 lines need ordering", which is the demand guess Foundry refuses to
  // make, wearing the opposite disguise.
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Brand New Thing' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 5 });

  const plan = replenishment.evaluateWorkspace(db, workspace.workspaceId, {});
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].reason, 'no_usage_evidence');

  const answer = queryService.execute(db, workspace.workspaceId, { intent: 'replenishment' });
  assert.match(answer.answer, /cannot tell yet/i);
  // It may say it cannot tell *whether* they need ordering; it may not assert that they do.
  assert.doesNotMatch(answer.answer, /line\(s\) need ordering/i, 'it has no basis for claiming that');
  assert.match(answer.answer, /will not guess/i);
});

test('a known shortfall with no supplier is still reported as needing ordering', () => {
  // The other half of the same distinction, kept honest in both directions.
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Known Short' });

  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 50 });
  policyService.setPolicy(db, workspace.ctx, membership, item.skuId, { reorderPoint: 20, targetStock: 100 });
  engine.issue(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 35, reasonCode: 'sold' });

  const answer = queryService.execute(db, workspace.workspaceId, { intent: 'replenishment' });
  assert.match(answer.answer, /need ordering/i);
  assert.match(answer.answer, /Known Short/);
});
