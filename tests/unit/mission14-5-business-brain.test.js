'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const automatic = require('../../src/accounting/automatic');
const brain = require('../../src/manager/business-brain');
const planner = require('../../src/attention/query-planner');
const queries = require('../../src/attention/query-service');
const inventory = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const workspaceExport = require('../../src/domain/workspace-export');
const middleware = require('../../src/web/middleware');
const backups = require('../../src/operations/backup');
const reconciliation = require('../../src/manager/reconciliation');
const investigations = require('../../src/manager/investigations');
const needsYouInbox = require('../../src/manager/needs-you-inbox');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace,
  makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

test('unified state keeps physical, committed, available and incoming concepts separate', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  automatic.ensure(db, workspace.workspaceId, { actorId: workspace.ownerId });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Shirt' });
  inventory.receive(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 25,
    reasonCode: 'opening', notes: 'Opening count without invented cost',
  });

  const state = brain.build(db, workspace.workspaceId);
  assert.equal(state.inventory.onHand, 25);
  assert.equal(state.inventory.committed, 0);
  assert.equal(state.inventory.available, 25);
  assert.equal(state.inventory.incoming, 0);
  assert.equal(state.acquisition.receivedCostMinor, 0);
  assert.equal(state.finance.inventory.missingCostUnits, 25);
  assert.equal(state.consistency.find((check) => check.key === 'inventory-ledger').passed, true);
  assert.equal(state.consistency.find((check) => check.key === 'inventory-cost-coverage').passed, true);
  assert.equal(state.consistency.find((check) => check.key === 'inventory-cost-coverage').complete, false);
  assert.match(state.briefing.headline, /consistent/i);
});

test('a documented receipt never becomes a false zero inventory-value claim', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  automatic.ensure(db, workspace.workspaceId, { actorId: workspace.ownerId });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Partly costed stock' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id,
    quantity: 10, reasonCode: 'opening' });
  const state = brain.build(db, workspace.workspaceId);
  assert.equal(state.acquisition.valuationComplete, false);
  assert.equal(state.consistency.find((check) => check.key === 'inventory-cost-coverage').passed, true);
  assert.equal(state.consistency.find((check) => check.key === 'inventory-cost-coverage').complete, false);
  assert.doesNotMatch(state.briefing.lines.join(' '), /\$0\.00 remains in stock/i);
});

test('missing cost evidence cannot remain as a false urgent consistency investigation', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  automatic.ensure(db, workspace.workspaceId, { actorId: workspace.ownerId });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Unknown opening cost' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id,
    quantity: 4, reasonCode: 'opening' });
  investigations.create(db, workspace.workspaceId, {
    trigger: 'business_consistency_inventory-cost-coverage',
    affectedEntities: { workspaceId: workspace.workspaceId, consistencyKey: 'inventory-cost-coverage' },
    observedDifference: { oldClassification: true },
  });
  reconciliation.reconcileUnifiedBusinessState(db, workspace.workspaceId);
  assert.equal(investigations.list(db, workspace.workspaceId,
    { statuses: ['OPEN','NEEDS_HUMAN','INCONCLUSIVE'] })
    .some((entry) => entry.trigger === 'business_consistency_inventory-cost-coverage'), false);
});

test('Needs You cleans a legacy missing-cost investigation without showing a dead resolution action', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  automatic.ensure(db, workspace.workspaceId, { actorId: workspace.ownerId });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Legacy uncosted stock' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id,
    quantity: 3, reasonCode: 'opening' });
  investigations.create(db, workspace.workspaceId, {
    trigger: 'business_consistency_inventory-cost-coverage',
    affectedEntities: { workspaceId: workspace.workspaceId, consistencyKey: 'inventory-cost-coverage' },
    observedDifference: { oldClassification: true },
  });

  const entries = needsYouInbox.inbox(db, workspace.workspaceId);
  assert.equal(entries.some((entry) => entry.title === 'Every unit on hand has purchase-cost evidence'), false);
  assert.equal(entries.some((entry) => entry.href === '/accounting#inventory'
    && entry.actionLabel === 'Resolve the difference'), false);
  assert.equal(investigations.list(db, workspace.workspaceId,
    { statuses: ['OPEN','NEEDS_HUMAN','INCONCLUSIVE'] })
    .some((entry) => entry.trigger === 'business_consistency_inventory-cost-coverage'), false);
});

test('unified state is workspace isolated', () => {
  const { db } = makeDatabase();
  const first = seedWorkspace(db);
  const second = seedAnotherWorkspace(db, first.accountId, 'Separate Company');
  automatic.ensure(db, first.workspaceId, { actorId: first.ownerId });
  automatic.ensure(db, second.workspaceId, { actorId: second.ownerId });
  const item = makeQuantityItem(db, first.ctx, { name: 'Only First Owns This' });
  inventory.receive(db, first.ctx, { skuId: item.skuId, locationId: first.main.id,
    quantity: 17, reasonCode: 'opening' });
  assert.equal(brain.build(db, first.workspaceId).inventory.onHand, 17);
  assert.equal(brain.build(db, second.workspaceId).inventory.onHand, 0);
});

test('cross-business questions route deterministically and answer from one state', async () => {
  const cases = [
    ['How are we doing?', 'business_health'],
    ['Why are we low on cash?', 'cash_pressure'],
    ['Which customer orders are at risk?', 'customer_orders_at_risk'],
    ["Do we have enough stock to cover this week's customer orders?", 'stock_coverage'],
    ['Which suppliers are causing problems?', 'supplier_risk'],
    ['What is likely to need attention next?', 'next_attention'],
  ];
  for (const [question, intent] of cases) assert.equal((await planner.plan(question)).intent, intent);

  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  automatic.ensure(db, workspace.workspaceId, { actorId: workspace.ownerId });
  const result = queries.execute(db, workspace.workspaceId, { intent: 'business_health' });
  assert.equal(result.supported, true);
  assert.match(result.answer, /internally consistent/i);
  assert.ok(result.rows.some((row) => row.measure === 'Available now'));
});

test('why Foundry ordered a PO is answered from the linked purchasing story', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  automatic.ensure(db, workspace.workspaceId, { actorId: workspace.ownerId });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Shirt' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'ABC Apparel' });
  suppliers.linkItem(db, workspace.ctx, membership, { supplierId: supplier.id, skuId: item.skuId,
    supplierSku: 'ABC-BLK', purchaseUnit: 'case', unitsPerPurchaseUnit: 12,
    minimumOrderQuantity: 1, orderMultiple: 1, leadTimeDays: 7, lastUnitCost: 6 });
  const order = purchaseOrders.createOrder(db, workspace.ctx, membership, {
    supplierId: supplier.id, lines: [{ skuId: item.skuId, quantityPurchaseUnits: 2 }],
  });
  const question = `Why did Foundry order ${order.poNumber}?`;
  const planned = await planner.plan(question);
  assert.equal(planned.intent, 'foundry_why');
  const result = queries.execute(db, workspace.workspaceId, planned);
  assert.match(result.answer, new RegExp(order.poNumber));
  assert.match(result.answer, /24 units/);
  assert.equal(result.handoff.href, `/purchasing/orders/${order.id}`);
  assert.deepEqual(result.rows.map((row) => row.measure), [
    'What happened', 'Why Foundry concluded this', 'Evidence used', 'What Foundry did', 'What happens next',
  ]);
});

test('backup is actually restored and critical record counts match', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Restore Proof' });
  inventory.receive(store.db, workspace.ctx, { skuId: item.skuId,
    locationId: workspace.main.id, quantity: 9, reasonCode: 'opening' });
  const backupDir = path.join(store.dir, 'backups');
  const created = await backups.create(store.db, { directory: backupDir, retentionDays: 7 });
  const restoredPath = path.join(store.dir, 'restored', 'keeper.sqlite');
  const restored = backups.restoreTo(created.path, restoredPath);
  assert.equal(created.verification.ok, true);
  assert.equal(restored.restored.ok, true);
  assert.equal(restored.restored.workspaceCount, 1);
  assert.equal(restored.restored.movementCount, 1);
  assert.ok(fs.existsSync(`${created.path}.json`));
});

test('workspace export is isolated and excludes authentication and OAuth secrets', () => {
  const { db } = makeDatabase();
  const first = seedWorkspace(db, { workspaceName: 'Exported Company' });
  const second = seedAnotherWorkspace(db, first.accountId, 'Private Other Company');
  makeQuantityItem(db, second.ctx, { name: 'Must Not Cross Workspaces' });
  const exported = workspaceExport.build(db, first.workspaceId);
  const text = JSON.stringify(exported);
  assert.equal(exported.workspace.name, 'Exported Company');
  assert.equal(exported.records.connection_credentials, undefined);
  assert.equal(exported.records.connection_authorization_states, undefined);
  assert.doesNotMatch(text, /password_hash|Must Not Cross Workspaces|Private Other Company/);
  assert.match(exported.integrity.digest, /^[a-f0-9]{64}$/);
});

test('request limiter returns a recoverable 429 after the configured boundary', () => {
  const limit = middleware.rateLimit({ max: 2, windowMs: 60_000 });
  const calls = [];
  const response = () => ({
    headers: {}, statusCode: 200,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { calls.push({ code: this.statusCode, body, headers: this.headers }); return this; },
  });
  for (let index = 0; index < 3; index += 1) limit({ ip: '127.0.0.1', socket: {} }, response(), () => calls.push({ code: 200 }));
  assert.deepEqual(calls.map((call) => call.code), [200, 200, 429]);
  assert.equal(calls[2].body.error.code, 'rate_limited');
});
