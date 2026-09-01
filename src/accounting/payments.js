'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const { newId, nowIso } = require('../lib/util');
const ledger = require('./ledger');

function nextNumber(db, workspaceId) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM accounting_payments WHERE workspace_id = ?').get(workspaceId).n + 1;
  return `PAY-${String(n).padStart(5, '0')}`;
}

function hydrate(db, workspaceId, id) {
  const row = db.prepare(`SELECT p.*, c.name AS customer_name, s.name AS supplier_name,
      a.code AS cash_account_code, a.name AS cash_account_name
    FROM accounting_payments p
    LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id
    JOIN accounting_accounts a ON a.id = p.cash_account_id
    WHERE p.id = ? AND p.workspace_id = ?`).get(id, workspaceId);
  if (!row) return null;
  return { ...row, allocations: db.prepare(`SELECT * FROM accounting_payment_allocations
    WHERE payment_id = ? ORDER BY rowid`).all(id) };
}

function requirePayment(db, workspaceId, id) {
  const payment = hydrate(db, workspaceId, id);
  if (!payment) throw new NotFoundError('That payment could not be found.');
  return payment;
}

function resolveCashAccount(db, workspaceId, accountId) {
  if (!accountId) return ledger.accountBySystemKey(db, workspaceId, 'CASH');
  const account = db.prepare(`SELECT * FROM accounting_accounts WHERE id = ? AND workspace_id = ?
    AND account_type = 'ASSET' AND active = 1`).get(accountId, workspaceId);
  if (!account) throw new ValidationError('Choose an active cash or bank account.');
  return account;
}

function prepareAllocations(db, workspaceId, direction, counterpartyId, raw) {
  const allocations = Array.isArray(raw) ? raw : [];
  return allocations.map((allocation, index) => {
    const amount = Number(allocation.amountMinor);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new ValidationError(`Allocation ${index + 1} must be positive minor currency units.`);
    if (direction === 'CUSTOMER_RECEIPT') {
      const invoice = db.prepare(`SELECT * FROM accounting_customer_invoices
        WHERE id = ? AND workspace_id = ?`).get(allocation.invoiceId, workspaceId);
      if (!invoice || invoice.customer_id !== counterpartyId) throw new ValidationError('A payment allocation uses the wrong customer invoice.');
      if (!['OPEN', 'PARTIALLY_PAID'].includes(invoice.status)) throw new ValidationError(`${invoice.invoice_number} is not open for payment.`);
      if (amount > Number(invoice.balance_minor)) throw new ValidationError(`Allocation exceeds ${invoice.invoice_number}'s open balance.`);
      return { amount, invoice };
    }
    const bill = db.prepare(`SELECT * FROM accounting_supplier_bills
      WHERE id = ? AND workspace_id = ?`).get(allocation.billId, workspaceId);
    if (!bill || bill.supplier_id !== counterpartyId) throw new ValidationError('A payment allocation uses the wrong supplier bill.');
    if (!['OPEN', 'PARTIALLY_PAID'].includes(bill.status)) throw new ValidationError(`${bill.bill_number} is not open for payment.`);
    if (amount > Number(bill.balance_minor)) throw new ValidationError(`Allocation exceeds ${bill.bill_number}'s open balance.`);
    return { amount, bill };
  });
}

function record(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.RECORD_PAYMENTS, 'record payments');
  const direction = String(input.direction || '').toUpperCase();
  if (!['CUSTOMER_RECEIPT', 'SUPPLIER_PAYMENT'].includes(direction)) throw new ValidationError('Choose customer receipt or supplier payment.');
  const counterpartyId = direction === 'CUSTOMER_RECEIPT' ? input.customerId : input.supplierId;
  const table = direction === 'CUSTOMER_RECEIPT' ? 'customers' : 'suppliers';
  const counterparty = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`)
    .get(counterpartyId, ctx.workspaceId);
  if (!counterparty) throw new ValidationError(`Choose a ${direction === 'CUSTOMER_RECEIPT' ? 'customer' : 'supplier'} from this inventory.`);
  const amount = Number(input.amountMinor);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ValidationError('Payment amount must be positive minor currency units.');
  const date = ledger.dateOnly(input.paymentDate || nowIso().slice(0, 10), 'Payment date');
  const cash = resolveCashAccount(db, ctx.workspaceId, input.cashAccountId);
  const allocations = prepareAllocations(db, ctx.workspaceId, direction, counterpartyId, input.allocations);
  const allocated = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  if (allocated > amount) throw new ValidationError('Payment allocations exceed the payment amount.');
  const unapplied = amount - allocated;
  const sourceKey = String(input.sourceKey || `manual-payment:${crypto.randomUUID()}`);
  const existing = db.prepare(`SELECT id FROM accounting_payments WHERE workspace_id = ? AND source_key = ?`)
    .get(ctx.workspaceId, sourceKey);
  if (existing) return { payment: requirePayment(db, ctx.workspaceId, existing.id), replayed: true };
  return inTransaction(db, () => {
    const journalLines = direction === 'CUSTOMER_RECEIPT'
      ? [
        { accountId: cash.id, debitMinor: amount, customerId: counterpartyId },
        ...(allocated ? [{ accountKey: 'ACCOUNTS_RECEIVABLE', creditMinor: allocated, customerId: counterpartyId }] : []),
        ...(unapplied ? [{ accountKey: 'CUSTOMER_DEPOSITS', creditMinor: unapplied, customerId: counterpartyId }] : []),
      ]
      : [
        ...(allocated ? [{ accountKey: 'ACCOUNTS_PAYABLE', debitMinor: allocated, supplierId: counterpartyId }] : []),
        ...(unapplied ? [{ accountKey: 'SUPPLIER_ADVANCES', debitMinor: unapplied, supplierId: counterpartyId }] : []),
        { accountId: cash.id, creditMinor: amount, supplierId: counterpartyId },
      ];
    const id = newId('payment');
    const posted = ledger.post(db, ctx, {
      postingDate: date,
      description: direction === 'CUSTOMER_RECEIPT'
        ? `Payment received from ${counterparty.name}` : `Payment to ${counterparty.name}`,
      sourceType: 'payment', sourceRecordType: 'payment', sourceRecordId: id,
      sourceKey: `payment:${sourceKey}`, createdByType: 'USER', approvedByUserId: ctx.actorId,
      metadata: { direction, allocatedMinor: allocated, unappliedMinor: unapplied,
        reference: input.reference || null }, lines: journalLines,
    });
    const now = nowIso();
    db.prepare(`INSERT INTO accounting_payments
      (id, workspace_id, payment_number, direction, customer_id, supplier_id,
       payment_date, amount_minor, currency, method, reference, status, cash_account_id,
       journal_entry_id, source_key, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, input.paymentNumber || nextNumber(db, ctx.workspaceId), direction,
        direction === 'CUSTOMER_RECEIPT' ? counterpartyId : null,
        direction === 'SUPPLIER_PAYMENT' ? counterpartyId : null,
        date, amount, ledger.settings(db, ctx.workspaceId).currency, input.method || null,
        input.reference || null, cash.id, posted.entry.id, sourceKey, ctx.actorId, now);
    const insert = db.prepare(`INSERT INTO accounting_payment_allocations
      (id, workspace_id, payment_id, customer_invoice_id, supplier_bill_id, amount_minor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const allocation of allocations) {
      insert.run(newId('payalloc'), ctx.workspaceId, id, allocation.invoice ? allocation.invoice.id : null,
        allocation.bill ? allocation.bill.id : null, allocation.amount, now);
      if (allocation.invoice) {
        const balance = Number(allocation.invoice.balance_minor) - allocation.amount;
        db.prepare(`UPDATE accounting_customer_invoices SET balance_minor = ?, status = ?,
          paid_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
          .run(balance, balance === 0 ? 'PAID' : 'PARTIALLY_PAID', balance === 0 ? now : null,
            now, allocation.invoice.id, ctx.workspaceId);
      } else {
        const balance = Number(allocation.bill.balance_minor) - allocation.amount;
        db.prepare(`UPDATE accounting_supplier_bills SET balance_minor = ?, status = ?,
          paid_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
          .run(balance, balance === 0 ? 'PAID' : 'PARTIALLY_PAID', balance === 0 ? now : null,
            now, allocation.bill.id, ctx.workspaceId);
      }
    }
    return { payment: requirePayment(db, ctx.workspaceId, id), replayed: false };
  });
}

function voidPayment(db, ctx, membership, id, input = {}) {
  permissions.assertCan(membership, permissions.RECORD_PAYMENTS, 'void payments');
  const payment = requirePayment(db, ctx.workspaceId, id);
  if (payment.status === 'VOID') return payment;
  return inTransaction(db, () => {
    ledger.reverse(db, ctx, membership, payment.journal_entry_id, {
      postingDate: input.postingDate || nowIso().slice(0, 10),
      reason: input.reason || `Void ${payment.payment_number}`,
    });
    const now = nowIso();
    for (const allocation of payment.allocations) {
      if (allocation.customer_invoice_id) {
        const invoice = db.prepare('SELECT * FROM accounting_customer_invoices WHERE id = ? AND workspace_id = ?')
          .get(allocation.customer_invoice_id, ctx.workspaceId);
        const balance = Number(invoice.balance_minor) + Number(allocation.amount_minor);
        db.prepare(`UPDATE accounting_customer_invoices SET balance_minor = ?, status = 'OPEN',
          paid_at = NULL, updated_at = ? WHERE id = ?`).run(balance, now, invoice.id);
      } else {
        const bill = db.prepare('SELECT * FROM accounting_supplier_bills WHERE id = ? AND workspace_id = ?')
          .get(allocation.supplier_bill_id, ctx.workspaceId);
        const balance = Number(bill.balance_minor) + Number(allocation.amount_minor);
        db.prepare(`UPDATE accounting_supplier_bills SET balance_minor = ?, status = 'OPEN',
          paid_at = NULL, updated_at = ? WHERE id = ?`).run(balance, now, bill.id);
      }
    }
    db.prepare(`UPDATE accounting_payments SET status = 'VOID', voided_at = ?
      WHERE id = ? AND workspace_id = ?`).run(now, id, ctx.workspaceId);
    return requirePayment(db, ctx.workspaceId, id);
  });
}

module.exports = { nextNumber, hydrate, requirePayment, record, voidPayment };
