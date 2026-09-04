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

/**
 * Money the customer already paid, against the invoice that has just appeared.
 *
 * A customer paid $300.00 for an order up front. There was no invoice yet — an
 * invoice for a sale is created when the goods go — so the receipt was recorded
 * against the order and allocated to nothing. Then shipping raised the invoice,
 * and it was raised unpaid: the Orders list read "Shipped — $300.00 still
 * owed" about an order whose money was already in the bank.
 *
 * A deposit, a prepayment and a pay-before-you-ship are all the same shape, and
 * all of them arrive before there is anything to apply them to. So when the
 * invoice appears, whatever that order has already paid is applied to it.
 *
 * Only ever what is genuinely unapplied, and never more than the invoice is
 * for: any excess stays on the order as the customer's money, which is what it
 * is, rather than being written off against an invoice that does not owe it.
 */
function applyMoneyAlreadyPaid(db, ctx, invoice) {
  if (!invoice.sales_order_id) return 0;

  const receipts = db.prepare(`SELECT p.id, p.amount_minor,
      COALESCE((SELECT SUM(a.amount_minor) FROM accounting_payment_allocations a
        WHERE a.payment_id = p.id), 0) AS allocated_minor
    FROM accounting_payments p
    WHERE p.workspace_id = ? AND p.sales_order_id = ? AND p.direction = 'CUSTOMER_RECEIPT'
      AND p.status = 'POSTED'
    ORDER BY p.payment_date, p.created_at`).all(ctx.workspaceId, invoice.sales_order_id);

  let remaining = Number(invoice.balance_minor);
  let applied = 0;
  const now = nowIso();

  for (const receipt of receipts) {
    if (remaining <= 0) break;
    const spare = Number(receipt.amount_minor) - Number(receipt.allocated_minor);
    if (spare <= 0) continue;
    const amount = Math.min(spare, remaining);
    db.prepare(`INSERT INTO accounting_payment_allocations
        (id, workspace_id, payment_id, customer_invoice_id, amount_minor, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(newId('payalloc'), ctx.workspaceId, receipt.id, invoice.id, amount, now);
    remaining -= amount;
    applied += amount;
  }

  if (applied > 0) {
    db.prepare(`UPDATE accounting_customer_invoices
      SET balance_minor = ?, status = ?, paid_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`)
      .run(remaining, remaining <= 0 ? 'PAID' : 'OPEN', remaining <= 0 ? now : null,
        now, invoice.id, ctx.workspaceId);

    /*
     * And the same movement in the books.
     *
     * Money received against no invoice is a liability: the business holds it
     * and owes goods for it, so it sits in customer deposits. Applying it to
     * an invoice does not create or destroy anything — it stops being money
     * held and becomes money that settles a debt. Marking the invoice paid
     * without this leaves the invoice saying nothing is owed while receivables
     * still says it is, and the deposit still on the books as well.
     */
    ledger.post(db, ctx, {
      postingDate: invoice.issue_date || now.slice(0, 10),
      description: `${(applied / 100).toFixed(2)} already paid applied to ${invoice.invoice_number}`,
      sourceType: 'customer_invoice',
      sourceRecordType: 'customer_invoice',
      sourceRecordId: invoice.id,
      sourceKey: `deposit-applied:${invoice.id}:${applied}`,
      createdByType: ctx.actorId ? 'USER' : 'SYSTEM',
      approvedByUserId: ctx.actorId || null,
      lines: [
        { accountKey: 'CUSTOMER_DEPOSITS', debitMinor: applied, customerId: invoice.customer_id,
          memo: 'Money the customer had already paid' },
        { accountKey: 'ACCOUNTS_RECEIVABLE', creditMinor: applied, customerId: invoice.customer_id,
          memo: `Applied to ${invoice.invoice_number}` },
      ],
    });
  }
  return applied;
}

/**
 * Money the business is holding that settles an invoice nobody applied it to.
 *
 * The repair for the hole above, over records that were written while it was
 * open. A customer paid a link, the receipt posted against their order, and
 * the invoice went on saying the money was owed — so this looks for exactly
 * that shape: a posted receipt against an order, some of it unapplied, and an
 * open invoice for the same order.
 *
 * It invents nothing. Every allocation it makes is one `applyMoneyAlreadyPaid`
 * would have made at the time, capped by the invoice balance and by what the
 * customer actually paid, and the ledger movement it posts is keyed so running
 * it again changes nothing.
 */
function settleUnappliedReceipts(db, ctx) {
  const invoices = db.prepare(`SELECT i.id FROM accounting_customer_invoices i
    WHERE i.workspace_id = ? AND i.sales_order_id IS NOT NULL
      AND i.status NOT IN ('VOID', 'PAID') AND i.balance_minor > 0
      AND EXISTS (SELECT 1 FROM accounting_payments p
        WHERE p.workspace_id = i.workspace_id AND p.sales_order_id = i.sales_order_id
          AND p.direction = 'CUSTOMER_RECEIPT' AND p.status = 'POSTED'
          AND p.amount_minor > COALESCE((SELECT SUM(a.amount_minor)
            FROM accounting_payment_allocations a WHERE a.payment_id = p.id), 0))
    ORDER BY i.issue_date, i.created_at`).all(ctx.workspaceId);

  const settled = [];
  for (const row of invoices) {
    const invoice = requireInvoice(db, ctx.workspaceId, row.id);
    const applied = applyMoneyAlreadyPaid(db, ctx, invoice);
    if (applied > 0) settled.push({ invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, appliedMinor: applied });
  }
  return settled;
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

  // Whatever this order has already been paid belongs to this invoice.
  applyMoneyAlreadyPaid(db, ctx, requireInvoice(db, ctx.workspaceId, id));
  return requireInvoice(db, ctx.workspaceId, id);
}

function list(db, workspaceId, { status = null, customerId = null } = {}) {
  const where = ['workspace_id = ?']; const params = [workspaceId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (customerId) { where.push('customer_id = ?'); params.push(customerId); }
  return db.prepare(`SELECT id FROM accounting_customer_invoices WHERE ${where.join(' AND ')}
    ORDER BY issue_date DESC, invoice_number DESC`).all(...params).map((row) => hydrate(db, workspaceId, row.id));
}

module.exports = { nextNumber, hydrate, requireInvoice, createDraft, open, list,
  applyMoneyAlreadyPaid, settleUnappliedReceipts };
