'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const costing = require('../../src/accounting/costing');
const reports = require('../../src/accounting/reports');
const refunds = require('../../src/accounting/refunds');
const payables = require('../../src/accounting/payables');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/inventory-engine');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const reactions = require('../../src/manager/reactions');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Accounting Controls Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const product = makeQuantityItem(db, workspace.ctx, { name: 'Returnable Product' });
  return { db, workspace, membership, product };
}

function seedValuedStock(env, quantity = 10, unitCostMinor = 800) {
  const received = inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.product.skuId, locationId: env.workspace.main.id, quantity,
    reference: 'OPENING-STOCK', occurredAt: '2026-01-01',
  });
  costing.receive(env.db, env.workspace.ctx, { movementIds: received.movementIds,
    unitCostMinor, sourceType: 'opening_balance', sourceRecordId: 'opening-stock' });
  ledger.post(env.db, env.workspace.ctx, {
    postingDate: '2026-01-01', description: 'Opening stock', sourceKey: 'opening-stock',
    lines: [
      { accountKey: 'INVENTORY_ASSET', debitMinor: quantity * unitCostMinor },
      { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: quantity * unitCostMinor },
    ],
  });
}

test('a refund reverses revenue/tax once and restores COGS only with physical-return evidence', () => {
  const env = setup();
  seedValuedStock(env);
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.product.skuId, amount: '20.00', currency: 'USD' });
  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Refund Customer', fulfillmentLocationId: env.workspace.main.id,
    tax: '2.00', lines: [{ skuId: env.product.skuId, quantity: 2 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  sales.fulfill(env.db, env.workspace.ctx, order.id, { lines: [{ lineId: order.lines[0].id,
    locationId: env.workspace.main.id, quantity: 2 }] }, { idempotencyKey: 'refund-sale-fulfill' });
  const saleEntry = env.db.prepare(`SELECT * FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_type = 'sales_fulfillment'`).get(env.workspace.workspaceId);
  const returned = inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.product.skuId, locationId: env.workspace.main.id, quantity: 1,
    reasonCode: 'customer_return', reference: 'RETURN-1', occurredAt: '2026-01-04',
  });
  const first = refunds.refundSale(env.db, env.workspace.ctx, env.membership, {
    originalJournalEntryId: saleEntry.id, refundDate: '2026-08-31', reference: 'RETURN-1',
    revenueMinor: 2_000, taxMinor: 100, cogsMinor: 800, physicalReturn: true,
    movementIds: returned.movementIds, destination: 'AR', sourceKey: 'refund-provider-1',
  });
  const replay = refunds.refundSale(env.db, env.workspace.ctx, env.membership, {
    originalJournalEntryId: saleEntry.id, refundDate: '2026-08-31',
    revenueMinor: 2_000, taxMinor: 100, cogsMinor: 800, physicalReturn: true,
    movementIds: returned.movementIds, destination: 'AR', sourceKey: 'refund-provider-1',
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalUnits, 9);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 7_200);
  const pnl = reports.profitAndLoss(env.db, env.workspace.workspaceId,
    { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pnl.revenueMinor, 2_000);
  assert.equal(pnl.cogsMinor, 800);
  assert.equal(pnl.grossProfitMinor, 1_200);
  assert.equal(reports.inventoryReconciliation(env.db, env.workspace.workspaceId,
    { asOf: '2026-12-31' }).reconciled, true);
  assert.throws(() => refunds.refundSale(env.db, env.workspace.ctx, env.membership, {
    originalJournalEntryId: saleEntry.id, revenueMinor: 2_001, taxMinor: 100,
    destination: 'AR', sourceKey: 'refund-too-large',
  }), /exceeds the unrefunded amount/i);
});

test('a financial refund alone never invents a physical return or reverses COGS', () => {
  const env = setup();
  seedValuedStock(env, 2, 500);
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.product.skuId, amount: '15.00', currency: 'USD' });
  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Financial Refund Customer', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: env.product.skuId, quantity: 1 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  sales.fulfill(env.db, env.workspace.ctx, order.id, {}, { idempotencyKey: 'financial-refund-sale' });
  const saleEntry = env.db.prepare(`SELECT * FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_type = 'sales_fulfillment'`).get(env.workspace.workspaceId);
  refunds.refundSale(env.db, env.workspace.ctx, env.membership, {
    originalJournalEntryId: saleEntry.id, refundDate: '2026-08-31', revenueMinor: 1_500,
    taxMinor: 0, cogsMinor: 0, physicalReturn: false, destination: 'CASH', sourceKey: 'cash-refund-1',
  });
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalUnits, 1);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 500);
  const pnl = reports.profitAndLoss(env.db, env.workspace.workspaceId,
    { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pnl.revenueMinor, 0);
  assert.equal(pnl.cogsMinor, 500, 'no physical return means COGS remains recognized');
});

test('one invoice across partial receipts establishes AP detail without recognizing inventory twice', () => {
  const env = setup();
  const supplier = suppliers.createSupplier(env.db, env.workspace.ctx, env.membership, {
    name: 'Partial Receipt Supplier', priceTolerancePercent: 5,
  });
  suppliers.linkItem(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.product.skuId, supplierSku: 'RETURNABLE-1',
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 8,
  });
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: env.product.skuId, quantityUnits: 100, unitCost: 8 }],
  });
  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id);
  receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: 'partial-receipt-a', lines: [{ lineId: order.lines[0].id, quantityUnits: 40 }],
  });
  receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: 'partial-receipt-b', lines: [{ lineId: order.lines[0].id, quantityUnits: 60 }],
  });
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);
  const draft = payables.createDraft(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, purchaseOrderId: order.id, supplierInvoiceNumber: 'PARTIAL-100',
    issueDate: '2026-08-31', sourceKey: 'supplier-invoice:partial-100',
    lines: [{ description: 'Returnable Product', quantity: 100, unitCostMinor: 800,
      skuId: env.product.skuId, purchaseOrderLineId: order.lines[0].id }],
  });
  const bill = payables.open(env.db, env.workspace.ctx, env.membership, draft.bill.id);
  assert.equal(bill.status, 'OPEN');
  assert.equal(bill.match_status, 'MATCHED');
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_type IN ('purchase_receipt','supplier_bill')`)
    .get(env.workspace.workspaceId).n, 3,
    'two receipts establish physical inventory and the separate invoice establishes AP');
  const receiptAp = env.db.prepare(`SELECT COALESCE(SUM(jl.credit_minor - jl.debit_minor), 0) AS n
    FROM accounting_journal_entries je
    JOIN accounting_journal_lines jl ON jl.entry_id = je.id
    JOIN accounting_accounts a ON a.id = jl.account_id
    WHERE je.workspace_id = ? AND je.source_type = 'purchase_receipt'
      AND a.system_key = 'ACCOUNTS_PAYABLE'`).get(env.workspace.workspaceId).n;
  assert.equal(receiptAp, 0, 'physical receiving alone never creates an invoice balance');
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 80_000);
  const controls = reports.controlReconciliation(env.db, env.workspace.workspaceId, { asOf: '2026-12-31' });
  assert.equal(controls.ap.controlMinor, 80_000);
  assert.equal(controls.ap.subledgerMinor, 80_000);
  assert.equal(controls.ap.reconciled, true);
  assert.throws(() => payables.createDraft(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, supplierInvoiceNumber: 'PARTIAL-100', issueDate: '2026-08-31',
    sourceKey: 'supplier-invoice:duplicate',
    lines: [{ description: 'Duplicate', quantity: 1, unitCostMinor: 800 }],
  }), /already recorded/i);
});
