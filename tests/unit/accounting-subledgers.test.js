'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const reports = require('../../src/accounting/reports');
const receivables = require('../../src/accounting/receivables');
const payables = require('../../src/accounting/payables');
const payments = require('../../src/accounting/payments');
const banking = require('../../src/accounting/banking');
const sales = require('../../src/sales/sales-order-service');
const suppliers = require('../../src/purchasing/supplier-service');
const authService = require('../../src/domain/auth-service');
const permissions = require('../../src/actions/permissions');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Subledger Test Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const customer = sales.createCustomer(db, workspace.ctx, { name: 'Customer One' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'Supplier One' });
  return { db, workspace, membership, customer, supplier };
}

test('AR invoice supports partial and full receipts while control account and aging agree', () => {
  const env = setup();
  const draft = receivables.createDraft(env.db, env.workspace.ctx, env.membership, {
    customerId: env.customer.id, issueDate: '2026-01-05', dueDate: '2026-01-20',
    taxMinor: 100, sourceKey: 'invoice:test:1',
    lines: [{ description: 'Consulting and goods', quantity: 1, unitPriceMinor: 1000 }],
  });
  const invoice = receivables.open(env.db, env.workspace.ctx, env.membership, draft.invoice.id);
  assert.equal(invoice.status, 'OPEN');
  assert.equal(invoice.total_minor, 1100);
  const partial = payments.record(env.db, env.workspace.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: env.customer.id,
    paymentDate: '2026-01-10', amountMinor: 400, sourceKey: 'customer-payment:1',
    allocations: [{ invoiceId: invoice.id, amountMinor: 400 }],
  });
  assert.equal(partial.payment.amount_minor, 400);
  assert.equal(receivables.requireInvoice(env.db, env.workspace.workspaceId, invoice.id).balance_minor, 700);
  assert.equal(receivables.requireInvoice(env.db, env.workspace.workspaceId, invoice.id).status, 'PARTIALLY_PAID');
  const aging = reports.arAging(env.db, env.workspace.workspaceId, { asOf: '2026-02-25' });
  assert.equal(aging.totalMinor, 700);
  assert.equal(aging.buckets.days31to60, 700);
  payments.record(env.db, env.workspace.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: env.customer.id,
    paymentDate: '2026-02-26', amountMinor: 700, sourceKey: 'customer-payment:2',
    allocations: [{ invoiceId: invoice.id, amountMinor: 700 }],
  });
  assert.equal(receivables.requireInvoice(env.db, env.workspace.workspaceId, invoice.id).status, 'PAID');
  assert.equal(reports.arAging(env.db, env.workspace.workspaceId, { asOf: '2026-02-28' }).totalMinor, 0);
  const ar = reports.trialBalance(env.db, env.workspace.workspaceId, { from: '2026-01-01', to: '2026-12-31' })
    .accounts.find((account) => account.system_key === 'ACCOUNTS_RECEIVABLE');
  assert.equal(ar.net_minor, 0);
});

test('AP bill supports partial payment, full payment, and reversal without deleting history', () => {
  const env = setup();
  const expense = ledger.accountBySystemKey(env.db, env.workspace.workspaceId, 'RENT_EXPENSE');
  const draft = payables.createDraft(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, supplierInvoiceNumber: 'SUP-100',
    issueDate: '2026-01-01', dueDate: '2026-01-31', sourceKey: 'bill:test:1',
    lines: [{ description: 'January rent', quantity: 1, unitCostMinor: 10_000, debitAccountId: expense.id }],
  });
  const bill = payables.open(env.db, env.workspace.ctx, env.membership, draft.bill.id);
  assert.equal(bill.status, 'OPEN');
  const first = payments.record(env.db, env.workspace.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: env.supplier.id,
    paymentDate: '2026-01-15', amountMinor: 4_000, sourceKey: 'supplier-payment:1',
    allocations: [{ billId: bill.id, amountMinor: 4_000 }],
  });
  assert.equal(payables.requireBill(env.db, env.workspace.workspaceId, bill.id).balance_minor, 6_000);
  assert.equal(reports.apAging(env.db, env.workspace.workspaceId, { asOf: '2026-03-15' }).buckets.days31to60, 6_000);
  const voided = payments.voidPayment(env.db, env.workspace.ctx, env.membership, first.payment.id, {
    postingDate: '2026-01-16', reason: 'Bank rejected payment',
  });
  assert.equal(voided.status, 'VOID');
  assert.equal(payables.requireBill(env.db, env.workspace.workspaceId, bill.id).balance_minor, 10_000);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ?`).get(env.workspace.workspaceId).n, 3);
});

test('unapplied money uses deposit/advance accounts instead of distorting AR or AP', () => {
  const env = setup();
  payments.record(env.db, env.workspace.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: env.customer.id,
    paymentDate: '2026-01-01', amountMinor: 500, sourceKey: 'deposit:1', allocations: [],
  });
  payments.record(env.db, env.workspace.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: env.supplier.id,
    paymentDate: '2026-01-02', amountMinor: 300, sourceKey: 'advance:1', allocations: [],
  });
  const trial = reports.trialBalance(env.db, env.workspace.workspaceId, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(trial.accounts.find((a) => a.system_key === 'CUSTOMER_DEPOSITS').net_minor, 500);
  assert.equal(trial.accounts.find((a) => a.system_key === 'SUPPLIER_ADVANCES').net_minor, 300);
  assert.equal(trial.accounts.find((a) => a.system_key === 'ACCOUNTS_RECEIVABLE'), undefined);
  assert.equal(trial.accounts.find((a) => a.system_key === 'ACCOUNTS_PAYABLE'), undefined);
});

test('bank imports deduplicate, transfers do not create income, and exact reconciliation closes', () => {
  const env = setup();
  const cash = ledger.accountBySystemKey(env.db, env.workspace.workspaceId, 'CASH');
  const secondLedger = ledger.createAccount(env.db, env.workspace.ctx, env.membership, {
    code: '1010', name: 'Savings account', type: 'ASSET', subtype: 'CASH', normalBalance: 'DEBIT',
  });
  const checking = banking.createAccount(env.db, env.workspace.ctx, env.membership, {
    name: 'Checking', kind: 'BANK', ledgerAccountId: cash.id,
  });
  const savings = banking.createAccount(env.db, env.workspace.ctx, env.membership, {
    name: 'Savings', kind: 'BANK', ledgerAccountId: secondLedger.id,
  });
  ledger.post(env.db, env.workspace.ctx, {
    postingDate: '2026-01-01', description: 'Opening bank balance', sourceKey: 'bank-opening',
    lines: [
      { accountId: cash.id, debitMinor: 100_000 },
      { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: 100_000 },
    ],
  });
  const transfer = banking.transfer(env.db, env.workspace.ctx, env.membership, {
    fromBankAccountId: checking.id, toBankAccountId: savings.id,
    amountMinor: 30_000, transferDate: '2026-01-02', reference: 'XFER-1', sourceKey: 'transfer:1',
  });
  const imported = banking.importTransactions(env.db, env.workspace.ctx, env.membership, savings.id, [{
    externalId: 'bank-1', transactionDate: '2026-01-02', amountMinor: 30_000,
    description: 'Transfer from checking', reference: 'XFER-1',
  }], { source: 'test_bank' });
  const replay = banking.importTransactions(env.db, env.workspace.ctx, env.membership, savings.id, [{
    externalId: 'bank-1', transactionDate: '2026-01-02', amountMinor: 30_000,
    description: 'Transfer from checking', reference: 'XFER-1',
  }], { source: 'test_bank' });
  assert.equal(imported[0].replayed, false);
  assert.equal(replay[0].replayed, true);
  banking.matchJournal(env.db, env.workspace.ctx, env.membership, imported[0].transaction.id, transfer.entry.id);
  const reconciliation = banking.reconcile(env.db, env.workspace.ctx, env.membership, savings.id, {
    statementEndDate: '2026-01-31', statementEndingBalanceMinor: 30_000, complete: true,
  });
  assert.equal(reconciliation.status, 'COMPLETED');
  assert.equal(reconciliation.difference_minor, 0);
  assert.equal(reports.profitAndLoss(env.db, env.workspace.workspaceId, {
    from: '2026-01-01', to: '2026-01-31',
  }).netIncomeMinor, 0);
});

test('accountant role receives financial permissions but no stock-operation permission', () => {
  const env = setup();
  const accountant = authService.createTeamMember(env.db, env.workspace.ctx, env.membership, {
    name: 'Alex Accountant', email: 'alex.accountant@example.test', password: 'accountant-password', role: 'accountant',
  });
  const account = env.db.prepare('SELECT * FROM users WHERE id = ?').get(accountant.id);
  assert.equal(permissions.can(account, permissions.VIEW_ACCOUNTING), true);
  assert.equal(permissions.can(account, permissions.CLOSE_ACCOUNTING_PERIOD), true);
  assert.equal(permissions.can(account, permissions.OPERATE), false);
  assert.equal(permissions.can(account, permissions.ADJUST), false);
});
