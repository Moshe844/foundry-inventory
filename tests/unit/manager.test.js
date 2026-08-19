'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const inventory = require('../../src/domain/inventory-engine');
const investigations = require('../../src/manager/investigations');
const triggers = require('../../src/manager/triggers');
const intentRouter = require('../../src/manager/intent-router');
const context = require('../../src/manager/context');
const brief = require('../../src/manager/brief');
const physicalEvents = require('../../src/manager/physical-events');
const documentEvents = require('../../src/manager/document-events');
const reconciliation = require('../../src/manager/reconciliation');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const authService = require('../../src/domain/auth-service');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Manager Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Filter Cartridge' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 20 });
  return { db, workspace, item, membership };
}

test('a physical discrepancy becomes a durable evidence-backed investigation, never an automatic adjustment', () => {
  const env = setup();
  const opened = investigations.openPhysicalCount(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, countedQuantity: 17,
  });
  const result = investigations.investigate(env.db, env.workspace.workspaceId, opened.investigation.investigationId);
  assert.equal(result.status, 'NEEDS_HUMAN');
  assert.equal(result.observedDifference.expected, 20);
  assert.equal(result.observedDifference.observed, 17);
  assert.equal(result.unexplainedAmount, 3);
  assert.match(result.recommendedNextStep, /Recount/);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM adjustments WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 0);
  env.db.close();
});

test('manager triggers are idempotent and return to pending after a restart', () => {
  const env = setup();
  const first = triggers.enqueue(env.db, env.workspace.workspaceId, 'movement', { skuIds: [env.item.skuId] }, { now: 1000 });
  const second = triggers.enqueue(env.db, env.workspace.workspaceId, 'movement', { skuIds: [env.item.skuId] }, { now: 1000 });
  assert.equal(first.trigger.id, second.trigger.id);
  assert.equal(triggers.claimNext(env.db).status, 'RUNNING');
  assert.equal(triggers.recover(env.db), 1);
  assert.equal(triggers.list(env.db, env.workspace.workspaceId, { statuses: 'PENDING' }).length, 1);
  env.db.close();
});

test('typed manager intent uses durable context and refuses invented references', async () => {
  const env = setup();
  context.remember(env.db, env.workspace.ctx, { investigationId: null, entities: { skuId: env.item.skuId } });
  const result = await intentRouter.classify(env.db, env.workspace.ctx, 'Why is that one wrong?', {
    provider: fakeProvider({ intentClass: 'INVESTIGATION_REQUEST', confidence: 'medium',
      reason: 'It asks about a discrepancy.', resolvedReference: 'made_up', clarifyingQuestion: '' }),
  });
  assert.equal(result.intentClass, 'INVESTIGATION_REQUEST');
  assert.equal(result.resolvedReference, '');
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM manager_intents WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1);
  env.db.close();
});

test('obvious manager commands still route when the model provider is unavailable', async () => {
  const env = setup();
  const unavailable = { complete: async () => { throw new Error('provider offline'); } };
  const purchasing = await intentRouter.classify(env.db, env.workspace.ctx, 'Order what we need', { provider: unavailable });
  const policy = await intentRouter.classify(env.db, env.workspace.ctx, 'Handle everything you safely can', { provider: unavailable });
  assert.equal(purchasing.intentClass, 'PURCHASING_REQUEST');
  assert.equal(policy.intentClass, 'POLICY_CHANGE');
  assert.equal(purchasing.clarifyingQuestion, '');
  env.db.close();
});

test('a healthy brief creates no operational busywork and names the missing external input', () => {
  const env = setup();
  const result = brief.build(env.db, env.workspace.workspaceId);
  assert.deepEqual(result.handling, []);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM work_items').get().n, 0);
  assert.equal(result.needsYou.length, 1);
  assert.equal(result.needsYou[0].type, 'operating_input');
  assert.match(result.needsYou[0].reason, /no live sales or warehouse feed/);
  assert.match(result.summary, /1 item needs your decision/);
  env.db.close();
});

test('a natural physical count resolves only real workspace records and opens the discrepancy investigation', async () => {
  const env = setup();
  const event = await physicalEvents.recordNatural(env.db, env.workspace.ctx,
    'The physical count for Filter Cartridge at Main Warehouse is 17', {
      provider: fakeProvider({ eventType: 'physical_count', skuId: env.item.skuId,
        locationId: env.workspace.main.id, countedQuantity: 17, reason: 'Exact product, location and count were stated.' }),
    });
  assert.equal(event.status, 'NEEDS_HUMAN');
  const investigation = investigations.get(env.db, env.workspace.workspaceId, event.investigationId);
  assert.equal(investigation.observedDifference.expected, 20);
  assert.equal(investigation.observedDifference.observed, 17);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM adjustments WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 0);
  env.db.close();
});

test('resolving a physical-count investigation removes its source event from Needs you', async () => {
  const env = setup();
  const event = await physicalEvents.recordNatural(env.db, env.workspace.ctx,
    'I counted 17 Filter Cartridge at Main Warehouse');
  assert.equal(event.status, 'NEEDS_HUMAN');

  const resolved = investigations.resolve(env.db, env.workspace.ctx, event.investigationId,
    'A second count confirmed the physical quantity.');

  assert.equal(resolved.investigation.status, 'RESOLVED');
  assert.equal(resolved.completedPhysicalEvents, 1);
  assert.equal(physicalEvents.get(env.db, env.workspace.workspaceId, event.id).status, 'COMPLETED');
  assert.equal(env.db.prepare(
    "SELECT COUNT(*) AS n FROM physical_events WHERE workspace_id = ? AND status = 'NEEDS_HUMAN'"
  ).get(env.workspace.workspaceId).n, 0);
  env.db.close();
});

test('an explicit natural count does not need a model provider', async () => {
  const env = setup();
  const unavailable = { complete: async () => { throw new Error('provider offline'); } };
  const event = await physicalEvents.recordNatural(env.db, env.workspace.ctx,
    'I counted 17 Filter Cartridge at Main Warehouse', { provider: unavailable });
  assert.equal(event.eventType, 'physical_count');
  assert.equal(event.status, 'NEEDS_HUMAN');
  const investigation = investigations.get(env.db, env.workspace.workspaceId, event.investigationId);
  assert.equal(investigation.observedDifference.observed, 17);
  assert.equal(investigation.affectedEntities.skuId, env.item.skuId);
  env.db.close();
});

test('an investigation accounts for a concrete duplicate-reference lead and leaves the remainder honest', () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id,
    quantity: 3, reference: 'DELIVERY-77' });
  inventory.receive(env.db, env.workspace.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id,
    quantity: 3, reference: 'DELIVERY-77' });
  const opened = investigations.openPhysicalCount(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, countedQuantity: 23,
  });
  const result = investigations.investigate(env.db, env.workspace.workspaceId, opened.investigation.investigationId);
  assert.equal(result.explainedAmount, 3);
  assert.equal(result.unexplainedAmount, 0);
  assert.ok(result.evidenceFor.some((entry) => entry.kind === 'possible_duplicate_movement'));
  assert.equal(result.status, 'NEEDS_HUMAN', 'a likely explanation never adjusts the count automatically');
  env.db.close();
});

test('an investigation request without a measured count is inconclusive rather than falsely resolved', () => {
  const env = setup();
  const created = investigations.create(env.db, env.workspace.workspaceId, {
    trigger: 'operator_request', affectedEntities: {}, observedDifference: { statedAs: 'Why is this wrong?' },
    recommendedNextStep: 'Name the product, location and count.',
  });
  const result = investigations.investigate(env.db, env.workspace.workspaceId, created.investigation.investigationId);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.resolvedAt, null);
  env.db.close();
});

test('a receiving document matches one open order from supplier and line evidence', () => {
  const env = setup();
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, env.membership, { name: 'ABC Supply' });
  supplierService.linkItem(env.db, env.workspace.ctx, env.membership, { supplierId: supplier.id,
    skuId: env.item.skuId, supplierSku: 'FC-100', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
    lastUnitCost: 4.5, isPreferred: true });
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, { supplierId: supplier.id,
    destinationLocationId: env.workspace.main.id, lines: [{ skuId: env.item.skuId, quantityUnits: 12 }] });
  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id, { expectedHash: order.integrityHash, markOrdered: true });
  const match = documentEvents.matchPurchaseOrder(env.db, env.workspace.workspaceId, {
    documentNumber: 'DEL-900', supplierName: 'ABC Supply', destinationName: 'Main Warehouse',
    lines: [{ styleName: 'Filter Cartridge', color: '', size: '', supplierSku: 'FC-100', quantity: 12 }],
  });
  assert.equal(match.matched, true);
  assert.equal(match.purchaseOrderId, order.id);
  assert.deepEqual(match.receiptLines.map((line) => line.quantityUnits), [12]);
  env.db.close();
});

test('future vendor documents receive remembered code vocabulary and learn newly observed wording', async () => {
  const env = setup();
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, env.membership, {
    name: 'ABC Supply', itemCodeLabel: 'Style #', itemCodeAliases: ['Vendor Item No.'],
  });
  supplierService.linkItem(env.db, env.workspace.ctx, env.membership, { supplierId: supplier.id,
    skuId: env.item.skuId, supplierSku: 'FC-100', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
    lastUnitCost: 4.5, isPreferred: true });
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, { supplierId: supplier.id,
    destinationLocationId: env.workspace.main.id, lines: [{ skuId: env.item.skuId, quantityUnits: 12 }] });
  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id,
    { expectedHash: order.integrityHash, markOrdered: true });
  const provider = fakeProvider({
    documentType: 'invoice', businessDescription: 'ABC Supply delivered Filter Cartridge inventory.', unitLabel: 'unit',
    supplierName: 'ABC Supply', supplierCodeLabel: 'Catalogue Ref', supplierEmail: '', documentNumber: 'DEL-901',
    documentDate: '2026-08-17', paymentTerms: '', currency: 'USD', destinationName: 'Main Warehouse',
    destinationAddress: '', lines: [{ styleName: 'Filter Cartridge', color: '', variantDimension: '', size: '',
      supplierSku: 'FC-100', description: 'Filter Cartridge', quantity: 12, unitCost: 4.5 }], warnings: [],
  });
  const understood = await documentEvents.understand(env.db, env.workspace.ctx, {
    filename: 'delivery.txt', buffer: Buffer.from('ABC Supply Catalogue Ref FC-100 quantity 12 to Main Warehouse'),
  }, { provider });
  assert.equal(understood.match.purchaseOrderId, order.id);
  assert.equal(understood.match.preferredItemCodeLabel, 'Style #');
  assert.match(provider.calls[0].prompt, /preferredItemCodeLabel":"Style #/);
  assert.match(provider.calls[0].prompt, /Vendor Item No\./);
  assert.ok(supplierService.getSupplier(env.db, env.workspace.workspaceId, supplier.id)
    .itemCodeAliases.includes('Catalogue Ref'));
  env.db.close();
});

test('manager reconciliation includes whole-inventory ledger, lot and serial integrity', () => {
  const env = setup();
  const result = reconciliation.scanWorkspace(env.db, env.workspace.workspaceId);
  assert.ok(result.records.some((entry) => entry.kind === 'inventory_integrity' && entry.status === 'VERIFIED'));
  assert.equal(result.failed, 0);
  env.db.close();
});
