'use strict';

const { ValidationError } = require('../domain/errors');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const ledger = require('./postgres-ledger');

async function lockIdentity(db, workspaceId, supplierId, number, { native = false } = {}) {
  const normalized = trimOrNull(number)?.toLowerCase();
  if (!normalized) return [];
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [JSON.stringify(['supplier-credit', workspaceId, supplierId, normalized])]);
  if (native) return (await db.query(`SELECT id FROM accounting_supplier_credits
    WHERE workspace_id=$1 AND supplier_id=$2 AND lower(btrim(credit_number))=$3 LIMIT 1`,[workspaceId,supplierId,normalized])).rows;
  return booked(db, workspaceId, supplierId, normalized);
}

async function booked(db, workspaceId, supplierId, number) {
  return (await db.query(`SELECT c.*,b.currency,b.bill_number,a.intake_id,a.source_hash,a.tax_minor,a.evidence,a.supplier_return_id,a.return_cost_minor,
    j.status AS journal_status,j.metadata::jsonb AS journal_metadata,
    (SELECT coalesce(sum(l.credit_minor-l.debit_minor),0) FROM accounting_journal_lines l
      JOIN accounting_accounts account ON account.workspace_id=l.workspace_id AND account.id=l.account_id
      WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id AND l.supplier_id=c.supplier_id
        AND l.currency=b.currency AND account.system_key='SUPPLIER_CREDITS_RECEIVABLE') AS ledger_return_cost_minor,
    (SELECT coalesce(sum(l.credit_minor-l.debit_minor),0) FROM accounting_journal_lines l
      JOIN accounting_accounts account ON account.workspace_id=l.workspace_id AND account.id=l.account_id
      WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id AND l.supplier_id=c.supplier_id
        AND l.currency=b.currency AND account.system_key='SALES_TAX_RECOVERABLE') AS ledger_tax_minor,
    EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED') AS reversed,
    (SELECT coalesce(sum(l.debit_minor-l.credit_minor),0) FROM accounting_journal_lines l
      JOIN accounting_accounts account ON account.workspace_id=l.workspace_id AND account.id=l.account_id
      WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id AND l.supplier_id=c.supplier_id
        AND l.currency=b.currency AND account.system_key='ACCOUNTS_PAYABLE') AS payable_minor
    FROM accounting_supplier_credits c
    JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id
    LEFT JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
    LEFT JOIN stockchief_runtime.agent_supplier_credit_applications a ON a.workspace_id=c.workspace_id AND a.credit_id=c.id
    WHERE c.workspace_id=$1 AND c.supplier_id=$2 AND lower(btrim(c.credit_number))=lower(btrim($3))
    ORDER BY c.created_at,c.id`, [workspaceId, supplierId, number])).rows;
}

async function insert(db, ctx, bill, { id, creditNumber, creditDate, amountMinor, reason, journalEntryId, sourceKey }) {
  const balanceMinor = Number(bill.balance_minor) - amountMinor;
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < 0) {
    throw new ValidationError('The supplier credit cannot exceed the current amount owed on this bill.');
  }
  const at = nowIso();
  await db.query(`UPDATE accounting_supplier_bills SET balance_minor=$3::bigint,status=$4,updated_at=$5,
    paid_at=CASE WHEN $3::bigint=0 THEN $5 ELSE paid_at END WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId, bill.id, balanceMinor, balanceMinor === 0 ? 'PAID' : 'PARTIALLY_PAID', at]);
  await db.query(`INSERT INTO accounting_supplier_credits
    (id,workspace_id,supplier_bill_id,supplier_id,credit_number,credit_date,amount_minor,reason,
     journal_entry_id,source_key,created_by_user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [id, ctx.workspaceId, bill.id, bill.supplier_id, trimOrNull(creditNumber), creditDate,
    amountMinor, reason, journalEntryId, sourceKey, ctx.actorId, at]);
  return { supplierCreditId: id, billId: bill.id, balanceMinor, amountMinor, journalEntryId };
}

// A supplier-issued commercial allowance changes what is owed. Original
// receiving and weighted-average cost evidence stays tied to the physical event.
async function applySourceCredit(db, ctx, bill, input) {
  const id = newId('apcredit');
  const { amountMinor, taxMinor, creditNumber, creditDate, sourceKey } = input;
  const lines = [{ accountKey: 'ACCOUNTS_PAYABLE', debitMinor: amountMinor, supplierId: bill.supplier_id }];
  if (taxMinor) lines.push({ accountKey: 'SALES_TAX_RECOVERABLE', creditMinor: taxMinor, supplierId: bill.supplier_id });
  const returnCostMinor = input.returnCostMinor ?? 0;
  if (returnCostMinor) lines.push({ accountKey: 'SUPPLIER_CREDITS_RECEIVABLE', creditMinor: returnCostMinor, supplierId: bill.supplier_id });
  const variance = amountMinor - taxMinor - returnCostMinor;
  if (variance) lines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE', creditMinor: Math.max(variance, 0),
    debitMinor: Math.max(-variance, 0), supplierId: bill.supplier_id });
  const posted = await ledger.postInTransaction(db, ctx, {
    postingDate: input.postingDate,
    sourceKey,
    description: `Supplier credit ${creditNumber}`,
    sourceType: 'supplier_credit',
    sourceRecordType: input.returnId ? 'supplier_return' : 'supplier_credit',
    sourceRecordId: input.returnId || id,
    currency: bill.currency,
    metadata: { supplierBillId: bill.id, sourceNoteHash: input.sourceHash, originalBillId: input.originalBillId,
      amountMinor, creditDate, taxCreditMinor: taxMinor, ...(input.returnId ? { supplierReturnId: input.returnId, returnCostMinor } : {}) },
    lines,
  });
  return insert(db, ctx, bill, { ...input, id, journalEntryId: posted.entry.id });
}

module.exports = { applySourceCredit, booked, insert, lockIdentity };
