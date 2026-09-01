'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const reports = require('../../src/accounting/reports');
const costing = require('../../src/accounting/costing');
const payables = require('../../src/accounting/payables');
const payments = require('../../src/accounting/payments');
const refunds = require('../../src/accounting/refunds');
const supplierCredits = require('../../src/accounting/supplier-credits');
const ownerDashboard = require('../../src/accounting/owner-dashboard');
const operational = require('../../src/accounting/operational-adapter');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/inventory-engine');
const auth = require('../../src/domain/auth-service');
const events = require('../../src/manager/events');
const reactions = require('../../src/manager/reactions');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

test('Mission 14 owner accounting proves all twenty required lifecycle scenarios', async (t) => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Twenty Lifecycle Company' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-09-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  ledger.post(db, workspace.ctx, { postingDate: '2026-09-01', description: 'Opening cash',
    sourceKey: 'twenty-opening-cash', lines: [{ accountKey: 'CASH', debitMinor: 500_000 },
      { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: 500_000 }] });
  const product = makeQuantityItem(db, workspace.ctx, { name: 'Lifecycle Shirt', baseCode: 'LIFE-SHIRT' });
  prices.setPrice(db, workspace.ctx, { skuId: product.skuId, amount: '20.00', currency: 'USD' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'Lifecycle Supply' });
  suppliers.linkItem(db, workspace.ctx, membership, { supplierId: supplier.id, skuId: product.skuId,
    supplierSku: 'LIFE-1', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 10 });
  const dashboard = () => ownerDashboard.ownerDashboard(db, workspace.workspaceId,
    { from: '2026-09-01', to: '2026-09-30', asOf: '2026-09-30' });

  let po; let bill; let order; let invoice; let saleEntry;
  await t.test('01 PO created but nothing received', () => {
    po = purchaseOrders.createOrder(db, workspace.ctx, membership, { supplierId: supplier.id,
      destinationLocationId: workspace.main.id,
      lines: [{ skuId: product.skuId, quantityUnits: 100, unitCost: 10 }] });
    po = purchaseOrders.approve(db, workspace.ctx, membership, po.id);
    assert.deepEqual({ ordered: po.orderedUnits, received: po.receivedUnits }, { ordered: 100, received: 0 });
  });
  await t.test('02 partial inventory receipt', () => {
    receiving.receive(db, workspace.ctx, membership, po.id, { idempotencyKey: 'life-receive-60',
      lines: [{ lineId: po.lines[0].id, quantityUnits: 60 }] }); reactions.drainWorkspace(db, workspace.workspaceId);
    po = purchaseOrders.get(db, workspace.workspaceId, po.id);
    assert.deepEqual({ received: po.receivedUnits, expected: po.outstandingUnits }, { received: 60, expected: 40 });
  });
  await t.test('03 full inventory receipt', () => {
    receiving.receive(db, workspace.ctx, membership, po.id, { idempotencyKey: 'life-receive-40',
      lines: [{ lineId: po.lines[0].id, quantityUnits: 40 }] }); reactions.drainWorkspace(db, workspace.workspaceId);
    po = purchaseOrders.get(db, workspace.workspaceId, po.id);
    assert.equal(po.status, 'RECEIVED'); assert.equal(po.outstandingUnits, 0);
  });
  await t.test('04 inventory received but supplier invoice missing', () => {
    const missing = dashboard().missingBills;
    assert.equal(missing.length, 1); assert.equal(missing[0].receivedCostMinor, 100_000);
  });
  await t.test('05 supplier invoice entered but unpaid', () => {
    const draft = payables.createDraft(db, workspace.ctx, membership, { supplierId: supplier.id,
      purchaseOrderId: po.id, supplierInvoiceNumber: 'LIFE-INV-1', issueDate: '2026-09-02',
      dueDate: '2026-09-20', sourceKey: 'life-bill-1', lines: [{ description: '100 Lifecycle Shirts',
        quantity: 100, unitCostMinor: 1000, itemId: product.itemId, skuId: product.skuId,
        purchaseOrderLineId: po.lines[0].id }] });
    bill = payables.open(db, workspace.ctx, membership, draft.bill.id);
    assert.equal(bill.status, 'OPEN'); assert.equal(bill.balance_minor, 100_000);
  });
  await t.test('06 supplier invoice partially paid', () => {
    payments.record(db, workspace.ctx, membership, { direction: 'SUPPLIER_PAYMENT',
      supplierId: supplier.id, paymentDate: '2026-09-03', amountMinor: 40_000,
      sourceKey: 'life-supplier-pay-1', allocations: [{ billId: bill.id, amountMinor: 40_000 }] });
    bill = payables.requireBill(db, workspace.workspaceId, bill.id);
    assert.equal(bill.status, 'PARTIALLY_PAID'); assert.equal(bill.balance_minor, 60_000);
  });
  await t.test('07 supplier invoice fully paid', () => {
    payments.record(db, workspace.ctx, membership, { direction: 'SUPPLIER_PAYMENT',
      supplierId: supplier.id, paymentDate: '2026-09-04', amountMinor: 60_000,
      sourceKey: 'life-supplier-pay-2', allocations: [{ billId: bill.id, amountMinor: 60_000 }] });
    bill = payables.requireBill(db, workspace.workspaceId, bill.id);
    assert.equal(bill.status, 'PAID'); assert.equal(bill.balance_minor, 0);
  });
  await t.test('08 customer order completed but unpaid', () => {
    order = sales.createOrder(db, workspace.ctx, { customerName: 'Lifecycle Customer',
      fulfillmentLocationId: workspace.main.id, lines: [{ skuId: product.skuId, quantity: 10 }] });
    order = sales.confirm(db, workspace.ctx, order.id);
    sales.fulfill(db, workspace.ctx, order.id, {}, { idempotencyKey: 'life-sale-1' });
    reactions.drainWorkspace(db, workspace.workspaceId);
    invoice = db.prepare(`SELECT * FROM accounting_customer_invoices
      WHERE workspace_id = ? AND sales_order_id = ?`).get(workspace.workspaceId, order.id);
    assert.equal(invoice.status, 'OPEN'); assert.equal(invoice.balance_minor, 20_000);
  });
  await t.test('09 customer partially pays', () => {
    payments.record(db, workspace.ctx, membership, { direction: 'CUSTOMER_RECEIPT',
      customerId: invoice.customer_id, paymentDate: '2026-09-05', amountMinor: 5_000,
      sourceKey: 'life-customer-pay-1', allocations: [{ invoiceId: invoice.id, amountMinor: 5_000 }] });
    invoice = db.prepare('SELECT * FROM accounting_customer_invoices WHERE id = ?').get(invoice.id);
    assert.equal(invoice.status, 'PARTIALLY_PAID'); assert.equal(invoice.balance_minor, 15_000);
  });
  await t.test('10 customer fully pays', () => {
    payments.record(db, workspace.ctx, membership, { direction: 'CUSTOMER_RECEIPT',
      customerId: invoice.customer_id, paymentDate: '2026-09-06', amountMinor: 15_000,
      sourceKey: 'life-customer-pay-2', allocations: [{ invoiceId: invoice.id, amountMinor: 15_000 }] });
    invoice = db.prepare('SELECT * FROM accounting_customer_invoices WHERE id = ?').get(invoice.id);
    assert.equal(invoice.status, 'PAID'); assert.equal(invoice.balance_minor, 0);
  });
  await t.test('11 inventory sold and product cost calculated', () => {
    saleEntry = db.prepare(`SELECT * FROM accounting_journal_entries WHERE workspace_id = ?
      AND source_type = 'sales_fulfillment' AND json_extract(metadata, '$.salesOrderId') = ?`)
      .get(workspace.workspaceId, order.id);
    assert.equal(JSON.parse(saleEntry.metadata).cogsMinor, 10_000);
    assert.equal(costing.valuation(db, workspace.workspaceId).totalCostMinor, 90_000);
  });
  await t.test('12 inventory removed through damage', () => {
    const damaged = inventory.issue(db, workspace.ctx, { skuId: product.skuId,
      locationId: workspace.main.id, quantity: 2, reasonCode: 'damaged', occurredAt: '2026-09-01' });
    const published = events.publish(db, workspace.workspaceId, 'inventory.issued', { skuIds: [product.skuId] },
      { sourceRecordType: 'movement', sourceRecordId: damaged.movementIds[0], idempotencyKey: 'life-damage' });
    const result = operational.captureAndProcess(db, published.event);
    assert.equal(result.status, 'POSTED'); assert.equal(result.outcome.totalCostMinor, 2_000);
  });
  await t.test('13 customer refund', () => {
    const result = refunds.refundSale(db, workspace.ctx, membership, { originalJournalEntryId: saleEntry.id,
      refundDate: '2026-09-08', revenueMinor: 2_000, taxMinor: 0, cogsMinor: 0,
      physicalReturn: false, destination: 'CASH', reference: 'Customer refund', sourceKey: 'life-refund' });
    assert.equal(result.refund.revenue_minor, 2_000); assert.equal(result.refund.physical_return, 0);
  });
  let expenseBill;
  await t.test('14 supplier return or credit memo', () => {
    const draft = payables.createDraft(db, workspace.ctx, membership, { supplierId: supplier.id,
      supplierInvoiceNumber: 'LIFE-EXP-CREDIT', issueDate: '2026-09-08', sourceKey: 'life-credit-bill',
      lines: [{ description: 'Shipping charge', quantity: 1, unitCostMinor: 1_000,
        debitAccountId: ledger.accountBySystemKey(db, workspace.workspaceId, 'OPERATING_EXPENSE').id }] });
    expenseBill = payables.open(db, workspace.ctx, membership, draft.bill.id);
    supplierCredits.record(db, workspace.ctx, membership, { billId: expenseBill.id,
      amountMinor: 200, creditDate: '2026-09-09', creditNumber: 'CM-1', reason: 'Service credit',
      sourceKey: 'life-credit-1' });
    expenseBill = payables.requireBill(db, workspace.workspaceId, expenseBill.id);
    assert.equal(expenseBill.balance_minor, 800);
  });
  await t.test('15 business expense recorded', () => {
    const draft = payables.createDraft(db, workspace.ctx, membership, { supplierId: supplier.id,
      supplierInvoiceNumber: 'LIFE-RENT', issueDate: '2026-09-10', sourceKey: 'life-rent',
      lines: [{ description: 'Warehouse rent', quantity: 1, unitCostMinor: 5_000,
        debitAccountId: ledger.accountBySystemKey(db, workspace.workspaceId, 'RENT_EXPENSE').id }] });
    const rent = payables.open(db, workspace.ctx, membership, draft.bill.id);
    assert.equal(rent.balance_minor, 5_000);
    assert.equal(dashboard().expenses.rows.some((row) => row.bill_id === rent.id), true);
  });
  await t.test('16 gross profit calculated', () => {
    const pnl = reports.profitAndLoss(db, workspace.workspaceId, { from: '2026-09-01', to: '2026-09-30' });
    assert.equal(pnl.revenueMinor, 18_000); assert.equal(pnl.grossProfitMinor, 8_000);
  });
  await t.test('17 net profit calculated', () => {
    const pnl = reports.profitAndLoss(db, workspace.workspaceId, { from: '2026-09-01', to: '2026-09-30' });
    assert.equal(pnl.operatingExpenseMinor, 7_800);
    assert.equal(pnl.netIncomeMinor, 200);
  });
  await t.test('18 cash movement calculated independently from profit', () => {
    const cash = reports.cashFlow(db, workspace.workspaceId, { from: '2026-09-02', to: '2026-09-30' });
    assert.equal(cash.netCashChangeMinor, -82_000);
    assert.notEqual(cash.netCashChangeMinor, reports.profitAndLoss(db, workspace.workspaceId,
      { from: '2026-09-01', to: '2026-09-30' }).netIncomeMinor);
  });
  await t.test('19 current inventory value calculated from exact cost', () => {
    const value = costing.valuation(db, workspace.workspaceId);
    assert.equal(value.totalUnits, 88); assert.equal(value.totalCostMinor, 88_000);
  });
  await t.test('20 missing information detected and explained exactly', () => {
    const second = purchaseOrders.approve(db, workspace.ctx, membership,
      purchaseOrders.createOrder(db, workspace.ctx, membership, { supplierId: supplier.id,
        destinationLocationId: workspace.main.id,
        lines: [{ skuId: product.skuId, quantityUnits: 5, unitCost: 10 }] }).id);
    receiving.receive(db, workspace.ctx, membership, second.id, { idempotencyKey: 'life-missing-bill',
      lines: [{ lineId: second.lines[0].id, quantityUnits: 5 }] }); reactions.drainWorkspace(db, workspace.workspaceId);
    const owner = dashboard();
    assert.equal(owner.missingBills.some((row) => row.id === second.id), true);
    assert.equal(owner.missingBills.find((row) => row.id === second.id).receivedCostMinor, 5_000);
  });
  db.close();
});
