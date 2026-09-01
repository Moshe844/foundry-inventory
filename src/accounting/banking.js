'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const { newId, nowIso, requireText } = require('../lib/util');
const ledger = require('./ledger');

function requireBank(db, workspaceId, id) {
  const row = db.prepare(`SELECT b.*, a.code AS ledger_account_code, a.name AS ledger_account_name
    FROM accounting_bank_accounts b JOIN accounting_accounts a ON a.id = b.ledger_account_id
    WHERE b.id = ? AND b.workspace_id = ?`).get(id, workspaceId);
  if (!row) throw new NotFoundError('That bank or credit-card account could not be found.');
  return row;
}

function createAccount(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'add financial accounts');
  const name = requireText(input.name, 'Account name', { max: 120 });
  const kind = String(input.kind || 'BANK').toUpperCase();
  if (!['BANK', 'CREDIT_CARD'].includes(kind)) throw new ValidationError('Choose bank or credit card.');
  const account = db.prepare(`SELECT * FROM accounting_accounts WHERE id = ? AND workspace_id = ? AND active = 1`)
    .get(input.ledgerAccountId, ctx.workspaceId);
  const expectedType = kind === 'BANK' ? 'ASSET' : 'LIABILITY';
  if (!account || account.account_type !== expectedType) {
    throw new ValidationError(`A ${kind === 'BANK' ? 'bank' : 'credit-card'} account must use an active ${expectedType.toLowerCase()} ledger account.`);
  }
  const id = newId('bank'); const now = nowIso();
  db.prepare(`INSERT INTO accounting_bank_accounts
    (id, workspace_id, name, account_kind, currency, ledger_account_id,
     institution_name, masked_identifier, active, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, ctx.workspaceId, name, kind, ledger.settings(db, ctx.workspaceId).currency,
      account.id, input.institutionName || null, input.maskedIdentifier || null, ctx.actorId, now, now);
  return requireBank(db, ctx.workspaceId, id);
}

function hashTransaction(bankId, row) {
  return crypto.createHash('sha256').update(JSON.stringify({
    bankId, date: row.transactionDate, postedDate: row.postedDate || null,
    amountMinor: Number(row.amountMinor), description: String(row.description || '').trim(),
    counterparty: String(row.counterparty || '').trim(), reference: String(row.reference || '').trim(),
  })).digest('hex');
}

function importTransactions(db, ctx, membership, bankAccountId, rows, options = {}) {
  permissions.assertCan(membership, permissions.RECONCILE_ACCOUNTS, 'import bank transactions');
  requireBank(db, ctx.workspaceId, bankAccountId);
  if (!Array.isArray(rows) || !rows.length) throw new ValidationError('Provide at least one bank transaction.');
  return inTransaction(db, () => {
    const results = [];
    for (const [index, row] of rows.entries()) {
      const date = ledger.dateOnly(row.transactionDate, `Transaction ${index + 1} date`);
      const amount = Number(row.amountMinor);
      if (!Number.isSafeInteger(amount) || amount === 0) throw new ValidationError(`Transaction ${index + 1} amount must be non-zero minor currency units.`);
      const description = requireText(row.description, `Transaction ${index + 1} description`, { max: 500 });
      const hash = hashTransaction(bankAccountId, { ...row, transactionDate: date, amountMinor: amount, description });
      const existing = row.externalId
        ? db.prepare(`SELECT * FROM accounting_bank_transactions WHERE workspace_id = ? AND bank_account_id = ? AND external_id = ?`)
          .get(ctx.workspaceId, bankAccountId, row.externalId)
        : db.prepare(`SELECT * FROM accounting_bank_transactions WHERE workspace_id = ? AND bank_account_id = ? AND content_hash = ?`)
          .get(ctx.workspaceId, bankAccountId, hash);
      if (existing) { results.push({ transaction: existing, replayed: true }); continue; }
      const id = newId('banktx');
      db.prepare(`INSERT INTO accounting_bank_transactions
        (id, workspace_id, bank_account_id, external_id, transaction_date, posted_date,
         amount_minor, description, counterparty, reference, content_hash, import_source,
         status, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNMATCHED', ?)`)
        .run(id, ctx.workspaceId, bankAccountId, row.externalId || null, date,
          row.postedDate ? ledger.dateOnly(row.postedDate, `Transaction ${index + 1} posted date`) : null,
          amount, description, row.counterparty || null, row.reference || null,
          hash, options.source || 'file', nowIso());
      results.push({ transaction: db.prepare('SELECT * FROM accounting_bank_transactions WHERE id = ?').get(id), replayed: false });
    }
    return results;
  });
}

function matchPayment(db, ctx, membership, transactionId, paymentId) {
  permissions.assertCan(membership, permissions.RECONCILE_ACCOUNTS, 'match bank transactions');
  const transaction = db.prepare(`SELECT * FROM accounting_bank_transactions
    WHERE id = ? AND workspace_id = ?`).get(transactionId, ctx.workspaceId);
  if (!transaction) throw new NotFoundError('That bank transaction could not be found.');
  if (transaction.status !== 'UNMATCHED') return transaction;
  const payment = db.prepare(`SELECT * FROM accounting_payments WHERE id = ? AND workspace_id = ? AND status = 'POSTED'`)
    .get(paymentId, ctx.workspaceId);
  if (!payment) throw new ValidationError('Choose a posted payment from this inventory.');
  const expected = payment.direction === 'CUSTOMER_RECEIPT' ? Number(payment.amount_minor) : -Number(payment.amount_minor);
  if (Number(transaction.amount_minor) !== expected) throw new ValidationError('Bank amount does not equal the payment amount.');
  db.prepare(`UPDATE accounting_bank_transactions SET status = 'MATCHED', matched_payment_id = ?,
    matched_journal_entry_id = ?, matched_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(payment.id, payment.journal_entry_id, nowIso(), transaction.id, ctx.workspaceId);
  return db.prepare('SELECT * FROM accounting_bank_transactions WHERE id = ?').get(transaction.id);
}

function matchJournal(db, ctx, membership, transactionId, journalEntryId) {
  permissions.assertCan(membership, permissions.RECONCILE_ACCOUNTS, 'match bank transactions');
  const transaction = db.prepare(`SELECT * FROM accounting_bank_transactions
    WHERE id = ? AND workspace_id = ?`).get(transactionId, ctx.workspaceId);
  if (!transaction) throw new NotFoundError('That bank transaction could not be found.');
  if (transaction.status !== 'UNMATCHED') return transaction;
  const bank = requireBank(db, ctx.workspaceId, transaction.bank_account_id);
  const amount = db.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS n
    FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l.entry_id
    WHERE e.id = ? AND e.workspace_id = ? AND e.status = 'POSTED' AND l.account_id = ?`)
    .get(journalEntryId, ctx.workspaceId, bank.ledger_account_id).n;
  const displayed = bank.account_kind === 'CREDIT_CARD' ? -Number(amount) : Number(amount);
  if (displayed !== Number(transaction.amount_minor)) {
    throw new ValidationError('Bank amount does not equal this journal entry’s change to the account.');
  }
  db.prepare(`UPDATE accounting_bank_transactions SET status = 'MATCHED',
    matched_journal_entry_id = ?, matched_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(journalEntryId, nowIso(), transaction.id, ctx.workspaceId);
  return db.prepare('SELECT * FROM accounting_bank_transactions WHERE id = ?').get(transaction.id);
}

function transfer(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.RECORD_PAYMENTS, 'record bank transfers');
  const from = requireBank(db, ctx.workspaceId, input.fromBankAccountId);
  const to = requireBank(db, ctx.workspaceId, input.toBankAccountId);
  if (from.id === to.id) throw new ValidationError('Choose two different accounts for a transfer.');
  if (from.currency !== to.currency) throw new ValidationError('Cross-currency transfers need an explicit exchange transaction.');
  const amount = Number(input.amountMinor);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ValidationError('Transfer amount must be positive minor currency units.');
  return ledger.post(db, ctx, {
    postingDate: input.transferDate || nowIso().slice(0, 10), description: `Transfer from ${from.name} to ${to.name}`,
    sourceType: 'bank_transfer', sourceRecordType: 'bank_transfer',
    sourceRecordId: input.reference || null,
    sourceKey: String(input.sourceKey || `bank-transfer:${crypto.randomUUID()}`),
    createdByType: 'USER', approvedByUserId: ctx.actorId,
    metadata: { fromBankAccountId: from.id, toBankAccountId: to.id, reference: input.reference || null },
    lines: [
      { accountId: to.ledger_account_id, debitMinor: amount },
      { accountId: from.ledger_account_id, creditMinor: amount },
    ],
  });
}

function ledgerBalance(db, workspaceId, accountId, asOf) {
  const row = db.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS n
    FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l.entry_id
    WHERE l.workspace_id = ? AND l.account_id = ? AND e.status = 'POSTED' AND e.posting_date <= ?`)
    .get(workspaceId, accountId, asOf);
  return Number(row.n);
}

function reconcile(db, ctx, membership, bankAccountId, input) {
  permissions.assertCan(membership, permissions.RECONCILE_ACCOUNTS, 'reconcile financial accounts');
  const bank = requireBank(db, ctx.workspaceId, bankAccountId);
  const date = ledger.dateOnly(input.statementEndDate, 'Statement end date');
  const statement = Number(input.statementEndingBalanceMinor);
  if (!Number.isSafeInteger(statement)) throw new ValidationError('Statement ending balance must be minor currency units.');
  const ledgerAmount = ledgerBalance(db, ctx.workspaceId, bank.ledger_account_id, date);
  // Liability accounts are displayed as positive credit balances.
  const displayedLedger = bank.account_kind === 'CREDIT_CARD' ? -ledgerAmount : ledgerAmount;
  const difference = statement - displayedLedger;
  const existing = db.prepare(`SELECT * FROM accounting_reconciliations
    WHERE workspace_id = ? AND bank_account_id = ? AND statement_end_date = ?`)
    .get(ctx.workspaceId, bank.id, date);
  const id = existing ? existing.id : newId('recon');
  if (!existing) db.prepare(`INSERT INTO accounting_reconciliations
    (id, workspace_id, bank_account_id, statement_end_date, statement_ending_balance_minor,
     ledger_ending_balance_minor, difference_minor, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?)`)
    .run(id, ctx.workspaceId, bank.id, date, statement, displayedLedger, difference, nowIso());
  else db.prepare(`UPDATE accounting_reconciliations SET statement_ending_balance_minor = ?,
    ledger_ending_balance_minor = ?, difference_minor = ? WHERE id = ? AND status = 'IN_PROGRESS'`)
    .run(statement, displayedLedger, difference, id);
  if (input.complete) {
    if (difference !== 0) throw new ValidationError(`Reconciliation is out by ${Math.abs(difference)} minor units.`);
    const unmatched = db.prepare(`SELECT COUNT(*) AS n FROM accounting_bank_transactions
      WHERE workspace_id = ? AND bank_account_id = ? AND transaction_date <= ? AND status = 'UNMATCHED'`)
      .get(ctx.workspaceId, bank.id, date).n;
    if (unmatched) throw new ValidationError(`${unmatched} statement transaction${unmatched === 1 ? ' is' : 's are'} still unmatched.`);
    db.prepare(`UPDATE accounting_reconciliations SET status = 'COMPLETED', completed_by_user_id = ?,
      completed_at = ? WHERE id = ?`).run(ctx.actorId, nowIso(), id);
    db.prepare(`UPDATE accounting_bank_transactions SET status = 'RECONCILED'
      WHERE workspace_id = ? AND bank_account_id = ? AND transaction_date <= ? AND status = 'MATCHED'`)
      .run(ctx.workspaceId, bank.id, date);
  }
  return db.prepare('SELECT * FROM accounting_reconciliations WHERE id = ?').get(id);
}

module.exports = { requireBank, createAccount, importTransactions, matchPayment, matchJournal,
  transfer, ledgerBalance, reconcile };
