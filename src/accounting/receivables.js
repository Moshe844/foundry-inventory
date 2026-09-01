'use strict';

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const { newId, nowIso, requireText } = require('../lib/util');
const ledger = require('./ledger');

function nextNumber(db, workspaceId) {
  let highest = 1000;
  for (const row of db.prepare('SELECT invoice_number FROM accounting_customer_invoices WHERE workspace_id = ?').all(workspaceId)) {
    const match = String(row.invoice_number || '').match(/^INV-(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `INV-${highest + 1}`;
}

function hydrate(db, workspaceId, id) {
  const row = db.prepare(`SELECT i.*, c.name AS customer_name
    FROM accounting_customer_invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.id = ? AND i.workspace_id = ?`).get(id, workspaceId);
  if (!row) return null;
  return { ...row, lines: db.prepare(`SELECT l.*, a.code AS revenue_account_code,
    a.name AS revenue_account_name FROM accounting_customer_invoice_lines l
    JOIN accounting_accounts a ON a.id = l.revenue_account_id
    WHERE l.invoice_id = ? ORDER BY l.line_number`).all(id) };
}

function requireInvoice(db, workspaceId, id) {
  const invoice = hydrate(db, workspaceId, id);
  if (!invoice) throw new NotFoundError('That customer invoice could not be found.');
  return invoice;
}

function validateLines(db, workspaceId, rawLines) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw new ValidationError('Add at least one invoice line.');
  return rawLines.map((line, index) => {
    const description = requireText(line.description, `Line ${index + 1} description`, { max: 250 });
    const quantity = Number(line.quantity);
    const unitPriceMinor = Number(line.unitPriceMinor);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new ValidationError(`Line ${index + 1} quantity must be greater than zero.`);
    if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) throw new ValidationError(`Line ${index + 1} price must be whole minor currency units.`);
    const lineTotalMinor = Math.round(quantity * unitPriceMinor);
    if (!Number.isSafeInteger(lineTotalMinor)) throw new ValidationError(`Line ${index + 1} total is too large.`);
    const account = line.revenueAccountId
      ? db.prepare(`SELECT * FROM accounting_accounts WHERE id = ? AND workspace_id = ?
        AND account_type = 'INCOME' AND active = 1`).get(line.revenueAccountId, workspaceId)
      : ledger.accountBySystemKey(db, workspaceId, 'SALES_REVENUE');
    if (!account) throw new ValidationError(`Line ${index + 1} needs an active income account.`);
    return { ...line, description, quantity, unitPriceMinor, lineTotalMinor, account };
  });
}

function createDraft(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'create customer invoices');
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND workspace_id = ?')
    .get(input.customerId, ctx.workspaceId);
  if (!customer) throw new ValidationError('Choose a customer from this inventory.');
  const configured = ledger.settings(db, ctx.workspaceId);
  if (!configured.enabled) throw new ValidationError('Configure accounting before creating an invoice.');
  const issueDate = ledger.dateOnly(input.issueDate || nowIso().slice(0, 10), 'Invoice date');
  const dueDate = input.dueDate ? ledger.dateOnly(input.dueDate, 'Invoice due date') : null;
  if (dueDate && dueDate < issueDate) throw new ValidationError('Invoice due date cannot be before its issue date.');
  const lines = validateLines(db, ctx.workspaceId, input.lines);
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const discount = Number(input.discountMinor || 0);
  const tax = Number(input.taxMinor || 0);
  if (![discount, tax].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new ValidationError('Discount and tax must use non-negative minor currency units.');
  if (discount > subtotal) throw new ValidationError('Invoice discount cannot exceed its line subtotal.');
  const total = subtotal - discount + tax;
  const sourceKey = String(input.sourceKey || `manual-invoice:${newId('source')}`);
  const existing = db.prepare(`SELECT id FROM accounting_customer_invoices
    WHERE workspace_id = ? AND source_key = ?`).get(ctx.workspaceId, sourceKey);
  if (existing) return { invoice: requireInvoice(db, ctx.workspaceId, existing.id), replayed: true };
  return inTransaction(db, () => {
    const id = newId('arinv');
    const now = nowIso();
    db.prepare(`INSERT INTO accounting_customer_invoices
      (id, workspace_id, invoice_number, customer_id, sales_order_id, issue_date,
       due_date, status, currency, subtotal_minor, discount_minor, tax_minor,
       total_minor, balance_minor, source_key, notes, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, input.invoiceNumber || nextNumber(db, ctx.workspaceId), customer.id,
        input.salesOrderId || null, issueDate, dueDate, configured.currency,
        subtotal, discount, tax, total, total, sourceKey, input.notes || null, ctx.actorId, now, now);
    const insert = db.prepare(`INSERT INTO accounting_customer_invoice_lines
      (id, workspace_id, invoice_id, line_number, description, quantity,
       unit_price_minor, line_total_minor, revenue_account_id, item_id, sku_id,
       sales_order_line_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((line, index) => insert.run(newId('arline'), ctx.workspaceId, id, index + 1,
      line.description, line.quantity, line.unitPriceMinor, line.lineTotalMinor, line.account.id,
      line.itemId || null, line.skuId || null, line.salesOrderLineId || null, now));
    return { invoice: requireInvoice(db, ctx.workspaceId, id), replayed: false };
  });
}

function open(db, ctx, membership, id) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'approve customer invoices');
  const invoice = requireInvoice(db, ctx.workspaceId, id);
  if (invoice.status !== 'DRAFT') return invoice;
  let posted = null;
  if (invoice.sales_order_id) {
    const recognition = db.prepare(`SELECT * FROM accounting_sales_recognition
      WHERE workspace_id = ? AND sales_order_id = ?`).get(ctx.workspaceId, invoice.sales_order_id);
    if (recognition && Number(recognition.net_receivable_minor) >= Number(invoice.total_minor)) {
      const eventEntry = db.prepare(`SELECT id FROM accounting_journal_entries
        WHERE workspace_id = ? AND source_type = 'sales_fulfillment'
          AND json_extract(metadata, '$.salesOrderId') = ? ORDER BY entry_number LIMIT 1`)
        .get(ctx.workspaceId, invoice.sales_order_id);
      posted = eventEntry ? { entry: ledger.getEntry(db, ctx.workspaceId, eventEntry.id), replayed: true } : null;
    }
  }
  if (!posted) {
    const revenue = Number(invoice.subtotal_minor) - Number(invoice.discount_minor);
    const lines = [{ accountKey: 'ACCOUNTS_RECEIVABLE', debitMinor: Number(invoice.total_minor), customerId: invoice.customer_id }];
    if (revenue > 0) lines.push({ accountKey: 'SALES_REVENUE', creditMinor: revenue, customerId: invoice.customer_id });
    if (Number(invoice.tax_minor) > 0) lines.push({ accountKey: 'SALES_TAX_PAYABLE', creditMinor: Number(invoice.tax_minor), customerId: invoice.customer_id });
    posted = ledger.post(db, ctx, {
      postingDate: invoice.issue_date, description: `Customer invoice ${invoice.invoice_number}`,
      sourceType: 'customer_invoice', sourceRecordType: 'customer_invoice', sourceRecordId: invoice.id,
      sourceKey: `customer-invoice:${invoice.id}`, createdByType: 'USER', approvedByUserId: ctx.actorId,
      lines,
    });
  }
  db.prepare(`UPDATE accounting_customer_invoices SET status = 'OPEN', journal_entry_id = ?,
    opened_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'DRAFT'`)
    .run(posted && posted.entry ? posted.entry.id : null, nowIso(), nowIso(), id, ctx.workspaceId);
  return requireInvoice(db, ctx.workspaceId, id);
}

function list(db, workspaceId, { status = null, customerId = null } = {}) {
  const where = ['workspace_id = ?']; const params = [workspaceId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (customerId) { where.push('customer_id = ?'); params.push(customerId); }
  return db.prepare(`SELECT id FROM accounting_customer_invoices WHERE ${where.join(' AND ')}
    ORDER BY issue_date DESC, invoice_number DESC`).all(...params).map((row) => hydrate(db, workspaceId, row.id));
}

module.exports = { nextNumber, hydrate, requireInvoice, createDraft, open, list };
