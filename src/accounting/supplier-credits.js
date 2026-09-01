'use strict';

const { inTransaction } = require('../db');
const { ValidationError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const { newId, nowIso } = require('../lib/util');
const ledger = require('./ledger');
const costing = require('./costing');
const payables = require('./payables');

function record(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'record supplier credits');
  const bill = payables.requireBill(db, ctx.workspaceId, input.billId);
  if (!['OPEN', 'PARTIALLY_PAID'].includes(bill.status)) {
    throw new ValidationError('Choose a supplier bill that still has money owed.');
  }
  const amountMinor = Number(input.amountMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError('Supplier credit must be a positive whole minor-currency amount.');
  }
  if (amountMinor > Number(bill.balance_minor)) {
    throw new ValidationError('Supplier credit cannot exceed the amount still owed on this bill.');
  }
  const sourceKey = String(input.sourceKey || '').trim();
  if (!sourceKey) throw new ValidationError('Supplier credit evidence needs a stable source key.');
  const prior = db.prepare(`SELECT * FROM accounting_supplier_credits
    WHERE workspace_id = ? AND source_key = ?`).get(ctx.workspaceId, sourceKey);
  if (prior) return { credit: prior, entry: ledger.getEntry(db, ctx.workspaceId, prior.journal_entry_id), replayed: true };

  return inTransaction(db, () => {
    const taxCredit = Number(bill.total_minor) > 0
      ? Math.min(Number(bill.tax_minor), Math.round(amountMinor * Number(bill.tax_minor) / Number(bill.total_minor))) : 0;
    const baseCredit = amountMinor - taxCredit;
    const subtotal = Math.max(1, Number(bill.subtotal_minor));
    const journalLines = [{ accountKey: 'ACCOUNTS_PAYABLE', debitMinor: amountMinor,
      supplierId: bill.supplier_id, memo: input.creditNumber || 'Supplier credit' }];
    const valueAdjustments = [];
    let allocated = 0; let cumulative = 0;
    bill.lines.forEach((line, index) => {
      cumulative += Number(line.line_total_minor);
      const lineCredit = index === bill.lines.length - 1 ? baseCredit - allocated
        : Math.round(baseCredit * cumulative / subtotal) - allocated;
      allocated += lineCredit;
      if (lineCredit <= 0) return;
      if (!line.sku_id) {
        journalLines.push({ accountId: line.debit_account_id, creditMinor: lineCredit,
          supplierId: bill.supplier_id, itemId: line.item_id, memo: 'Supplier credit' });
        return;
      }
      const states = costing.allStates(db, ctx.workspaceId).filter((row) => row.sku_id === line.sku_id
        && Number(row.quantity_units) > 0 && Number(row.total_cost_minor) > 0);
      const available = states.reduce((sum, row) => sum + Number(row.total_cost_minor), 0);
      const inventoryCredit = Math.min(lineCredit, available);
      let distributed = 0; let cumulativeCost = 0;
      states.forEach((state, stateIndex) => {
        cumulativeCost += Number(state.total_cost_minor);
        const reduction = stateIndex === states.length - 1 ? inventoryCredit - distributed
          : Math.round(inventoryCredit * cumulativeCost / Math.max(1, available)) - distributed;
        distributed += reduction;
        if (reduction > 0) valueAdjustments.push({ skuId: state.sku_id,
          locationId: state.location_id, amountDeltaMinor: -reduction });
      });
      if (inventoryCredit > 0) journalLines.push({ accountKey: 'INVENTORY_ASSET',
        creditMinor: inventoryCredit, supplierId: bill.supplier_id,
        itemId: line.item_id, skuId: line.sku_id, memo: 'Supplier credit reduced inventory cost' });
      if (lineCredit > inventoryCredit) journalLines.push({ accountKey: 'COST_OF_GOODS_SOLD',
        creditMinor: lineCredit - inventoryCredit, supplierId: bill.supplier_id,
        itemId: line.item_id, skuId: line.sku_id, memo: 'Supplier credit for product cost already sold' });
    });
    if (taxCredit > 0) journalLines.push({ accountKey: 'SALES_TAX_RECOVERABLE',
      creditMinor: taxCredit, supplierId: bill.supplier_id, memo: 'Tax reduced by supplier credit' });
    const id = newId('apcredit'); const now = nowIso();
    const posted = ledger.post(db, ctx, {
      postingDate: input.creditDate || now.slice(0, 10),
      description: `Supplier credit ${input.creditNumber || bill.supplier_invoice_number || bill.bill_number}`,
      sourceType: 'supplier_credit', sourceRecordType: 'supplier_credit', sourceRecordId: id,
      sourceKey: `supplier-credit:${sourceKey}`, createdByType: 'USER', approvedByUserId: ctx.actorId,
      metadata: { supplierBillId: bill.id, supplierId: bill.supplier_id, amountMinor,
        creditNumber: input.creditNumber || null }, lines: journalLines,
    });
    if (valueAdjustments.length) costing.adjustValue(db, ctx, { adjustments: valueAdjustments,
      sourceType: 'supplier_credit', sourceRecordId: id, journalEntryId: posted.entry.id });
    const balance = Number(bill.balance_minor) - amountMinor;
    db.prepare(`UPDATE accounting_supplier_bills SET balance_minor = ?, status = ?,
      updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(balance, balance === 0 ? 'PAID' : 'PARTIALLY_PAID', now, bill.id, ctx.workspaceId);
    db.prepare(`INSERT INTO accounting_supplier_credits
      (id, workspace_id, supplier_bill_id, supplier_id, credit_number, credit_date,
       amount_minor, reason, evidence_document_id, journal_entry_id, source_key,
       created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, bill.id, bill.supplier_id, input.creditNumber || null,
        input.creditDate || now.slice(0, 10), amountMinor, input.reason || null,
        input.evidenceDocumentId || null, posted.entry.id, sourceKey, ctx.actorId, now);
    return { credit: db.prepare('SELECT * FROM accounting_supplier_credits WHERE id = ?').get(id),
      entry: posted.entry, replayed: false };
  });
}

module.exports = { record };
