'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const ledger = require('../../src/accounting/ledger');
const reports = require('../../src/accounting/reports');
const costing = require('../../src/accounting/costing');
const payables = require('../../src/accounting/payables');
const payments = require('../../src/accounting/payments');
const banking = require('../../src/accounting/banking');
const tax = require('../../src/accounting/tax');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/repository');
const auth = require('../../src/domain/auth-service');
const reactions = require('../../src/manager/reactions');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, plain } = require('../helpers');

test.after(cleanupAll);

test('Mission 14 deterministic company reconciles operations, subledgers, statements, and cash', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Mission 14 Company' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  ledger.post(db, workspace.ctx, { postingDate: '2026-01-01',
    description: 'Opening cash', sourceKey: 'm14-opening-cash',
    lines: [{ accountKey: 'CASH', debitMinor: 5_000_000 },
      { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: 5_000_000 }] });

  const shirt = makeQuantityItem(db, workspace.ctx, { name: 'Mission shirt', baseCode: 'M14-SHIRT' });
  prices.setPrice(db, workspace.ctx, { skuId: shirt.skuId, amount: '20.00', currency: 'USD' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'Mission Supplier' });
  suppliers.linkItem(db, workspace.ctx, membership, { supplierId: supplier.id, skuId: shirt.skuId,
    supplierSku: 'M14-1', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 8 });
  let po = purchaseOrders.createOrder(db, workspace.ctx, membership, { supplierId: supplier.id,
    destinationLocationId: workspace.main.id,
    lines: [{ skuId: shirt.skuId, quantityUnits: 100, unitCost: 8 }] });
  po = purchaseOrders.approve(db, workspace.ctx, membership, po.id);
  const receipt = receiving.receive(db, workspace.ctx, membership, po.id, {
    idempotencyKey: 'm14-receipt', lines: [{ lineId: po.lines[0].id, quantityUnits: 100 }],
  });
  reactions.drainWorkspace(db, workspace.workspaceId);

  const supplierInvoice = payables.createDraft(db, workspace.ctx, membership, {
    supplierId: supplier.id, purchaseOrderId: po.id, purchaseReceiptId: receipt.receipt.id,
    supplierInvoiceNumber: 'M14-SUP-1', issueDate: '2026-01-02', sourceKey: 'm14-supplier-invoice',
    lines: [{ description: '100 Mission shirts', quantity: 100, unitCostMinor: 800,
      itemId: shirt.itemId, skuId: shirt.skuId, purchaseOrderLineId: po.lines[0].id }],
  });
  const bill = payables.open(db, workspace.ctx, membership, supplierInvoice.bill.id);
  assert.equal(bill.match_status, 'MATCHED');

  let order = sales.createOrder(db, workspace.ctx, { customerName: 'Mission Customer',
    fulfillmentLocationId: workspace.main.id,
    lines: [{ skuId: shirt.skuId, quantity: 20 }] });
  order = sales.confirm(db, workspace.ctx, order.id);
  sales.fulfill(db, workspace.ctx, order.id, {}, { idempotencyKey: 'm14-sale' });
  reactions.drainWorkspace(db, workspace.workspaceId);

  payments.record(db, workspace.ctx, membership, { direction: 'SUPPLIER_PAYMENT',
    supplierId: supplier.id, paymentDate: '2026-01-05', amountMinor: 80_000,
    sourceKey: 'm14-pay-supplier', allocations: [{ billId: bill.id, amountMinor: 80_000 }] });
  const rentDraft = payables.createDraft(db, workspace.ctx, membership, {
    supplierId: supplier.id, supplierInvoiceNumber: 'M14-RENT', issueDate: '2026-01-06',
    sourceKey: 'm14-rent', lines: [{ description: 'Rent', quantity: 1, unitCostMinor: 10_000,
      debitAccountId: ledger.accountBySystemKey(db, workspace.workspaceId, 'RENT_EXPENSE').id }],
  });
  const rent = payables.open(db, workspace.ctx, membership, rentDraft.bill.id);
  payments.record(db, workspace.ctx, membership, { direction: 'SUPPLIER_PAYMENT',
    supplierId: supplier.id, paymentDate: '2026-01-07', amountMinor: 10_000,
    sourceKey: 'm14-pay-rent', allocations: [{ billId: rent.id, amountMinor: 10_000 }] });

  const pnl = reports.profitAndLoss(db, workspace.workspaceId, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pnl.revenueMinor, 40_000);
  assert.equal(pnl.cogsMinor, 16_000);
  assert.equal(pnl.grossProfitMinor, 24_000);
  assert.equal(pnl.operatingExpenseMinor, 10_000);
  assert.equal(pnl.operatingProfitMinor, 14_000);
  assert.equal(inventory.getBalance(db, workspace.workspaceId, shirt.skuId, workspace.main.id), 80);
  assert.equal(costing.valuation(db, workspace.workspaceId).totalCostMinor, 64_000);
  assert.equal(reports.inventoryReconciliation(db, workspace.workspaceId, { asOf: '2026-12-31' }).reconciled, true);
  const controls = reports.controlReconciliation(db, workspace.workspaceId, { asOf: '2026-12-31' });
  assert.equal(controls.ar.reconciled, true);
  assert.equal(controls.ap.reconciled, true);
  assert.equal(reports.apAging(db, workspace.workspaceId, { asOf: '2026-12-31' }).totalMinor, 0);
  const trial = reports.trialBalance(db, workspace.workspaceId, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(trial.balanced, true);
  assert.equal(trial.totals.ending_debit_minor, trial.totals.ending_credit_minor);
  const balance = reports.balanceSheet(db, workspace.workspaceId, { asOf: '2026-12-31' });
  assert.equal(balance.balanced, true);

  const checking = banking.createAccount(db, workspace.ctx, membership, { name: 'Mission checking',
    kind: 'BANK', ledgerAccountId: ledger.accountBySystemKey(db, workspace.workspaceId, 'CASH').id });
  assert.equal(banking.reconcile(db, workspace.ctx, membership, checking.id, {
    statementEndDate: '2026-12-31', statementEndingBalanceMinor: 4_910_000, complete: true,
  }).status, 'COMPLETED');

  const rate = tax.create(db, workspace.ctx, membership, { name: 'Local sales tax',
    jurisdiction: 'Test jurisdiction', ratePercent: '8.875', appliesTo: 'SALES',
    effectiveFrom: '2026-01-01' });
  assert.equal(tax.calculate(db, workspace.workspaceId, rate.id, 10_000, '2026-01-10', 'SALES'), 888);
  db.close();
});

test('Foundry keeps partial delivery and partial supplier payment as two independent balances', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Autonomous Purchasing Company' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const shirt = makeQuantityItem(db, workspace.ctx, { name: 'Autonomous Shirt', baseCode: 'AUTO-SHIRT' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'Trusted Shirt Supplier' });
  suppliers.linkItem(db, workspace.ctx, membership, { supplierId: supplier.id, skuId: shirt.skuId,
    supplierSku: 'SHIRT-100', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 10 });
  let po = purchaseOrders.createOrder(db, workspace.ctx, membership, { supplierId: supplier.id,
    destinationLocationId: workspace.main.id,
    lines: [{ skuId: shirt.skuId, quantityUnits: 100, unitCost: 10 }] });
  po = purchaseOrders.approve(db, workspace.ctx, membership, po.id);

  receiving.receive(db, workspace.ctx, membership, po.id, {
    idempotencyKey: 'autonomous-receive-60',
    lines: [{ lineId: po.lines[0].id, quantityUnits: 60 }],
  });
  reactions.drainWorkspace(db, workspace.workspaceId);

  const draft = payables.createDraft(db, workspace.ctx, membership, {
    supplierId: supplier.id, purchaseOrderId: po.id,
    supplierInvoiceNumber: 'SUP-1000', issueDate: '2026-01-02', sourceKey: 'supplier-email-SUP-1000',
    lines: [{ description: '100 shirts', quantity: 100, unitCostMinor: 1_000,
      itemId: shirt.itemId, skuId: shirt.skuId, purchaseOrderLineId: po.lines[0].id }],
  });
  let bill = payables.open(db, workspace.ctx, membership, draft.bill.id);
  assert.equal(bill.match_status, 'WITHIN_TOLERANCE', 'an invoice may validly arrive before every unit');
  assert.equal(bill.total_minor, 100_000);
  assert.equal(bill.balance_minor, 100_000);

  payments.record(db, workspace.ctx, membership, { direction: 'SUPPLIER_PAYMENT',
    supplierId: supplier.id, paymentDate: '2026-01-03', amountMinor: 40_000,
    sourceKey: 'supplier-payment-400', allocations: [{ billId: bill.id, amountMinor: 40_000 }] });
  bill = payables.requireBill(db, workspace.workspaceId, bill.id);
  assert.equal(bill.status, 'PARTIALLY_PAID');
  assert.equal(bill.balance_minor, 60_000);

  let currentPo = purchaseOrders.get(db, workspace.workspaceId, po.id);
  assert.deepEqual({ ordered: currentPo.orderedUnits, received: currentPo.receivedUnits,
    expected: currentPo.outstandingUnits }, { ordered: 100, received: 60, expected: 40 });

  const app = createApp({ db, env: 'test', sessionSecret: 'autonomous-purchasing-test' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email);
  const page = await agent.get(`/purchasing/orders/${po.id}`);
  assert.equal(page.status, 200);
  const story = plain(page.text);
  assert.match(story, /Delivery and payment are tracked separately/);
  assert.match(story, /Ordered 100 units/);
  assert.match(story, /Received 60 units/);
  assert.match(story, /Still expected 40 units/);
  assert.match(story, /Partially paid/);
  assert.match(story, /Supplier invoices received \$1,000\.00/);
  assert.match(story, /Paid \$400\.00/);
  assert.match(story, /Still owed \$600\.00/);
  const ownerSummary = plain((await agent.get('/accounting')).text);
  assert.match(ownerSummary, /Your business right now/);
  assert.match(ownerSummary, /You owe suppliers \$600\.00/);
  assert.match(ownerSummary, /Cash paid to suppliers \$400\.00/);
  assert.match(ownerSummary, /Inventory you own \$600\.00/);
  assert.match(ownerSummary, /Suppliers \$1,000\.00 in supplier bills \$400\.00 paid · \$600\.00 still owed by you/);

  receiving.receive(db, workspace.ctx, membership, po.id, {
    idempotencyKey: 'autonomous-receive-final-40',
    lines: [{ lineId: po.lines[0].id, quantityUnits: 40 }],
  });
  reactions.drainWorkspace(db, workspace.workspaceId);
  currentPo = purchaseOrders.get(db, workspace.workspaceId, po.id);
  bill = payables.requireBill(db, workspace.workspaceId, bill.id);
  assert.equal(currentPo.outstandingUnits, 0, 'the physical order is now complete');
  assert.equal(bill.balance_minor, 60_000, 'receiving the last units does not pay the supplier');

  payments.record(db, workspace.ctx, membership, { direction: 'SUPPLIER_PAYMENT',
    supplierId: supplier.id, paymentDate: '2026-01-04', amountMinor: 60_000,
    sourceKey: 'supplier-payment-600', allocations: [{ billId: bill.id, amountMinor: 60_000 }] });
  bill = payables.requireBill(db, workspace.workspaceId, bill.id);
  assert.equal(bill.status, 'PAID');
  assert.equal(bill.balance_minor, 0);
  assert.equal(inventory.getBalance(db, workspace.workspaceId, shirt.skuId, workspace.main.id), 100);
  const paidSummary = plain((await agent.get('/accounting')).text);
  assert.match(paidSummary, /You owe suppliers \$0\.00/);
  assert.match(paidSummary, /Cash paid to suppliers \$1,000\.00/);
  assert.match(paidSummary, /Inventory you own \$1,000\.00/);
  assert.equal(reports.controlReconciliation(db, workspace.workspaceId, { asOf: '2026-12-31' }).ap.reconciled, true);

  const controlBalance = (systemKey) => Number(db.prepare(`SELECT
      COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0) AS n
    FROM accounting_journal_lines jl
    JOIN accounting_journal_entries je ON je.id = jl.entry_id
    JOIN accounting_accounts a ON a.id = jl.account_id
    WHERE je.workspace_id = ? AND je.status = 'POSTED' AND a.system_key = ?`)
    .get(workspace.workspaceId, systemKey).n);
  assert.equal(controlBalance('INVENTORY_IN_TRANSIT'), 0);
  assert.equal(controlBalance('RECEIVED_NOT_INVOICED'), 0);
  assert.equal(controlBalance('ACCOUNTS_PAYABLE'), 0);
  db.close();
});
