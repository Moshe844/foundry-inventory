'use strict';

/**
 * The deterministic half of Mission 3: signals, detectors, grouping, priority,
 * persistence and resolution. No model is involved anywhere in this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const attention = require('../../src/attention/attention-engine');
const reevaluate = require('../../src/attention/reevaluate');
const signalEngine = require('../../src/signals/signal-engine');
const detectors = require('../../src/attention/detectors');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const itemService = require('../../src/domain/item-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

function setup() {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  return { db, databasePath, workspace };
}

const open = (db, workspace) => attention.listAttention(db, workspace.workspaceId);
const byCategory = (items, category) => items.filter((i) => i.category === category);

// --- signal arithmetic -------------------------------------------------------

test('usage is measured from issues only, never from transfers', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, { name: 'Widget', baseCode: 'W-1', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  scenarios.at(db, workspace.ctx, 40, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 100 });
  scenarios.at(db, workspace.ctx, 10, 'transfer', {
    skuId: sku.id,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    quantity: 50,
  });
  scenarios.at(db, workspace.ctx, 9, 'issue', { skuId: sku.id, locationId: workspace.store.id, quantity: 10, reasonCode: 'sold' });

  const [signals] = signalEngine.skuSignals(db, workspace.workspaceId, { skuIds: [sku.id] });

  assert.equal(signals.measured.onHand, 90);
  assert.equal(signals.measured.issuedInWindow, 10, 'the transfer of 50 is not demand');

  const store = signals.perLocation.find((l) => l.locationId === workspace.store.id);
  const main = signals.perLocation.find((l) => l.locationId === workspace.main.id);
  assert.equal(store.issuedInWindow, 10);
  assert.equal(main.outboundInWindow, 50, 'a transfer still depletes the source location');
  assert.equal(main.issuedInWindow, 0);
});

test('no usage claim is made without enough history', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, { name: 'Fresh', baseCode: 'F-1', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  // One issue, today. Not a rate.
  engine.receive(db, workspace.ctx, { skuId: sku.id, locationId: workspace.main.id, quantity: 10 });
  engine.issue(db, workspace.ctx, { skuId: sku.id, locationId: workspace.main.id, quantity: 9, reasonCode: 'sold' });

  const [signals] = signalEngine.skuSignals(db, workspace.workspaceId, { skuIds: [sku.id] });
  assert.equal(signals.estimated.hasUsageEvidence, false);
  assert.equal(signals.estimated.averageDailyUsage, null);
  assert.equal(signals.estimated.daysOfStockRemaining, null);

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  assert.equal(byCategory(open(db, workspace), 'stockout_risk').length, 0, 'no forecast from one data point');
});

// --- the scenarios the mission specifies -------------------------------------

test('stockout: steady usage against dwindling stock raises a dated warning', () => {
  const { db, workspace } = setup();
  const { skuId } = scenarios.stockoutScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const [item] = byCategory(open(db, workspace), 'stockout_risk');
  assert.ok(item, 'expected a stockout warning');
  assert.equal(item.affectedEntityIds[0], skuId);
  assert.equal(item.metrics.onHand, 10);
  assert.equal(item.metrics.issuedInWindow, 90);
  assert.ok(item.metrics.daysOfStockRemaining > 0 && item.metrics.daysOfStockRemaining < 21);
  assert.match(item.title, /may run out/);

  // The calculation must be shown, and labelled as an estimate.
  const estimates = item.evidence.filter((e) => e.kind === 'estimated');
  assert.ok(estimates.some((e) => /÷/.test(e.value)), 'the arithmetic is on show');
  assert.ok(item.evidence.some((e) => e.label === 'Current stock' && e.kind === 'measured'));
});

test('imbalance: raised only when both sides justify it', () => {
  const { db, workspace } = setup();
  const { skuId } = scenarios.imbalanceScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const items = open(db, workspace);
  const imbalance = items.find(
    (i) => i.category === 'location_imbalance' || i.relatedCategories.includes('location_imbalance')
  );
  assert.ok(imbalance, `expected an imbalance signal, got ${items.map((i) => i.category).join(', ')}`);
  assert.equal(imbalance.affectedEntityIds[0], skuId);
  assert.ok(imbalance.metrics.suggestedTransferQuantity >= 1);
  assert.ok(imbalance.affectedLocationIds.length === 2);
});

test('imbalance is not raised on thin evidence', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, { name: 'Sparse', baseCode: 'SP-1', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  // Lopsided stock, but almost no movement to justify a recommendation.
  scenarios.at(db, workspace.ctx, 40, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 60 });
  scenarios.at(db, workspace.ctx, 40, 'receive', { skuId: sku.id, locationId: workspace.store.id, quantity: 3 });
  scenarios.at(db, workspace.ctx, 10, 'issue', { skuId: sku.id, locationId: workspace.store.id, quantity: 1, reasonCode: 'sold' });

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  assert.equal(byCategory(open(db, workspace), 'location_imbalance').length, 0);
});

test('adjustment anomaly: a correction far outside the usual range', () => {
  const { db, workspace } = setup();
  const { skuId } = scenarios.adjustmentAnomalyScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const [item] = byCategory(open(db, workspace), 'unusual_adjustment');
  assert.ok(item, 'expected an unusual adjustment');
  assert.equal(item.affectedEntityIds[0], skuId);
  assert.equal(item.metrics.delta, -25);
  assert.equal(item.metrics.expected, 119);
  assert.equal(item.metrics.counted, 94);
  assert.equal(item.metrics.priorAdjustments, 3);

  // Everything the spec asks to be shown.
  const labels = item.evidence.map((e) => e.label);
  for (const required of ['Before', 'After', 'Change', 'Recorded by', 'Reason given', 'Location']) {
    assert.ok(labels.includes(required), `evidence should include ${required}`);
  }
  assert.ok(item.evidenceReferences.length >= 1, 'links to the movement');

  // An operational anomaly, not an accusation.
  const text = `${item.title} ${item.explanation} ${item.recommendation}`.toLowerCase();
  for (const word of ['fraud', 'theft', 'stole', 'suspicious', 'dishonest']) {
    assert.ok(!text.includes(word), `must not imply wrongdoing (${word})`);
  }
});

test('routine corrections do not raise an anomaly', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, { name: 'Steady', baseCode: 'ST-1', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  scenarios.at(db, workspace.ctx, 40, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 200 });
  scenarios.at(db, workspace.ctx, 30, 'adjust', { skuId: sku.id, locationId: workspace.main.id, countedQty: 199, reasonCode: 'physical_count' });
  scenarios.at(db, workspace.ctx, 20, 'adjust', { skuId: sku.id, locationId: workspace.main.id, countedQty: 201, reasonCode: 'found' });
  scenarios.at(db, workspace.ctx, 10, 'adjust', { skuId: sku.id, locationId: workspace.main.id, countedQty: 199, reasonCode: 'physical_count' });
  scenarios.at(db, workspace.ctx, 1, 'adjust', { skuId: sku.id, locationId: workspace.main.id, countedQty: 201, reasonCode: 'found' });

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  assert.equal(byCategory(open(db, workspace), 'unusual_adjustment').length, 0);
});

test('expiration: quantity approaching a date, with a labelled projection', () => {
  const { db, workspace } = setup();
  const { lotId, lotCode } = scenarios.expirationScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const [item] = byCategory(open(db, workspace), 'expiring_inventory');
  assert.ok(item, 'expected an expiration warning');
  assert.equal(item.affectedEntityIds[0], lotId);
  assert.equal(item.metrics.quantity, 76);
  assert.ok(item.metrics.daysToExpiry > 0 && item.metrics.daysToExpiry <= 21);
  assert.match(item.title, new RegExp(lotCode));
  assert.equal(item.severity, 'important');

  const projection = item.evidence.find((e) => e.label === 'Projected remaining at expiry');
  if (projection) assert.equal(projection.kind, 'estimated', 'a projection is never a measured fact');
});

test('stale: quantity that has not moved for months', () => {
  const { db, workspace } = setup();
  const { skuId } = scenarios.staleScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const items = open(db, workspace);
  const stale = items.find((i) => i.category === 'stale_inventory' || i.relatedCategories.includes('stale_inventory'));
  assert.ok(stale, `expected stale inventory, got ${items.map((i) => i.category).join(', ')}`);
  assert.equal(stale.affectedEntityIds[0], skuId);
  assert.ok(stale.metrics.idleDays >= 90);
  // A prompt to look, never an automatic verdict.
  assert.ok(!/obsolete|write off|dispose/i.test(stale.recommendation));
});

test('serialized inactivity: only the unit that actually sat still', () => {
  const { db, workspace } = setup();
  const { idleUnitId, idleSerial } = scenarios.serializedInactivityScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const items = byCategory(open(db, workspace), 'serialized_inactivity');
  assert.equal(items.length, 1, 'the recently moved machine is not flagged');
  assert.equal(items[0].affectedEntityIds[0], idleUnitId);
  assert.match(items[0].title, new RegExp(idleSerial));
});

test('a fleet of idle units is one finding, not one card each', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId, {
    inventoryModel: { primaryArchetype: 'serial', serialRules: { enabled: true } },
  });
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Scaffold Tower',
    baseCode: 'SC-1',
    trackingMode: 'serial',
    unitLabel: 'tower',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  scenarios.at(db, workspace.ctx, 260, 'receive', {
    skuId: sku.id,
    locationId: workspace.main.id,
    serials: Array.from({ length: 12 }, (_, i) => ({ serial: `SC-${String(i + 1).padStart(4, '0')}` })),
  });

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const items = byCategory(open(db, workspace), 'serialized_inactivity');

  assert.equal(items.length, 1, 'twelve idle towers are one situation');
  assert.equal(items[0].metrics.unitCount, 12);
  assert.equal(items[0].affectedEntityIds.length, 12, 'every unit is still recorded');
  assert.match(items[0].title, /12 .* units have not moved/);
  // The list is shown, but capped so the page stays readable.
  assert.ok(items[0].evidence.length <= 13);
  assert.ok(items[0].evidence.some((e) => e.label === 'SC-0001'));
});

test('out of stock: raised for something that was still moving', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, { name: 'Grommet', baseCode: 'GR-1', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  scenarios.at(db, workspace.ctx, 40, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 50 });
  for (let i = 0; i < 5; i += 1) {
    scenarios.at(db, workspace.ctx, 25 - i * 5, 'issue', {
      skuId: sku.id,
      locationId: workspace.main.id,
      quantity: 10,
      reasonCode: 'sold',
    });
  }

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const [out] = byCategory(open(db, workspace), 'low_stock');
  assert.ok(out, 'expected an out-of-stock item');
  assert.equal(out.severity, 'critical');
  assert.equal(out.metrics.onHand, 0);
  assert.match(out.title, /out of stock/);
});

test('stock that reached zero long ago and never moved again is not news', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, { name: 'Discontinued', baseCode: 'DC-1', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  scenarios.at(db, workspace.ctx, 300, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 20 });
  scenarios.at(db, workspace.ctx, 250, 'issue', { skuId: sku.id, locationId: workspace.main.id, quantity: 20, reasonCode: 'sold' });

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  assert.equal(byCategory(open(db, workspace), 'low_stock').length, 0);
});

test('stock stranded at an archived location is surfaced, not hidden', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, { name: 'Stranded', baseCode: 'SD-1', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  scenarios.at(db, workspace.ctx, 20, 'receive', { skuId: sku.id, locationId: workspace.store.id, quantity: 30 });
  scenarios.at(db, workspace.ctx, 5, 'issue', { skuId: sku.id, locationId: workspace.store.id, quantity: 4, reasonCode: 'sold' });
  db.prepare('UPDATE locations SET is_active = 0 WHERE id = ?').run(workspace.store.id);

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const [stranded] = byCategory(open(db, workspace), 'data_integrity');
  assert.ok(stranded, 'expected the stranded stock to be raised');
  assert.equal(stranded.metrics.onHand, 26);
  assert.match(stranded.explanation, /archived/);
  // The balance is right; it is the situation that needs a person.
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, sku.id), 26);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('a ledger disagreement is reported without contradicting the ledger', () => {
  const { db, workspace } = setup();
  const { skuId } = scenarios.stockoutScenario(db, workspace);

  // Corrupt the maintained aggregate behind the engine's back.
  db.prepare('UPDATE balances SET on_hand = on_hand + 5 WHERE workspace_id = ? AND sku_id = ?').run(workspace.workspaceId, skuId);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, false);

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const [problem] = byCategory(open(db, workspace), 'data_integrity');
  assert.ok(problem, 'expected the discrepancy to be raised');
  assert.equal(problem.severity, 'critical');
  assert.match(problem.explanation, /re-derived every balance from the movement ledger/);
  assert.ok(problem.metrics.problemCount >= 1);
  // Reporting it changed nothing.
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, false);
});

test('healthy inventory produces no attention items at all', () => {
  const { db, workspace } = setup();
  scenarios.healthyScenario(db, workspace);
  const result = attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const items = open(db, workspace);
  assert.deepEqual(
    items.map((i) => `${i.category}:${i.title}`),
    [],
    'a healthy workspace must not be given invented problems'
  );
  assert.equal(result.opened, 0);
  assert.equal(attention.summarise(items).healthy, true);
});

// --- relevance, grouping, priority -------------------------------------------

test('categories the inventory model cannot produce are never raised', () => {
  const { db, workspace } = setup();
  scenarios.staleScenario(db, workspace); // quantity-only workspace

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const categories = new Set(open(db, workspace).map((i) => i.category));

  assert.ok(!categories.has('expiring_inventory'), 'no lots exist here');
  assert.ok(!categories.has('serialized_inactivity'), 'nothing is serialized here');
});

test('a single-location workspace is never told about imbalance', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  db.prepare('DELETE FROM locations WHERE workspace_id = ? AND id = ?').run(workspace.workspaceId, workspace.store.id);
  scenarios.configure(db, workspace.workspaceId);
  scenarios.stockoutScenario(db, workspace);

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  assert.equal(byCategory(open(db, workspace), 'location_imbalance').length, 0);
});

test('related signals about one SKU become one item, not three', () => {
  const { db, workspace } = setup();
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, { name: 'Crowded', baseCode: 'CR-1', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];

  // Nearly out overall, and badly distributed: several signals, one situation.
  // The store holds stock it never sells; the warehouse sells and is nearly dry.
  scenarios.at(db, workspace.ctx, 60, 'receive', { skuId: sku.id, locationId: workspace.store.id, quantity: 15 });
  scenarios.at(db, workspace.ctx, 60, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 41 });
  for (let i = 0; i < 6; i += 1) {
    scenarios.at(db, workspace.ctx, 27 - i * 4, 'issue', {
      skuId: sku.id,
      locationId: workspace.main.id,
      quantity: 6,
      reasonCode: 'sold',
    });
  }

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const forSku = open(db, workspace).filter((i) => i.affectedEntityIds.includes(sku.id));

  assert.equal(forSku.length, 1, `one story per SKU, got ${forSku.map((i) => i.category).join(', ')}`);
  assert.ok(forSku[0].relatedCategories.length >= 1, 'the folded-in signals are recorded');
  // The evidence from the merged signals is kept, not thrown away.
  assert.ok(forSku[0].evidence.length >= 6);
});

test('priority puts the most urgent first', () => {
  const { db, workspace } = setup();
  scenarios.stockoutScenario(db, workspace);
  scenarios.staleScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const items = open(db, workspace);
  assert.ok(items.length >= 2);
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i - 1].priorityScore >= items[i].priorityScore, 'ordered by priority');
  }
  // The SKU that runs out in days leads; the one that has sat still for months follows.
  assert.equal(items[0].severity, 'critical');
  assert.equal(items[0].category, 'stockout_risk');

  const severities = items.map((i) => i.severity);
  const lastCritical = severities.lastIndexOf('critical');
  const firstLesser = severities.findIndex((s) => s !== 'critical');
  if (lastCritical !== -1 && firstLesser !== -1) {
    assert.ok(lastCritical < firstLesser, 'critical items are never buried below lesser ones');
  }
});

// --- persistence, resolution, re-evaluation ----------------------------------

test('an item keeps its identity and first-seen date across evaluations', () => {
  const { db, workspace } = setup();
  scenarios.stockoutScenario(db, workspace);

  attention.evaluate(db, workspace.workspaceId, { trigger: 'first' });
  const [before] = byCategory(open(db, workspace), 'stockout_risk');

  const second = attention.evaluate(db, workspace.workspaceId, { trigger: 'second' });
  const [after] = byCategory(open(db, workspace), 'stockout_risk');

  assert.equal(after.attentionId, before.attentionId, 'the same condition is the same item');
  assert.equal(after.firstDetectedAt, before.firstDetectedAt);
  assert.ok(after.lastEvaluatedAt >= before.lastEvaluatedAt);
  assert.equal(second.opened, 0, 'no duplicate was created');
  assert.equal(byCategory(open(db, workspace), 'stockout_risk').length, 1);
});

test('receiving stock resolves the stockout warning, with a reason', () => {
  const { db, workspace } = setup();
  const { skuId } = scenarios.stockoutScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const [before] = byCategory(open(db, workspace), 'stockout_risk');
  assert.ok(before);

  engine.receive(db, workspace.ctx, { skuId, locationId: workspace.main.id, quantity: 500 });
  attention.evaluate(db, workspace.workspaceId, { trigger: 'after-receive', scope: { skuIds: [skuId] } });

  assert.equal(byCategory(open(db, workspace), 'stockout_risk').length, 0);

  const resolved = attention.getAttention(db, workspace.workspaceId, before.attentionId);
  assert.equal(resolved.status, 'RESOLVED');
  assert.ok(resolved.resolutionReason, 'the reason it closed is recorded');
  assert.ok(resolved.resolvedAt);
  assert.equal(resolved.firstDetectedAt, before.firstDetectedAt, 'history is kept, not deleted');
});

test('a scoped re-evaluation never resolves another SKU\'s condition', () => {
  const { db, workspace } = setup();
  const stockout = scenarios.stockoutScenario(db, workspace);
  const stale = scenarios.staleScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const staleBefore = open(db, workspace).filter((i) => i.affectedEntityIds.includes(stale.skuId));
  assert.ok(staleBefore.length >= 1);

  // Fix the stockout and re-evaluate only that SKU.
  engine.receive(db, workspace.ctx, { skuId: stockout.skuId, locationId: workspace.main.id, quantity: 400 });
  attention.evaluate(db, workspace.workspaceId, { trigger: 'scoped', scope: { skuIds: [stockout.skuId] } });

  const staleAfter = open(db, workspace).filter((i) => i.affectedEntityIds.includes(stale.skuId));
  assert.equal(staleAfter.length, staleBefore.length, 'out-of-scope items are untouched');
  assert.equal(byCategory(open(db, workspace), 'stockout_risk').length, 0, 'the in-scope item did resolve');
});

test('a resolved condition that returns reopens rather than duplicating', () => {
  const { db, workspace } = setup();
  const { skuId } = scenarios.stockoutScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const [first] = byCategory(open(db, workspace), 'stockout_risk');

  engine.receive(db, workspace.ctx, { skuId, locationId: workspace.main.id, quantity: 400 });
  attention.evaluate(db, workspace.workspaceId, { trigger: 'resolve' });
  assert.equal(attention.getAttention(db, workspace.workspaceId, first.attentionId).status, 'RESOLVED');

  engine.issue(db, workspace.ctx, { skuId, locationId: workspace.main.id, quantity: 400, reasonCode: 'sold' });
  attention.evaluate(db, workspace.workspaceId, { trigger: 'reopen' });

  const reopened = attention.getAttention(db, workspace.workspaceId, first.attentionId);
  assert.equal(reopened.status, 'OPEN');
  assert.equal(reopened.resolutionReason, null);
  assert.equal(byCategory(open(db, workspace), 'stockout_risk').length, 1, 'still one item, not two');
});

test('every open item carries evidence and a rule version', () => {
  const { db, workspace } = setup();
  scenarios.stockoutScenario(db, workspace);
  scenarios.adjustmentAnomalyScenario(db, workspace);
  scenarios.staleScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const items = open(db, workspace);
  assert.ok(items.length >= 3);
  for (const item of items) {
    assert.ok(item.evidence.length > 0, `${item.category} must show its evidence`);
    assert.ok(item.explanation.length > 20);
    assert.ok(item.recommendation.length > 5);
    assert.ok(item.detectionRuleVersion);
    assert.ok(['critical', 'important', 'watch'].includes(item.severity));
    assert.ok(['high', 'medium', 'low'].includes(item.confidence));
    assert.ok(item.firstDetectedAt && item.lastEvaluatedAt);
  }
});

test('attention is scoped to one workspace', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'Acme' });
  const b = seedWorkspace(db, { workspaceName: 'Beacon' });

  scenarios.stockoutScenario(db, a);
  scenarios.configure(db, b.workspaceId);
  scenarios.healthyScenario(db, b);

  attention.evaluate(db, a.workspaceId, { trigger: 'test' });
  attention.evaluate(db, b.workspaceId, { trigger: 'test' });

  const aItems = attention.listAttention(db, a.workspaceId);
  const bItems = attention.listAttention(db, b.workspaceId);

  assert.ok(aItems.length >= 1);
  assert.equal(bItems.length, 0);
  for (const item of aItems) assert.equal(item.workspaceId, a.workspaceId);
  assert.equal(attention.getAttention(db, b.workspaceId, aItems[0].attentionId), null);
});

test('a finding records which item it is about', () => {
  const { db, workspace } = setup();
  const { itemId, skuId } = scenarios.stockoutScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const row = db.prepare('SELECT item_id, sku_id FROM attention_items WHERE workspace_id = ?').get(workspace.workspaceId);
  assert.equal(row.item_id, itemId);
  assert.equal(row.sku_id, skuId);

  const forItem = attention.listAttentionForItem(db, workspace.workspaceId, itemId);
  assert.equal(forItem.length, 1);
  assert.match(forItem[0].title, /may run out/);

  // And it stays attached across re-evaluation.
  attention.evaluate(db, workspace.workspaceId, { trigger: 'again' });
  assert.equal(attention.listAttentionForItem(db, workspace.workspaceId, itemId).length, 1);

  // Another workspace's item id finds nothing.
  const other = seedWorkspace(db, { workspaceName: 'Elsewhere' });
  assert.equal(attention.listAttentionForItem(db, other.workspaceId, itemId).length, 0);
});

test('only one process runs the timed sweep', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  scenarios.stockoutScenario(db, workspace);

  // The first claim wins and does the work.
  assert.equal(reevaluate.acquireSweepLease(db, 60000), true);
  assert.equal(reevaluate.sweepAll(db, 'test')[0].opened, 1);

  // A second process, with a different holder, is turned away while it is held.
  const holder = db.prepare('SELECT holder FROM attention_sweep_lease').get().holder;
  db.prepare('UPDATE attention_sweep_lease SET holder = ? WHERE id = ?').run('other-host:999', 'sweep');
  assert.equal(reevaluate.acquireSweepLease(db, 60000), false);

  // Once it expires, the next process may take it.
  db.prepare('UPDATE attention_sweep_lease SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, 'sweep');
  assert.equal(reevaluate.acquireSweepLease(db, 60000), true);
  assert.equal(db.prepare('SELECT holder FROM attention_sweep_lease').get().holder, holder);
});

test('the sweep leaves each workspace to itself', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'Acme' });
  const b = seedWorkspace(db, { workspaceName: 'Beacon' });
  scenarios.stockoutScenario(db, a);
  scenarios.configure(db, b.workspaceId);
  scenarios.healthyScenario(db, b);

  const results = reevaluate.sweepAll(db, 'test');
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.workspaceId === a.workspaceId).opened, 1);
  assert.equal(results.find((r) => r.workspaceId === b.workspaceId).opened, 0);
});

test('the ledger is never touched by evaluation', () => {
  const { db, workspace } = setup();
  const { skuId } = scenarios.stockoutScenario(db, workspace);

  const before = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM movements WHERE workspace_id = @o) AS movements,
              (SELECT COALESCE(SUM(on_hand),0) FROM balances WHERE workspace_id = @o) AS onHand,
              (SELECT COUNT(*) FROM adjustments WHERE workspace_id = @o) AS adjustments`
    )
    .get({ o: workspace.workspaceId });

  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test-again' });

  const after = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM movements WHERE workspace_id = @o) AS movements,
              (SELECT COALESCE(SUM(on_hand),0) FROM balances WHERE workspace_id = @o) AS onHand,
              (SELECT COUNT(*) FROM adjustments WHERE workspace_id = @o) AS adjustments`
    )
    .get({ o: workspace.workspaceId });

  assert.deepEqual(after, before, 'interpretation must never alter inventory truth');
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, skuId), 10);
});

/**
 * The unit label is the customer's own word, and it appears next to a number on
 * every card. "64 unit of Ethiopia Guji" reads as a bug in the product, because
 * it is one.
 */
test('quantities are written with the unit word pluralised properly', () => {
  assert.equal(detectors.unitCount(1, 'unit'), '1 unit');
  assert.equal(detectors.unitCount(64, 'unit'), '64 units');
  assert.equal(detectors.unitCount(3, 'bag'), '3 bags');
  assert.equal(detectors.unitCount(12, 'box'), '12 boxes');
  // Measure abbreviations are already plural.
  assert.equal(detectors.unitCount(64, 'kg'), '64 kg');
  assert.equal(detectors.unitCount(2, 'ml'), '2 ml');
});

// --- one batch, several products ---------------------------------------------

/**
 * A roastery bags one roast into three sizes under one batch code. That is one
 * decision to make, and three cards asking for it is three times the noise for
 * the same information — while still having to show which product holds what.
 */
function batchAcrossProducts(db, ctx) {
  const created = itemService.createItem(db, ctx, {
    name: 'Ethiopia Guji',
    baseCode: 'EG-1',
    trackingMode: 'lot',
    hasVariants: true,
    options: [{ name: 'Bag size', values: '250g, 1kg' }],
  });
  const skus = repo.listSkusForItem(db, ctx.workspaceId, created.itemId);
  return { itemId: created.itemId, skus };
}

test('one batch code across several products is one finding, not several', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const { skus } = batchAcrossProducts(db, workspace.ctx);
  const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // One roast, bagged two ways, under one code.
  engine.receive(db, workspace.ctx, {
    skuId: skus[0].id, locationId: workspace.main.id, quantity: 64, lotCode: 'HOUSE-A', expiresAt,
  });
  engine.receive(db, workspace.ctx, {
    skuId: skus[1].id, locationId: workspace.store.id, quantity: 22, lotCode: 'HOUSE-A', expiresAt,
  });

  reevaluate.refresh(db, workspace.workspaceId, 'test');
  const expiring = byCategory(open(db, workspace), 'expiring_inventory');

  assert.equal(expiring.length, 1, JSON.stringify(expiring.map((e) => e.title)));
  const [item] = expiring;
  assert.match(item.title, /HOUSE-A/);
  assert.match(item.conciseSummary, /86 units across 2 products/);
  assert.match(item.explanation, /one batch across 2 products/);

  // Rolled up, but nothing hidden: both lots are linked and both shares shown.
  assert.equal(item.affectedEntityIds.length, 2);
  const evidence = item.evidence.map((e) => `${e.label}: ${e.value}`).join(' | ');
  assert.match(evidence, /Quantity remaining: 86/);
  assert.match(evidence, /Ethiopia Guji . 250g: 64/);
  assert.match(evidence, /Ethiopia Guji . 1kg: 22/);
});

test('a batch code used by one product is reported exactly as before', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const { skus } = batchAcrossProducts(db, workspace.ctx);
  const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  engine.receive(db, workspace.ctx, {
    skuId: skus[0].id, locationId: workspace.main.id, quantity: 64, lotCode: 'HOUSE-B', expiresAt,
  });

  reevaluate.refresh(db, workspace.workspaceId, 'test');
  const [item] = byCategory(open(db, workspace), 'expiring_inventory');

  assert.ok(item);
  assert.equal(item.affectedEntityIds.length, 1);
  // The per-lot fingerprint, so findings opened before this change keep their id.
  assert.match(item.fingerprint, /^expiring_inventory:lot_/);
  assert.doesNotMatch(item.conciseSummary, /across/);
});

test('two different batches of the same product stay two findings', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const { skus } = batchAcrossProducts(db, workspace.ctx);
  const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  engine.receive(db, workspace.ctx, {
    skuId: skus[0].id, locationId: workspace.main.id, quantity: 40, lotCode: 'HOUSE-C', expiresAt: soon,
  });
  engine.receive(db, workspace.ctx, {
    skuId: skus[0].id, locationId: workspace.main.id, quantity: 30, lotCode: 'HOUSE-D', expiresAt: later,
  });

  reevaluate.refresh(db, workspace.workspaceId, 'test');
  const expiring = byCategory(open(db, workspace), 'expiring_inventory');
  assert.equal(expiring.length, 2);
});
