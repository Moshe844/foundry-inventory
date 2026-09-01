'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const openingBalances = require('../../src/accounting/opening-balances');
const costing = require('../../src/accounting/costing');
const inventory = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

test('opening balances require full review, match physical quantity, and do not replay old operations', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const product = makeQuantityItem(db, workspace.ctx, { name: 'Opening Shirt' });
  inventory.receive(db, workspace.ctx, {
    skuId: product.skuId, locationId: workspace.main.id, quantity: 80,
    occurredAt: '2025-12-01', reference: 'HISTORIC-STOCK',
  });
  ledger.ensureDefaultChart(db, workspace.workspaceId);
  const inventoryAccount = ledger.accountBySystemKey(db, workspace.workspaceId, 'INVENTORY_ASSET');
  const cashAccount = ledger.accountBySystemKey(db, workspace.workspaceId, 'CASH');
  const equityAccount = ledger.accountBySystemKey(db, workspace.workspaceId, 'OPENING_BALANCE_EQUITY');
  assert.throws(() => openingBalances.prepare(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD',
    lines: [
      { accountId: inventoryAccount.id, debitMinor: 63_999 },
      { accountId: equityAccount.id, creditMinor: 63_999 },
    ],
    inventory: [{ skuId: product.skuId, locationId: workspace.main.id,
      quantityUnits: 80, totalCostMinor: 64_000 }],
  }), /inventory detail totals/i);
  const review = openingBalances.prepare(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
    sourceDescription: 'Balances approved by owner at conversion',
    lines: [
      { accountId: cashAccount.id, debitMinor: 5_000_000 },
      { accountId: inventoryAccount.id, debitMinor: 64_000 },
      { accountId: equityAccount.id, creditMinor: 5_064_000 },
    ],
    inventory: [{ skuId: product.skuId, locationId: workspace.main.id,
      quantityUnits: 80, totalCostMinor: 64_000 }],
  });
  assert.equal(ledger.settings(db, workspace.workspaceId).enabled, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0);
  assert.throws(() => openingBalances.approve(db, workspace.ctx, membership, review.id, 'wrong-hash'), /changed since review/i);
  const approved = openingBalances.approve(db, workspace.ctx, membership, review.id, review.integrity_hash);
  assert.equal(approved.opening.status, 'POSTED');
  assert.equal(ledger.settings(db, workspace.workspaceId).startDate, '2026-01-01');
  assert.equal(costing.valuation(db, workspace.workspaceId).totalUnits, 80);
  assert.equal(costing.valuation(db, workspace.workspaceId).totalCostMinor, 64_000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_event_inbox').get().n, 0);
  assert.equal(openingBalances.approve(db, workspace.ctx, membership, review.id, review.integrity_hash).replayed, true);
});
