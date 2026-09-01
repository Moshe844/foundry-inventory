'use strict';

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const { newId, nowIso } = require('../lib/util');
const ledger = require('./ledger');
const costing = require('./costing');

function nonNegativeMinor(value, label) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ValidationError(`${label} must be non-negative whole minor currency units.`);
  }
  return number;
}

function refundSale(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'record sales refunds');
  const original = ledger.getEntry(db, ctx.workspaceId, input.originalJournalEntryId);
  if (!original || original.status !== 'POSTED' || !['sales_fulfillment', 'connector_sale'].includes(original.source_type)) {
    throw new NotFoundError('Choose a posted sales-fulfillment entry from this inventory.');
  }
  const revenueMinor = nonNegativeMinor(input.revenueMinor, 'Refunded revenue');
  const taxMinor = nonNegativeMinor(input.taxMinor, 'Refunded tax');
  const cogsMinor = nonNegativeMinor(input.cogsMinor, 'Returned product cost');
  const physicalReturn = Boolean(input.physicalReturn);
  const destination = String(input.destination || 'AR').toUpperCase();
  if (!['AR', 'CASH'].includes(destination)) throw new ValidationError('Choose receivable or cash as the refund destination.');
  if (!revenueMinor && !taxMinor) throw new ValidationError('A refund needs a revenue or tax amount.');
  if (!physicalReturn && cogsMinor > 0) {
    throw new ValidationError('Product cost can be reversed only when physical return movements are confirmed.');
  }
  if (physicalReturn && !(input.movementIds || []).length) {
    throw new ValidationError('A physical return needs its confirmed incoming inventory movement.');
  }
  const originalRevenue = Number(original.metadata.revenueMinor || 0);
  const originalTax = Number(original.metadata.taxMinor || 0);
  const originalCogs = Number(original.metadata.cogsMinor || 0);
  const already = db.prepare(`SELECT COALESCE(SUM(revenue_minor),0) AS revenue,
      COALESCE(SUM(tax_minor),0) AS tax, COALESCE(SUM(cogs_minor),0) AS cogs
    FROM accounting_sale_refunds WHERE workspace_id = ? AND original_journal_entry_id = ?`)
    .get(ctx.workspaceId, original.id);
  if (Number(already.revenue) + revenueMinor > originalRevenue
    || Number(already.tax) + taxMinor > originalTax
    || Number(already.cogs) + cogsMinor > originalCogs) {
    throw new ValidationError('This refund exceeds the unrefunded amount on the original sale.');
  }
  const sourceKey = String(input.sourceKey || '').trim();
  if (!sourceKey) throw new ValidationError('Refund evidence needs a stable source key.');
  const prior = db.prepare(`SELECT * FROM accounting_sale_refunds
    WHERE workspace_id = ? AND source_key = ?`).get(ctx.workspaceId, sourceKey);
  if (prior) return { refund: prior, entry: ledger.getEntry(db, ctx.workspaceId, prior.journal_entry_id), replayed: true };

  return inTransaction(db, () => {
    const amount = revenueMinor + taxMinor;
    const originalDimensions = original.lines.filter((line) => line.sku_id);
    const uniqueSkus = [...new Set(originalDimensions.map((line) => line.sku_id))];
    const dimension = uniqueSkus.length === 1 ? {
      itemId: originalDimensions[0].item_id, skuId: uniqueSkus[0],
      locationId: originalDimensions.find((line) => line.location_id)?.location_id || null,
    } : {};
    const lines = [];
    if (revenueMinor) lines.push({ accountKey: 'SALES_RETURNS', debitMinor: revenueMinor, ...dimension });
    if (taxMinor) lines.push({ accountKey: 'SALES_TAX_PAYABLE', debitMinor: taxMinor });
    lines.push({ accountKey: destination === 'CASH' ? 'CASH' : 'ACCOUNTS_RECEIVABLE', creditMinor: amount });
    if (physicalReturn && cogsMinor) {
      lines.push({ accountKey: 'INVENTORY_ASSET', debitMinor: cogsMinor, ...dimension });
      lines.push({ accountKey: 'COST_OF_GOODS_SOLD', creditMinor: cogsMinor, ...dimension });
    }
    const posted = ledger.post(db, ctx, {
      postingDate: input.refundDate || nowIso().slice(0, 10),
      description: `Refund ${input.reference || original.description}`,
      sourceType: 'sales_refund', sourceRecordType: 'accounting_journal_entry',
      sourceRecordId: original.id, sourceEventId: input.sourceEventId || null,
      sourceKey: `sales-refund:${sourceKey}`, createdByType: input.createdByType || 'USER',
      approvedByUserId: ctx.actorId,
      metadata: { originalJournalEntryId: original.id, revenueMinor, taxMinor, cogsMinor,
        physicalReturn, destination, reference: input.reference || null },
      lines,
    });
    if (physicalReturn) costing.receive(db, ctx, {
      movementIds: input.movementIds, totalCostMinor: cogsMinor,
      journalEntryId: posted.entry.id, sourceType: 'sales_refund', sourceRecordId: original.id,
    });
    if (destination === 'AR' && original.metadata.salesOrderId) {
      const invoice = db.prepare(`SELECT * FROM accounting_customer_invoices
        WHERE workspace_id = ? AND sales_order_id = ?`).get(ctx.workspaceId, original.metadata.salesOrderId);
      if (invoice) {
        if (Number(invoice.balance_minor) < amount) {
          throw new ValidationError('The unpaid invoice balance is smaller than this receivable refund. Record the paid portion as a cash refund.');
        }
        db.prepare(`UPDATE accounting_customer_invoices SET
          discount_minor = discount_minor + ?, tax_minor = tax_minor - ?,
          total_minor = total_minor - ?, balance_minor = balance_minor - ?,
          status = CASE WHEN balance_minor - ? = 0 THEN 'PAID' ELSE 'PARTIALLY_PAID' END,
          paid_at = CASE WHEN balance_minor - ? = 0 THEN ? ELSE paid_at END,
          updated_at = ? WHERE id = ? AND workspace_id = ?`)
          .run(revenueMinor, taxMinor, amount, amount, amount, amount,
            nowIso(), nowIso(), invoice.id, ctx.workspaceId);
      }
    }
    const id = newId('refund'); const now = nowIso();
    db.prepare(`INSERT INTO accounting_sale_refunds
      (id, workspace_id, original_journal_entry_id, refund_reference, refund_date,
       revenue_minor, tax_minor, cogs_minor, physical_return, destination,
       journal_entry_id, source_key, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, original.id, input.reference || null,
        input.refundDate || now.slice(0, 10), revenueMinor, taxMinor, cogsMinor,
        physicalReturn ? 1 : 0, destination, posted.entry.id, sourceKey, ctx.actorId, now);
    return { refund: db.prepare('SELECT * FROM accounting_sale_refunds WHERE id = ?').get(id),
      entry: posted.entry, replayed: false };
  });
}

module.exports = { refundSale };
