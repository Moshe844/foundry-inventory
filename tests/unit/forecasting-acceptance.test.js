'use strict';

/**
 * Mission 15 acceptance: Foundry stops asking "are we low right now?" and
 * starts asking "where are we heading, and what should I do before that?"
 *
 * Every test here builds a real movement history through the real engine and
 * then asks the planner what it makes of it. Nothing is stubbed: the demand is
 * demand, the deliveries are deliveries, and the forecast has to find its way
 * to the right answer through the same code the running system uses.
 *
 * Where a number is asserted it is asserted as a direction or a band rather
 * than to three decimal places. A test that pins a forecast to 4.821 is a test
 * that fails the next time the method improves, and it teaches whoever inherits
 * it to change the assertion rather than think.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const purchasingPolicy = require('../../src/purchasing/policy-service');
const salesOrders = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const modes = require('../../src/autopilot/modes');
const capabilities = require('../../src/autopilot/capabilities');
const autopilotPolicy = require('../../src/autopilot/policy-service');
const preferences = require('../../src/autopilot/preferences');

const demandHistory = require('../../src/forecasting/demand-history');
const forecastEngine = require('../../src/forecasting/forecast');
const backtest = require('../../src/forecasting/backtest');
const models = require('../../src/forecasting/models');
const leadTimeEngine = require('../../src/forecasting/lead-time');
const planning = require('../../src/forecasting/planning-service');
const recommendations = require('../../src/forecasting/recommendations');
const outcomes = require('../../src/forecasting/outcomes');
const needsYou = require('../../src/manager/needs-you-inbox');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

/** A workspace with one product, one supplier and two locations. */
function setup(options = {}) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Predictive Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: options.productName || 'Black Small' });
  const supplier = supplierService.createSupplier(db, workspace.ctx, membership, {
    name: options.supplierName || 'ABC Apparel', defaultLeadTimeDays: 10,
  });
  supplierService.linkItem(db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, supplierSku: 'BS-1',
    purchaseUnit: options.purchaseUnit || 'unit',
    unitsPerPurchaseUnit: options.unitsPerPack || 1, lastUnitCost: 4.5,
    leadTimeDays: 10, minimumOrderQuantity: options.moq ?? 10,
    orderMultiple: options.multiple ?? 5, isPreferred: true,
  });
  return {
    db, workspace, membership, ctx: workspace.ctx, supplier,
    skuId: item.skuId, itemId: item.itemId,
    main: workspace.main.id, store: workspace.store.id,
    ws: workspace.workspaceId,
  };
}

const stock = (env, units, daysAgo, locationId) => inventory.receive(env.db, env.ctx, {
  skuId: env.skuId, locationId: locationId || env.main, quantity: units, occurredAt: ago(daysAgo),
});

const sell = (env, units, daysAgo, locationId, reference) => inventory.issue(env.db, env.ctx, {
  skuId: env.skuId, locationId: locationId || env.main, quantity: units,
  reasonCode: 'sold', occurredAt: ago(daysAgo), reference: reference || null,
});

/** Steady daily demand over a stretch of days. */
function trade(env, { perDay, from, to = 1, locationId }) {
  for (let day = from; day >= to; day -= 1) sell(env, perDay, day, locationId);
}

/**
 * Stocks enough, trades it at a steady rate, and leaves a known amount on the
 * shelf. Most scenarios need both a long history and a specific position today,
 * and doing that by hand gets the arithmetic wrong.
 */
function tradeDownTo(env, { perDay, days, leaving, locationId }) {
  stock(env, perDay * days + leaving, days + 5, locationId);
  trade(env, { perDay, from: days, locationId });
}

/** A delivered purchase order that took `actualDays` against a `promisedDays` promise. */
function pastDelivery(env, { sentDaysAgo, promisedDays, actualDays, units = 50 }) {
  let po = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: env.supplier.id,
    destinationLocationId: env.main,
    expectedDate: new Date(Date.parse(ago(sentDaysAgo)) + promisedDays * DAY).toISOString().slice(0, 10),
    lines: [{ skuId: env.skuId, quantityUnits: units, unitCost: 4.5 }],
  });
  po = poService.approve(env.db, env.ctx, env.membership, po.id,
    { expectedHash: po.integrityHash, markOrdered: true });
  // Backdate the send, so the measured lead time is the one the scenario means.
  env.db.prepare('UPDATE purchase_orders SET ordered_at = ?, approved_at = ? WHERE id = ?')
    .run(ago(sentDaysAgo), ago(sentDaysAgo), po.id);
  const line = poService.get(env.db, env.ws, po.id).lines[0];
  receiving.receive(env.db, env.ctx, env.membership, po.id, {
    idempotencyKey: `delivery-${po.id}`,
    receivedAt: new Date(Date.parse(ago(sentDaysAgo)) + actualDays * DAY).toISOString(),
    lines: [{ lineId: line.id, quantityUnits: units, locationId: env.main }],
  });
  return po;
}

/** An order that has been sent and has not arrived. */
function incomingDelivery(env, { units, arrivesInDays }) {
  let po = poService.createOrder(env.db, env.ctx, env.membership, {
    supplierId: env.supplier.id,
    destinationLocationId: env.main,
    expectedDate: new Date(NOW + arrivesInDays * DAY).toISOString().slice(0, 10),
    lines: [{ skuId: env.skuId, quantityUnits: units, unitCost: 4.5 }],
  });
  return poService.approve(env.db, env.ctx, env.membership, po.id,
    { expectedHash: po.integrityHash, markOrdered: true });
}

const view = (env, options = {}) => planning.forSku(env.db, env.ws, env.skuId, { now: NOW, ...options });

// ---------------------------------------------------------------------------
// 1. A stable product produces a sensible forecast
// ---------------------------------------------------------------------------

test('1. steady demand produces a forecast close to the rate actually traded', () => {
  const env = setup();
  stock(env, 900, 120);
  trade(env, { perDay: 5, from: 110 });

  const forecast = forecastEngine.forSku(env.db, env.ws, env.skuId, { now: NOW, horizonDays: 14 });

  assert.ok(forecast.dailyRate > 4 && forecast.dailyRate < 6,
    `expected about 5 a day, got ${forecast.dailyRate}`);
  assert.equal(forecast.confidence, 'high');
  assert.ok(forecast.horizonUnits > 55 && forecast.horizonUnits < 85,
    `14 days at ~5/day should be near 70, got ${forecast.horizonUnits}`);
  assert.ok(forecast.calculation.length >= 2, 'the working is shown, not just the answer');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 2. Demand rising brings the reorder point forward
// ---------------------------------------------------------------------------

test('2. demand rising moves the recommended reorder point up', () => {
  const steady = setup();
  stock(steady, 900, 120);
  trade(steady, { perDay: 4, from: 110 });
  purchasingPolicy.setPolicy(steady.db, steady.ctx, steady.membership, steady.skuId,
    { reorderPoint: 60, targetStock: 200 });

  const rising = setup();
  stock(rising, 900, 120);
  trade(rising, { perDay: 4, from: 110, to: 41 });
  trade(rising, { perDay: 9, from: 40 });
  purchasingPolicy.setPolicy(rising.db, rising.ctx, rising.membership, rising.skuId,
    { reorderPoint: 60, targetStock: 200 });

  const calm = view(steady);
  const busy = view(rising);

  assert.ok(busy.forecast.dailyRate > calm.forecast.dailyRate,
    'the busier product should forecast a higher rate');
  assert.ok(busy.advice.recommended.reorderPoint > calm.advice.recommended.reorderPoint,
    `rising demand should raise the reorder point (${calm.advice.recommended.reorderPoint} -> `
    + `${busy.advice.recommended.reorderPoint})`);

  const change = busy.advice.recommendations.find((row) => row.kind === 'reorder_point');
  assert.ok(change, 'a reorder point that has drifted should produce a recommendation');
  assert.equal(change.direction, 'increase');
  assert.match(change.why, /selling about/);
  assert.match(change.consequence, /run(?:ning)? out before/);

  steady.db.close();
  rising.db.close();
});

// ---------------------------------------------------------------------------
// 3. A supplier who has got slower is planned around, without being overwritten
// ---------------------------------------------------------------------------

test('3. a supplier taking longer than configured changes the plan, not the setting', () => {
  const env = setup();
  stock(env, 900, 120);
  trade(env, { perDay: 6, from: 110 });
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 60, targetStock: 200 });
  for (const sent of [95, 80, 65, 50, 35, 20]) {
    pastDelivery(env, { sentDaysAgo: sent, promisedDays: 10, actualDays: 13.4 });
  }

  const result = view(env);

  assert.equal(result.leadTime.source, 'measured');
  assert.ok(result.leadTime.planningDays > 12,
    `should plan on the measured ~13 days, got ${result.leadTime.planningDays}`);
  assert.equal(result.leadTime.configuredDays, 10, 'the configured value is left exactly as set');
  assert.equal(result.leadTime.material, true);
  assert.match(result.leadTime.explanation, /leaving your setting alone/);

  // And the configured value really is untouched in storage.
  const stored = supplierService.suppliersForSku(env.db, env.ws, env.skuId)[0];
  assert.equal(stored.effectiveLeadTimeDays, 10);

  const drift = result.anomalies.find((row) => row.kind === 'lead_time_deterioration');
  assert.ok(drift, 'a supplier quietly getting slower is worth saying');
  assert.equal(drift.severity, 'decision');

  env.db.close();
});

// ---------------------------------------------------------------------------
// 4. One enormous order does not become the new normal
// ---------------------------------------------------------------------------

test('4. a single huge order is kept out of the ongoing demand rate', () => {
  const withoutSpike = setup();
  stock(withoutSpike, 3000, 120);
  trade(withoutSpike, { perDay: 4, from: 110 });

  const withSpike = setup();
  stock(withSpike, 3000, 120);
  trade(withSpike, { perDay: 4, from: 110 });
  sell(withSpike, 500, 45, undefined, 'SO-BULK');

  const plain = forecastEngine.forSku(withoutSpike.db, withoutSpike.ws, withoutSpike.skuId,
    { now: NOW, horizonDays: 30 });
  const spiked = forecastEngine.forSku(withSpike.db, withSpike.ws, withSpike.skuId,
    { now: NOW, horizonDays: 30 });

  assert.ok(spiked.evidence.exceptionalUnits >= 500, 'the one-off is identified as one-off');
  assert.ok(Math.abs(spiked.dailyRate - plain.dailyRate) < 0.6,
    `a one-off order must not shift the baseline (${plain.dailyRate} -> ${spiked.dailyRate})`);

  // It is not hidden, though — it is reported as the reason the numbers look odd.
  const result = planning.forSku(withSpike.db, withSpike.ws, withSpike.skuId, { now: NOW });
  const noted = result.anomalies.find((row) => row.kind === 'large_one_off_order');
  assert.ok(noted, 'the large order is still surfaced');
  assert.equal(noted.severity, 'informational', 'it changes no decision, so it interrupts nobody');

  withoutSpike.db.close();
  withSpike.db.close();
});

// ---------------------------------------------------------------------------
// 5. Days with nothing on the shelf are not days nobody wanted it
// ---------------------------------------------------------------------------

test('5. a stockout does not teach Foundry that demand was zero', () => {
  const env = setup();
  // Ten days of stock, sold at 6 a day, then empty for twenty days, then restocked.
  stock(env, 60, 60);
  trade(env, { perDay: 6, from: 60, to: 51 });
  stock(env, 180, 30);
  trade(env, { perDay: 6, from: 30 });

  const history = demandHistory.series(env.db, env.ws, env.skuId, { now: NOW, windowDays: 70 });
  const learnable = demandHistory.learnable(history);

  assert.ok(history.totals.censoredDays >= 15,
    `the empty stretch should be recognised, saw ${history.totals.censoredDays}`);

  const naive = history.totals.netDemand / history.totals.observedDays;
  assert.ok(learnable.dailyRate > naive * 1.2,
    `correcting for the stockout must raise the rate (naive ${naive.toFixed(2)} vs `
    + `corrected ${learnable.dailyRate})`);
  assert.ok(learnable.dailyRate > 5 && learnable.dailyRate < 7,
    `the true rate was 6 a day, corrected estimate was ${learnable.dailyRate}`);

  const forecast = forecastEngine.forSku(env.db, env.ws, env.skuId, { now: NOW, horizonDays: 14 });
  assert.ok(forecast.calculation.some((step) => step.step === 'stockouts'),
    'the exclusion is explained rather than done silently');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 6. Returns and cancellations
// ---------------------------------------------------------------------------

test('6. returned goods come off demand, and a cancelled order commits nothing', () => {
  const env = setup();
  stock(env, 900, 120);
  trade(env, { perDay: 5, from: 110, to: 41 });

  // A customer order that shipped and then came back.
  prices.setPrice(env.db, env.ctx, { skuId: env.skuId, amount: '20.00', currency: 'USD' });
  const order = salesOrders.createOrder(env.db, env.ctx, {
    customerName: 'Returning Customer',
    fulfillmentLocationId: env.main,
    lines: [{ skuId: env.skuId, quantity: 40 }],
  });
  sell(env, 40, 40, env.main, order.order_number);
  // The goods come back in against the same order.
  inventory.receive(env.db, env.ctx, {
    skuId: env.skuId, locationId: env.main, quantity: 40,
    occurredAt: ago(38), reference: order.order_number,
  });
  trade(env, { perDay: 5, from: 37 });

  const history = demandHistory.series(env.db, env.ws, env.skuId, { now: NOW, windowDays: 130 });
  assert.equal(history.totals.returned, 40, 'the return is recognised as a return');
  assert.equal(history.totals.netDemand, history.totals.grossDemand - 40,
    'a sale that unhappened is not demand');

  const forecast = forecastEngine.forSku(env.db, env.ws, env.skuId, { now: NOW, horizonDays: 14 });
  assert.ok(forecast.calculation.some((step) => step.step === 'returns'),
    'the netting off is explained');

  // A cancelled order commits nothing at all.
  const cancelled = salesOrders.createOrder(env.db, env.ctx, {
    customerName: 'Cancelling Customer',
    fulfillmentLocationId: env.main,
    lines: [{ skuId: env.skuId, quantity: 200 }],
  });
  salesOrders.confirm(env.db, env.ctx, cancelled.id, { idempotencyKey: `c:${cancelled.id}` });
  const beforeCancel = demandHistory.committedDemand(env.db, env.ws, env.skuId);
  salesOrders.cancel(env.db, env.ctx, cancelled.id, 'Customer changed their mind');
  const afterCancel = demandHistory.committedDemand(env.db, env.ws, env.skuId);

  assert.ok(beforeCancel.units >= 200, 'a confirmed order is committed demand');
  assert.equal(afterCancel.units, beforeCancel.units - 200,
    'a cancelled order stops being demand entirely');

  env.db.close();
});

// ---------------------------------------------------------------------------
// 7. Not enough history is said out loud
// ---------------------------------------------------------------------------

test('7. a new product reports that it is still learning rather than guessing', () => {
  const env = setup();
  stock(env, 100, 6);
  trade(env, { perDay: 3, from: 5 });

  const forecast = forecastEngine.forSku(env.db, env.ws, env.skuId, { now: NOW, horizonDays: 30 });

  assert.equal(forecast.confidence, 'learning');
  assert.equal(forecast.confidenceLabel, 'Still learning');
  assert.equal(forecast.dailyRate, null, 'no rate is invented from five days');
  assert.equal(forecast.horizonUnits, null);
  assert.match(forecast.confidenceReasons.join(' '), /trading day/);
  assert.match(forecastEngine.summarise(forecast, 'Black Small'), /not have enough trading history/);

  // And nothing downstream pretends otherwise.
  const result = view(env);
  assert.equal(result.advice.advisable, false);
  assert.equal(result.advice.reason, 'no_demand_evidence');
  assert.match(result.advice.explanation, /followed exactly as set/);
  env.db.close();
});

// ---------------------------------------------------------------------------
// 8. Stock in the wrong shop
// ---------------------------------------------------------------------------

test('8. a location selling faster than another gets a transfer recommendation', () => {
  const env = setup();
  // The warehouse ends with a year of cover; Downtown ends with a few days.
  tradeDownTo(env, { perDay: 1, days: 110, leaving: 400, locationId: env.main });
  tradeDownTo(env, { perDay: 5, days: 110, leaving: 12, locationId: env.store });

  const result = view(env);
  const downtown = result.locations.find((row) => row.locationId === env.store);
  const warehouse = result.locations.find((row) => row.locationId === env.main);

  assert.ok(downtown.dailyRate > warehouse.dailyRate * 3,
    'each location is forecast on its own evidence');
  assert.ok(downtown.daysOfCover < warehouse.daysOfCover,
    'the busy shop has less cover than the quiet warehouse');

  const move = result.transfers[0];
  assert.ok(move, 'stock sitting in the wrong place should produce a move');
  assert.equal(move.fromLocationId, env.main);
  assert.equal(move.toLocationId, env.store);
  assert.match(move.why, /without taking .* below/,
    'the giving location must be shown to keep enough for itself');

  // The source is never stripped below its own cover.
  const keptDays = warehouse.dailyRate > 0
    ? (warehouse.free - move.units) / warehouse.dailyRate : Infinity;
  assert.ok(keptDays >= result.goals.sourceKeepDays - 1,
    `the warehouse must keep its own cover, kept ${keptDays}`);

  env.db.close();
});

// ---------------------------------------------------------------------------
// 9. Overstock
// ---------------------------------------------------------------------------

test('9. stock far beyond any reasonable cover is identified and explained', () => {
  const env = setup();
  stock(env, 400, 130);
  // One a fortnight, on four hundred units.
  for (let day = 120; day >= 6; day -= 14) sell(env, 1, day);

  const review = planning.excessReview(env.db, env.ws, { now: NOW });
  const row = review.rows.find((entry) => entry.skuId === env.skuId);

  assert.ok(row, 'four hundred units against a trickle of sales is overstock');
  assert.equal(row.kind, 'overstock');
  assert.ok(row.daysOfSupply > 300, `expected an enormous cover, got ${row.daysOfSupply}`);
  assert.match(row.recommendation, /Stop ordering/);
  assert.match(review.headline, /days of supply/);

  // The target that produced it is challenged too, not just the symptom.
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 30, targetStock: 100 });
  const advice = view(env).advice;
  const target = advice.recommendations.find((entry) => entry.kind === 'target_stock');
  assert.ok(target && target.direction === 'decrease', 'an excessive target should be challenged');
  assert.match(target.why, /tying money up/);
  env.db.close();
});

// ---------------------------------------------------------------------------
// 10. Something already coming stops another order
// ---------------------------------------------------------------------------

test('10. an order already on its way prevents a second one', () => {
  const env = setup();
  tradeDownTo(env, { perDay: 6, days: 110, leaving: 60 });
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 120, targetStock: 400 });

  const exposed = view(env);
  assert.equal(exposed.purchase.order, true, 'without help this line needs ordering');

  incomingDelivery(env, { units: 400, arrivesInDays: 5 });
  const covered = view(env);

  assert.equal(covered.purchase.order, false, 'stock on its way is stock');
  assert.ok(['covered_by_incoming', 'at_target', 'covered'].includes(covered.purchase.reason),
    `expected the incoming order to account for it, got ${covered.purchase.reason}`);
  assert.match(covered.purchase.explanation, /on order|arrive/,
    'and the explanation has to name the order that made the difference');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 11. Customer commitments change what is available
// ---------------------------------------------------------------------------

test('11. a customer commitment is subtracted on the day it was promised for', () => {
  const env = setup();
  tradeDownTo(env, { perDay: 1, days: 110, leaving: 80 });

  const before = view(env);
  assert.equal(before.projection.stockoutDate, null, 'a slow line with plenty of stock is fine');

  prices.setPrice(env.db, env.ctx, { skuId: env.skuId, amount: '20.00', currency: 'USD' });
  const order = salesOrders.createOrder(env.db, env.ctx, {
    customerName: 'Big Buyer',
    fulfillmentLocationId: env.main,
    neededBy: new Date(NOW + 9 * DAY).toISOString().slice(0, 10),
    lines: [{ skuId: env.skuId, quantity: 60 }],
  });
  salesOrders.confirm(env.db, env.ctx, order.id, { idempotencyKey: `c:${order.id}` });

  const after = view(env);
  assert.equal(after.projection.committedUnits, 60, 'the promise is known demand');
  assert.ok(after.forecast.committedUnits >= 0);
  assert.ok(after.projection.commitments.some((row) => row.orderNumber === order.order_number),
    'the commitment is placed on the calendar by its own date');

  // Known demand is kept separate from forecast demand all the way through.
  assert.notEqual(after.forecast.committedUnits, after.forecast.horizonUnits,
    'a commitment is a fact and a forecast is a guess; they are not summed into one number');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 12. The supplier's own rules still bind
// ---------------------------------------------------------------------------

test('12. minimum order quantity and pack size are still respected', () => {
  const env = setup({ moq: 60, multiple: 25, unitsPerPack: 5, purchaseUnit: 'case' });
  tradeDownTo(env, { perDay: 2, days: 110, leaving: 30 });
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 40, targetStock: 70 });

  const result = view(env);
  assert.equal(result.purchase.order, true);

  const units = result.purchase.quantityUnits;
  assert.ok(units >= 60, `the supplier's minimum of 60 must be met, got ${units}`);
  assert.equal(units % 5, 0, 'whole packs of five only');
  assert.equal(result.purchase.quantityPurchaseUnits % 25, 0,
    'the order multiple of 25 packs must be honoured');
  assert.ok(result.purchase.packSteps.length, 'the rounding is shown step by step');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 13. The explanation is the calculation
// ---------------------------------------------------------------------------

test('13. what Foundry says matches the arithmetic it actually did', () => {
  const env = setup();
  tradeDownTo(env, { perDay: 7, days: 110, leaving: 300 });
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 50, targetStock: 300 });
  for (const sent of [90, 70, 50, 30]) {
    pastDelivery(env, { sentDaysAgo: sent, promisedDays: 10, actualDays: 12 });
  }

  const result = view(env);
  const change = result.advice.recommendations.find((row) => row.kind === 'reorder_point');
  assert.ok(change, 'this rule has drifted and should be challenged');

  // Every number quoted in the sentence is a number the calculation produced.
  assert.ok(change.why.includes(String(result.forecast.dailyRate)),
    'the rate quoted must be the rate forecast');
  assert.ok(change.why.includes(String(result.advice.recommended.safetyStock)),
    'the buffer quoted must be the buffer computed');
  assert.ok(change.why.includes(String(change.recommended)),
    'the recommended figure appears in its own explanation');

  const reorderStep = result.advice.calculation.find((step) => step.step === 'reorder_point');
  assert.equal(reorderStep.value, change.recommended,
    'the working and the recommendation agree');

  const safetyStep = result.advice.calculation.find((step) => step.step === 'safety');
  assert.equal(safetyStep.value, result.advice.recommended.safetyStock);
  assert.match(safetyStep.detail, /√/, 'the safety formula is shown, not asserted');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 14 & 15. Authority
// ---------------------------------------------------------------------------

test('14. an automatic action stays inside the authority actually granted', () => {
  const env = setup();
  tradeDownTo(env, { perDay: 6, days: 110, leaving: 40 });
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 120, targetStock: 400 });

  // Nothing granted: the recommendation exists, and Foundry may not act on it.
  const swept = planning.sweepAndRecord(env.db, env.ws, { now: NOW });
  const order = swept.recorded.find((row) => row.kind === 'order_now');
  assert.ok(order, 'the shortage is recognised');
  assert.notEqual(order.authorityVerdict, 'authorized',
    'no capability is granted, so nothing may happen automatically');
  assert.equal(recommendations.mayActAlone(order), false);

  // Confidence is not authority. A high-confidence forecast changes nothing here.
  assert.equal(order.confidence, 'high');
  assert.equal(recommendations.mayActAlone(order), false,
    'being sure about a forecast is not permission to spend money');

  env.db.close();
});

test('15. work outside the granted authority becomes a decision in Needs you', () => {
  const env = setup();
  tradeDownTo(env, { perDay: 6, days: 110, leaving: 40 });
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 120, targetStock: 400 });

  planning.sweepAndRecord(env.db, env.ws, { now: NOW });
  const items = needsYou.fromPredictedTrouble(env.db, env.ws);

  assert.ok(items.length, 'a shortage Foundry may not fix itself belongs to the owner');
  const shortage = items.find((row) => /Order/i.test(row.title));
  assert.ok(shortage, 'the order Foundry cannot place appears as a decision');
  assert.equal(shortage.kind, 'decision');
  assert.ok(shortage.recommendation, 'it says what it thinks should happen');
  assert.ok(shortage.missing, 'and what it is waiting on');
  assert.ok(shortage.priority > 50, 'a coming stockout outranks routine tidying');

  env.db.close();
});

// ---------------------------------------------------------------------------
// 16. Backtesting, and falling back to the baseline
// ---------------------------------------------------------------------------

test('16. a model is used only when it beats a plain average on unseen days', () => {
  const env = setup();
  stock(env, 3000, 200);
  trade(env, { perDay: 5, from: 180 });

  const history = demandHistory.series(env.db, env.ws, env.skuId, { now: NOW, windowDays: 200 });
  const result = backtest.evaluate(history.days, { holdoutDays: 30 });

  assert.equal(result.ran, true, 'there is enough history to hold days back');
  assert.ok(result.results.some((row) => row.id === models.BASELINE_ID && row.fitted),
    'the baseline is always scored');

  // Flat demand: nothing elaborate should win, and the reason says so.
  assert.equal(result.chosenId, models.BASELINE_ID);
  assert.match(result.reason, /average/i);

  // The rule itself: a model only wins by a margin, on days it never saw.
  const baseline = result.results.find((row) => row.id === models.BASELINE_ID);
  for (const candidate of result.results.filter((row) => row.fitted && row.id !== models.BASELINE_ID)) {
    if (result.chosenId === candidate.id) {
      assert.ok(candidate.mae <= baseline.mae * (1 - backtest.IMPROVEMENT_MARGIN),
        'a winner has to be clearly better, not marginally luckier');
    }
  }

  // Too little history to test is reported, never papered over.
  const thin = backtest.evaluate(history.days.slice(-20), { holdoutDays: 30 });
  assert.equal(thin.ran, false);
  assert.equal(thin.chosenId, models.BASELINE_ID, 'the fallback is the baseline');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 17. Evaluating twice does not order twice
// ---------------------------------------------------------------------------

test('17. the same shortage evaluated twice is one recommendation', () => {
  const env = setup();
  tradeDownTo(env, { perDay: 6, days: 110, leaving: 40 });
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 120, targetStock: 400 });

  const first = planning.sweepAndRecord(env.db, env.ws, { now: NOW });
  const second = planning.sweepAndRecord(env.db, env.ws, { now: NOW });

  const count = env.db.prepare(`SELECT COUNT(*) AS n FROM planning_recommendations
    WHERE workspace_id = ? AND kind = 'order_now'`).get(env.ws).n;

  assert.equal(count, 1, 'a morning of refreshes must not become a morning of purchase orders');
  assert.equal(first.recorded[0].id, second.recorded[0].id, 'the second sweep returns the same row');

  const transfers = env.db.prepare(`SELECT COUNT(*) AS n FROM planning_recommendations
    WHERE workspace_id = ? AND kind = 'transfer'`).get(env.ws).n;
  assert.ok(transfers <= 1, 'transfers are deduplicated on the same basis');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 18. A paused Foundry does nothing
// ---------------------------------------------------------------------------

test('18. while Foundry is paused no prediction can authorise anything', () => {
  const env = setup();
  tradeDownTo(env, { perDay: 6, days: 110, leaving: 40 });
  purchasingPolicy.setPolicy(env.db, env.ctx, env.membership, env.skuId,
    { reorderPoint: 120, targetStock: 400 });

  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  capabilities.set(env.db, env.ctx, env.membership, 'replenishment', true);
  modes.pause(env.db, env.ctx, env.membership, 'Stock take this weekend');

  const swept = planning.sweepAndRecord(env.db, env.ws, { now: NOW });
  const order = swept.recorded.find((row) => row.kind === 'order_now');

  assert.ok(order, 'Foundry still notices — pausing stops acting, not thinking');
  assert.equal(order.authorityVerdict, 'refused');
  assert.match(order.authorityDetail.reason || '', /Stock take this weekend/);
  assert.equal(recommendations.mayActAlone(order), false);

  // And it is still shown to the owner, who can act themselves.
  const items = needsYou.fromPredictedTrouble(env.db, env.ws);
  assert.ok(items.some((row) => /Order/i.test(row.title)),
    'a paused Foundry still tells you what it would have done');
  env.db.close();
});

// ---------------------------------------------------------------------------
// 19. The record survives the decision
// ---------------------------------------------------------------------------

test('19. a stored forecast keeps its evidence, model and confidence, and is scored later', () => {
  const env = setup();
  stock(env, 900, 200);
  trade(env, { perDay: 5, from: 180, to: 31 });

  // A forecast made thirty days ago, stored as it stood then.
  const asOf = new Date(NOW - 30 * DAY).toISOString().slice(0, 10);
  const made = forecastEngine.forSku(env.db, env.ws, env.skuId, {
    now: NOW - 30 * DAY, asOf, horizonDays: 30,
  });
  const saved = recommendations.saveForecast(env.db, env.ws, made);

  const stored = env.db.prepare('SELECT * FROM demand_forecasts WHERE id = ?').get(saved.id);
  assert.equal(stored.model_version, forecastEngine.FORECAST_VERSION, 'the version is stamped');
  assert.equal(stored.confidence, made.confidence);
  assert.ok(stored.model_id, 'the method used is recorded');
  assert.ok(JSON.parse(stored.evidence).sellableDays > 0, 'the evidence is frozen, not re-derived');
  assert.ok(JSON.parse(stored.calculation).length, 'the working is kept');

  // The thirty days then happen, at the rate that was forecast.
  trade(env, { perDay: 5, from: 30 });

  const scored = outcomes.scoreDue(env.db, env.ws, { now: NOW });
  assert.equal(scored.length, 1, 'a closed horizon is scored');
  assert.equal(scored[0].comparable, true, 'it was in stock throughout, so it can be marked');
  assert.ok(Math.abs(scored[0].error) < scored[0].actual * 0.35,
    `a correct forecast should score well, was out by ${scored[0].error} on ${scored[0].actual}`);

  // Scoring twice does not double-count.
  assert.equal(outcomes.scoreDue(env.db, env.ws, { now: NOW }).length, 0);

  const record = outcomes.accuracy(env.db, env.ws, { now: NOW });
  assert.equal(record.comparable, 1);
  assert.match(record.summary, /closed forecasts/);
  env.db.close();
});

// ---------------------------------------------------------------------------
// 20. A broken forecast breaks nothing that matters
// ---------------------------------------------------------------------------

test('20. a forecast that fails cannot damage stock, orders or the ledger', () => {
  const env = setup();
  tradeDownTo(env, { perDay: 4, days: 110, leaving: 300 });

  const truth = () => ({
    onHand: env.db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
      .get(env.ws).n,
    movements: env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(env.ws).n,
    orders: env.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?').get(env.ws).n,
    entries: env.db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries WHERE workspace_id = ?')
      .get(env.ws).n,
  });

  const before = truth();

  // Break the forecaster from underneath, the way a real bug would.
  const original = forecastEngine.forSku;
  forecastEngine.forSku = () => { throw new Error('forecast exploded'); };
  let swept;
  try {
    swept = planning.sweep(env.db, env.ws, { now: NOW });
  } finally {
    forecastEngine.forSku = original;
  }

  assert.ok(swept, 'the sweep survives a product it cannot read');
  assert.equal(swept.shortages.length, 0, 'and claims nothing it could not work out');
  assert.deepEqual(truth(), before, 'no operational truth moved');

  // A second, subtler failure: a product with a supplier but no history at all.
  const empty = setup({ productName: 'Never Traded' });
  const quiet = planning.forSku(empty.db, empty.ws, empty.skuId, { now: NOW });
  assert.equal(quiet.forecast.dailyRate, null);
  assert.equal(quiet.purchase.order, false, 'no history is not a reason to buy');
  assert.equal(empty.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?')
    .get(empty.ws).n, 0);

  env.db.close();
  empty.db.close();
});

// ---------------------------------------------------------------------------
// 21. A quiet week is not an instruction to stop stocking something
// ---------------------------------------------------------------------------

test('21. a product that has stopped selling never gets a reorder level of zero', () => {
  /*
   * Found by running the planner over a demo inventory rather than by thinking
   * about it. A style had sold steadily for months, run out, and sold nothing
   * for a fortnight — so the measured rate was exactly zero, and every formula
   * downstream agreed: zero a day over a ten day lead time needs a reorder
   * point of zero and a target of zero. Foundry recommended switching
   * replenishment off for a product whose only problem was that it was out of
   * stock, and the reasoning would have read perfectly to whoever approved it.
   */
  const policyAdvice = require('../../src/forecasting/policy-advice');

  const stopped = policyAdvice.advise({
    displayName: 'Black Small',
    forecast: {
      dailyRate: 0,
      confidence: 'moderate',
      evidence: { netDemand: 420, censoredDays: 14, variation: 0 },
    },
    leadTime: { planningDays: 10, source: 'configured', configuredDays: 10, measured: null, material: false },
    policy: { reorderPoint: 60, targetStock: 300, safetyStock: 40 },
  });

  assert.equal(stopped.advisable, false, 'no rate means no advice about levels');
  assert.equal(stopped.reason, 'demand_stopped');
  assert.deepEqual(stopped.recommendations, [], 'and certainly no recommendation of zero');
  assert.match(stopped.explanation, /out of stock on 14 of those days/,
    'it names the likely reason rather than concluding the product is finished');
  assert.match(stopped.explanation, /followed exactly as set/);

  // Never sold at all is a different sentence, and also not a recommendation.
  const never = policyAdvice.advise({
    displayName: 'Never Sold',
    forecast: { dailyRate: 0, confidence: 'learning', evidence: { netDemand: 0, censoredDays: 0 } },
    leadTime: { planningDays: 10, source: 'configured', configuredDays: 10, measured: null, material: false },
    policy: { reorderPoint: 60 },
  });
  assert.equal(never.reason, 'no_demand_evidence');
  assert.deepEqual(never.recommendations, []);

  // And end to end: whatever a real history produces, zero is never advised.
  const env = setup();
  stock(env, 7 * 60, 100);
  trade(env, { perDay: 7, from: 95, to: 36 });
  const result = view(env);
  for (const recommendation of result.advice.recommendations) {
    assert.notEqual(Number(recommendation.recommended), 0,
      `${recommendation.kind} was recommended as 0, which switches replenishment off`);
  }
  env.db.close();
});
