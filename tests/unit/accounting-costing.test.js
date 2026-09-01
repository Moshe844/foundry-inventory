'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const costing = require('../../src/accounting/costing');
const inventory = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const product = makeQuantityItem(db, workspace.ctx, { name: 'Black Shirt', unitLabel: 'shirt' });
  return { db, workspace, product };
}

test('moving weighted average produces exact COGS and never leaves value at zero quantity', () => {
  const { db, workspace, product } = setup();
  const first = inventory.receive(db, workspace.ctx, {
    skuId: product.skuId, locationId: workspace.main.id, quantity: 100,
    reference: 'PO-1', occurredAt: '2026-01-02',
  });
  costing.receive(db, workspace.ctx, {
    movementIds: first.movementIds, unitCostMinor: 800,
    sourceType: 'purchase_receipt', sourceRecordId: 'receipt-1',
  });
  const second = inventory.receive(db, workspace.ctx, {
    skuId: product.skuId, locationId: workspace.main.id, quantity: 100,
    reference: 'PO-2', occurredAt: '2026-01-03',
  });
  costing.receive(db, workspace.ctx, {
    movementIds: second.movementIds, unitCostMinor: 1200,
    sourceType: 'purchase_receipt', sourceRecordId: 'receipt-2',
  });
  assert.deepEqual(
    { quantity: costing.state(db, workspace.workspaceId, product.skuId, workspace.main.id).quantity_units,
      cost: costing.state(db, workspace.workspaceId, product.skuId, workspace.main.id).total_cost_minor },
    { quantity: 200, cost: 200_000 }
  );

  const sold = inventory.issue(db, workspace.ctx, {
    skuId: product.skuId, locationId: workspace.main.id, quantity: 20,
    reasonCode: 'sold', reference: 'SO-1', occurredAt: '2026-01-04',
  });
  const issued = costing.issue(db, workspace.ctx, {
    movementIds: sold.movementIds, sourceType: 'sale', sourceRecordId: 'SO-1',
  });
  assert.equal(issued.totalCostMinor, 20_000);
  assert.equal(costing.state(db, workspace.workspaceId, product.skuId, workspace.main.id).quantity_units, 180);
  assert.equal(costing.state(db, workspace.workspaceId, product.skuId, workspace.main.id).total_cost_minor, 180_000);

  const rest = inventory.issue(db, workspace.ctx, {
    skuId: product.skuId, locationId: workspace.main.id, quantity: 180,
    reasonCode: 'sold', reference: 'SO-2', occurredAt: '2026-01-05',
  });
  assert.equal(costing.issue(db, workspace.ctx, {
    movementIds: rest.movementIds, sourceType: 'sale', sourceRecordId: 'SO-2',
  }).totalCostMinor, 180_000);
  assert.equal(costing.state(db, workspace.workspaceId, product.skuId, workspace.main.id).quantity_units, 0);
  assert.equal(costing.state(db, workspace.workspaceId, product.skuId, workspace.main.id).total_cost_minor, 0);
});

test('transfers carry value between locations without creating or destroying it', () => {
  const { db, workspace, product } = setup();
  const receipt = inventory.receive(db, workspace.ctx, {
    skuId: product.skuId, locationId: workspace.main.id, quantity: 100,
    reference: 'PO-1', occurredAt: '2026-01-02',
  });
  costing.receive(db, workspace.ctx, {
    movementIds: receipt.movementIds, unitCostMinor: 801,
    sourceType: 'purchase_receipt', sourceRecordId: 'receipt-1',
  });
  const moved = inventory.transfer(db, workspace.ctx, {
    skuId: product.skuId, fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id, quantity: 30,
    reference: 'TRANSFER-1', occurredAt: '2026-01-03',
  });
  const result = costing.transfer(db, workspace.ctx, {
    movementIds: moved.movementIds, sourceType: 'inventory_transfer', sourceRecordId: moved.groupId,
  });
  assert.equal(result.totalCostMinor, 24_030);
  assert.equal(costing.state(db, workspace.workspaceId, product.skuId, workspace.main.id).total_cost_minor, 56_070);
  assert.equal(costing.state(db, workspace.workspaceId, product.skuId, workspace.store.id).total_cost_minor, 24_030);
  assert.equal(costing.valuation(db, workspace.workspaceId).totalCostMinor, 80_100);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0);
});

test('costing is idempotent and refuses to guess a missing opening cost', () => {
  const { db, workspace, product } = setup();
  const receipt = inventory.receive(db, workspace.ctx, {
    skuId: product.skuId, locationId: workspace.main.id, quantity: 2,
    occurredAt: '2026-01-02',
  });
  const input = { movementIds: receipt.movementIds, unitCostMinor: 500,
    sourceType: 'purchase_receipt', sourceRecordId: 'receipt-1' };
  assert.equal(costing.receive(db, workspace.ctx, input).replayed, false);
  assert.equal(costing.receive(db, workspace.ctx, input).replayed, true);
  assert.equal(costing.valuation(db, workspace.workspaceId).totalCostMinor, 1000);

  const uncosted = makeQuantityItem(db, workspace.ctx, { name: 'Uncosted Item' });
  inventory.receive(db, workspace.ctx, {
    skuId: uncosted.skuId, locationId: workspace.main.id, quantity: 1,
    occurredAt: '2026-01-02',
  });
  const issue = inventory.issue(db, workspace.ctx, {
    skuId: uncosted.skuId, locationId: workspace.main.id, quantity: 1,
    reasonCode: 'sold', occurredAt: '2026-01-03',
  });
  assert.throws(() => costing.issue(db, workspace.ctx, {
    movementIds: issue.movementIds, sourceType: 'sale', sourceRecordId: 'sale-uncosted',
  }), /before its opening or receipt cost was established/i);
});
