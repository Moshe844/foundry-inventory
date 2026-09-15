'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const ledger = require('../../src/accounting/ledger');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const brain = require('../../src/forecasting/adaptive-brain');
const inventory = require('../../src/domain/inventory-engine');

test.after(cleanupAll);

function base(overrides = {}) {
  return {
    asOf:'2026-09-11', horizonDays:30, requiredUnits:100, daysUntilStockout:10,
    currency:'USD', sellingPriceMinor:5000,
    objective:{ serviceLevel:'balanced' },
    cash:{ known:true, cashMinor:1_000_000, upcomingObligationsMinor:0,
      reserveMinor:0, availableForNewCommitmentsMinor:1_000_000 },
    demand:{ confidence:'high' }, transfers:[], substitutes:[], suppliers:[],
    ...overrides,
  };
}

function vendor(overrides = {}) {
  return {
    supplierId:'sup_primary', supplierItemId:'si_primary', supplierName:'Primary Supply',
    preferred:true, unitCostMinor:3000, landedCostPerUnitMinor:0,
    leadTimeDays:5, paymentTerms:'Net 30', onTimeRate:95,
    purchaseUnit:'unit', unitsPerPurchaseUnit:1, minimumOrderQuantity:0, orderMultiple:1,
    ...overrides,
  };
}

test('stockout versus cash refuses a purchase that breaches obligations and reserve', () => {
  const result = brain.optimize(base({
    cash:{ known:true, cashMinor:500_000, upcomingObligationsMinor:350_000,
      reserveMinor:100_000, availableForNewCommitmentsMinor:50_000 },
    suppliers:[vendor({ unitCostMinor:2000, paymentTerms:'Due on receipt' })],
  }));
  const buy = result.alternatives.find((row) => row.type === 'BUY');
  assert.equal(buy.feasible, false);
  assert.match(buy.reasons.join(' '), /only \$500\.00 is available/i);
  assert.equal(result.chosen.type, 'WAIT');
  assert.equal(result.status, 'INFEASIBLE');
});

test('transfer plus purchase can prevent the stockout while preserving cash', () => {
  const result = brain.optimize(base({
    requiredUnits:1200,
    cash:{ known:true, cashMinor:10_000_000, upcomingObligationsMinor:0,
      reserveMinor:0, availableForNewCommitmentsMinor:10_000_000 },
    transfers:[{ fromLocationId:'north', units:600, arrivalDays:2, costMinor:0 }],
    suppliers:[vendor()],
  }));
  assert.equal(result.chosen.type, 'TRANSFER_AND_BUY');
  assert.equal(result.chosen.transferUnits, 600);
  assert.equal(result.chosen.purchaseUnits, 600);
  assert.equal(result.expectedResult.shortagePrevented, true);
  assert.equal(result.expectedResult.cashSavedVersusFullPurchaseMinor, 1_800_000);
  assert.match(result.explanation, /Transfer 600 and buy 600/);
  assert.match(result.explanation, /\$18,000\.00/);
});

test('viable existing stock beats buying it again and remains in the comparison evidence', () => {
  const result = brain.optimize(base({
    transfers:[{ fromLocationId:'west', units:100, arrivalDays:2, costMinor:1500 }],
    suppliers:[vendor({ unitCostMinor:1000 })],
  }));
  assert.equal(result.chosen.type, 'TRANSFER');
  assert.ok(result.alternatives.some((row) => row.type === 'BUY'));
  assert.equal(result.expectedResult.inventoryUnitsAdded, 0);
  assert.match(result.explanation, /without buying the same stock again/i);
});

test('a late preferred supplier loses to an evidenced alternate supplier', () => {
  const result = brain.optimize(base({
    suppliers:[
      vendor({ leadTimeDays:24, unitCostMinor:1000, onTimeRate:50 }),
      vendor({ supplierId:'sup_alt', supplierItemId:'si_alt', supplierName:'Reliable Supply',
        preferred:false, leadTimeDays:4, unitCostMinor:1300, onTimeRate:99 }),
    ],
  }));
  assert.equal(result.chosen.type, 'BUY_ALTERNATE');
  assert.equal(result.chosen.supplierName, 'Reliable Supply');
  assert.equal(result.expectedResult.shortagePrevented, true);
});

test('promotion and seasonality change demand only when evidence supports them', () => {
  const ignored = brain.optimize(base({ requiredUnits:100,
    demand:{ confidence:'high', promotionMultiplier:2 } }));
  assert.equal(ignored.requiredUnits, 100);
  assert.match(ignored.uncertainty.join(' '), /without evidence was ignored/i);

  const promoted = brain.optimize(base({ requiredUnits:100,
    demand:{ confidence:'high', promotionMultiplier:2,
      promotionEvidence:{ sourceType:'document', sourceId:'promo-1' } } }));
  assert.equal(promoted.requiredUnits, 200);

  const seasonal = brain.optimize(base({ requiredUnits:100,
    demand:{ confidence:'medium', seasonalMultiplier:1.5,
      seasonalEvidence:{ sourceType:'record', sourceId:'season-1' } } }));
  assert.equal(seasonal.requiredUnits, 150);
});

test('cold start and infeasible plans expose uncertainty instead of manufacturing facts', () => {
  const result = brain.optimize(base({
    demand:{ confidence:'learning' }, cash:{ known:false }, suppliers:[], transfers:[],
  }));
  assert.equal(result.chosen.type, 'WAIT');
  assert.equal(result.status, 'INFEASIBLE');
  assert.match(result.uncertainty.join(' '), /cold start/i);
  assert.match(result.uncertainty.join(' '), /No verified accounting cash balance/i);
  assert.ok(result.alternatives.find((row) => row.type === 'TRANSFER').missing.includes('viable excess stock'));
});

test('an approved substitute needs both verified identity and an explicit conversion', () => {
  const unverified = brain.optimize(base({ substitutes:[{
    skuId:'sku_b', displayName:'Blue Widget', verified:false,
    unitsPerRequiredUnit:1, spareUnits:100,
  }], suppliers:[vendor()] }));
  assert.notEqual(unverified.chosen.type, 'SUBSTITUTE');

  const verified = brain.optimize(base({ substitutes:[{
    skuId:'sku_b', displayName:'Blue Widget', verified:true,
    unitsPerRequiredUnit:1, spareUnits:100,
  }], suppliers:[vendor()] }));
  assert.equal(verified.chosen.type, 'SUBSTITUTE');
  assert.equal(verified.expectedResult.shortagePrevented, true);
});

test('shadow plans persist expected and actual outcomes idempotently without executing', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName:'Shadow Planning' });
  const item = makeQuantityItem(db, workspace.ctx, { name:'Shadow Shoe' });
  const plan = brain.optimize(base({ suppliers:[vendor()] }));
  const first = brain.record(db, workspace.workspaceId, item.skuId, plan);
  const replay = brain.record(db, workspace.workspaceId, item.skuId, plan);
  assert.equal(replay.id, first.id);
  assert.equal(first.shadow, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_orders WHERE workspace_id=?')
    .get(workspace.workspaceId).n, 0);

  const scored = brain.recordOutcome(db, workspace.workspaceId, first.id,
    { shortageObserved:false, outboundUnits:92, ownerIntervention:false });
  assert.equal(scored.status, 'SCORED');
  assert.equal(scored.actualResult.outboundUnits, 92);
  assert.deepEqual(scored.expectedResult, first.expectedResult);
  db.close();
});

test('cash constraints reconcile posted cash, purchase commitments and owner reserve', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName:'Cash Planning' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name:'Cash-aware Shoe' });
  ledger.configure(db, workspace.ctx, membership, {
    startDate:'2026-01-01', currency:'USD', costingMethod:'WEIGHTED_AVERAGE',
  });
  ledger.post(db, workspace.ctx, {
    postingDate:'2026-09-01', sourceKey:'opening-cash:mission11',
    description:'Verified opening cash', createdByType:'USER',
    lines:[
      { accountKey:'CASH', debitMinor:500_000, creditMinor:0 },
      { accountKey:'OWNERS_EQUITY', debitMinor:0, creditMinor:500_000 },
    ],
  });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, {
    name:'Terms Supply', defaultLeadTimeDays:5, paymentTerms:'Due on receipt',
  });
  suppliers.linkItem(db, workspace.ctx, membership, {
    supplierId:supplier.id, skuId:item.skuId, lastUnitCost:20,
    leadTimeDays:5, unitsPerPurchaseUnit:1, purchaseUnit:'unit', isPreferred:true,
  });
  let po = purchaseOrders.createOrder(db, workspace.ctx, membership, {
    supplierId:supplier.id, destinationLocationId:workspace.main.id,
    lines:[{ skuId:item.skuId, quantityUnits:10, unitCost:20 }],
  });
  po = purchaseOrders.approve(db, workspace.ctx, membership, po.id,
    { expectedHash:po.integrityHash, markOrdered:true });

  const laterSupplier = suppliers.createSupplier(db, workspace.ctx, membership, {
    name:'Net 60 Supply', defaultLeadTimeDays:5, paymentTerms:'Net 60',
  });
  suppliers.linkItem(db, workspace.ctx, membership, {
    supplierId:laterSupplier.id, skuId:item.skuId, lastUnitCost:100,
    leadTimeDays:5, unitsPerPurchaseUnit:1, purchaseUnit:'unit', isPreferred:false,
  });
  let laterPo = purchaseOrders.createOrder(db, workspace.ctx, membership, {
    supplierId:laterSupplier.id, destinationLocationId:workspace.main.id,
    orderDate:'2026-09-11', expectedDate:'2026-09-16',
    lines:[{ skuId:item.skuId, quantityUnits:10, unitCost:100 }],
  });
  laterPo = purchaseOrders.approve(db, workspace.ctx, membership, laterPo.id,
    { expectedHash:laterPo.integrityHash, markOrdered:true });

  const position = brain.cashPosition(db, workspace.workspaceId, {
    asOf:'2026-09-11', horizonDays:30, reserveMinor:100_000,
  });
  assert.equal(position.known, true);
  assert.equal(position.cashMinor, 500_000);
  assert.equal(position.evidence.purchaseCommitmentsMinor, 20_000);
  assert.equal(position.upcomingObligationsMinor, 20_000);
  assert.equal(position.availableForNewCommitmentsMinor, 380_000);
  db.close();
});

test('expedite is not an option until a real source provides its time and price', () => {
  const ordinary = brain.optimize(base({ suppliers:[vendor({ leadTimeDays:20 })] }));
  assert.equal(ordinary.alternatives.some((row) => row.type === 'EXPEDITE'), false);

  const evidenced = brain.optimize(base({ suppliers:[vendor({
    leadTimeDays:20, expeditedLeadTimeDays:2, expeditedUnitCostMinor:3600,
    expediteEvidence:{ sourceType:'provider', sourceId:'quote-17' },
  })] }));
  assert.ok(evidenced.alternatives.some((row) => row.type === 'EXPEDITE'));
  assert.equal(evidenced.chosen.type, 'EXPEDITE');
});

test('closed shadow horizons retain forecast drift from immutable stock history', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName:'Drift Learning' });
  const item = makeQuantityItem(db, workspace.ctx, { name:'Drifting Demand' });
  inventory.receive(db, workspace.ctx, { skuId:item.skuId, locationId:workspace.main.id,
    quantity:20, occurredAt:'2026-01-01T12:00:00.000Z' });
  inventory.issue(db, workspace.ctx, { skuId:item.skuId, locationId:workspace.main.id,
    quantity:5, reasonCode:'sold', occurredAt:'2026-01-05T12:00:00.000Z' });
  const plan = brain.optimize(base({ asOf:'2026-01-01', horizonDays:7,
    requiredUnits:10, demand:{ confidence:'medium', dailyRate:1 }, cash:{ known:false } }));
  const stored = brain.record(db, workspace.workspaceId, item.skuId, plan);
  const scored = brain.scoreDue(db, workspace.workspaceId,
    { now:Date.parse('2026-01-10T12:00:00.000Z') });
  assert.equal(scored.length, 1);
  assert.equal(scored[0].id, stored.id);
  assert.equal(scored[0].actualResult.outboundUnits, 5);
  assert.equal(scored[0].actualResult.forecastDriftUnits, -5);
  assert.equal(scored[0].actualResult.ownerIntervention, false);
  db.close();
});
