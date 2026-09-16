'use strict';

/**
 * Somebody says they paid a supplier. Work out which bill, and record it.
 *
 * Paying is not receiving. It is worth saying twice because a system that
 * blurs them tells a business its shelves are full when all that happened was
 * an invoice being settled — or that it still owes money for goods it paid
 * for last week. Nothing in here touches stock, and the routing above makes
 * sure a sentence about money can never reach the code that moves it.
 *
 * What is decided here is only which bill was meant. Whether to pay it was
 * decided by the person before they typed anything; they are reporting a fact
 * about their bank account, not asking StockChief's permission.
 */

const { nowIso } = require('../lib/util');

const money = (minor, currency = 'USD') => `${currency} ${(Number(minor || 0) / 100).toFixed(2)}`;
const compare = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/** Bills still owing something, newest first, for one supplier or all of them. */
function owing(db, workspaceId, supplierId = null) {
  return db.prepare(`SELECT b.*, s.name AS supplier_name FROM accounting_supplier_bills b
    JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.workspace_id = ? AND b.status IN ('OPEN','PARTIALLY_PAID')
      AND b.balance_minor > 0
      ${supplierId ? 'AND b.supplier_id = ?' : ''}
    ORDER BY b.due_date IS NULL, b.due_date, b.issue_date`)
    .all(...(supplierId ? [workspaceId, supplierId] : [workspaceId]));
}

function findSupplier(db, workspaceId, text) {
  const wanted = compare(text);
  if (!wanted) return null;
  const all = db.prepare('SELECT id, name FROM suppliers WHERE workspace_id = ?').all(workspaceId);
  return all.find((row) => compare(row.name) === wanted)
    || all.find((row) => compare(row.name).startsWith(wanted) || wanted.startsWith(compare(row.name)))
    || null;
}

/**
 * Which bill, and what to ask when that cannot be settled from the sentence.
 *
 * "I paid the remaining $140" names no supplier and no invoice, and it is
 * still perfectly clear to a person looking at one outstanding bill. So the
 * question is only asked when there is genuinely more than one answer.
 */
function plan(db, ctx, { supplierText, amountMinor, reference, instruction }) {
  const supplier = findSupplier(db, ctx.workspaceId, supplierText);
  if (supplierText && !supplier) {
    return { kind: 'question',
      question: `StockChief has no supplier called “${supplierText}”. Which supplier was paid?` };
  }

  const candidates = owing(db, ctx.workspaceId, supplier ? supplier.id : null);
  if (!candidates.length) {
    /*
     * A disputed bill is still money owed. Saying "nothing is outstanding"
     * because StockChief found a discrepancy on it would be telling somebody
     * their account is clear when it is not — and they came here to pay it.
     */
    const disputed = db.prepare(`SELECT b.bill_number, b.balance_minor, b.currency, s.name AS supplier_name
      FROM accounting_supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.workspace_id = ? AND b.status = 'DISPUTED' AND b.balance_minor > 0
        ${supplier ? 'AND b.supplier_id = ?' : ''}`)
      .all(...(supplier ? [ctx.workspaceId, supplier.id] : [ctx.workspaceId]));
    if (disputed.length) {
      const one = disputed[0];
      return { kind: 'question',
        question: `${one.bill_number} for ${one.supplier_name} still has `
          + `${money(one.balance_minor, one.currency)} outstanding, but StockChief found a difference `
          + 'between it and the order it is against. Settle that first, then record the payment.' };
    }
    return { kind: 'question',
      question: supplier
        ? `Nothing is outstanding for ${supplier.name}, so there is no bill to pay.`
        : 'Nothing is outstanding with any supplier, so there is no bill to pay.' };
  }

  // A quoted invoice number settles it outright.
  const quoted = compare(reference);
  const named = quoted
    ? candidates.find((bill) => compare(bill.bill_number) === quoted
      || compare(bill.supplier_invoice_number) === quoted)
    : null;

  const bill = named || (candidates.length === 1 ? candidates[0] : null);
  if (!bill) {
    return { kind: 'question',
      question: `${supplier ? supplier.name : 'That supplier'} has `
        + `${candidates.length} bills outstanding. Which one was this against?`,
      choices: candidates.slice(0, 8).map((row) => ({
        value: row.bill_number,
        label: `${row.bill_number} — ${money(row.balance_minor, row.currency)} outstanding`,
      })) };
  }

  /*
   * "The remaining" is a real amount when there is one bill in front of you.
   * Reading it off the bill is not StockChief inventing a figure; it is the only
   * figure the sentence could mean.
   */
  const paying = amountMinor === null ? Number(bill.balance_minor) : amountMinor;
  if (paying <= 0) {
    return { kind: 'question', question: 'How much was paid?' };
  }
  if (paying > Number(bill.balance_minor)) {
    return { kind: 'question',
      question: `${bill.bill_number} only has ${money(bill.balance_minor, bill.currency)} outstanding, `
        + `and this says ${money(paying, bill.currency)}. StockChief has not recorded anything — `
        + 'check the figure, or record it against the right bill.' };
  }

  return {
    kind: 'supplier_payment',
    bill,
    supplier: supplier || { id: bill.supplier_id, name: bill.supplier_name },
    amountMinor: paying,
    remainingAfterMinor: Number(bill.balance_minor) - paying,
    instruction,
  };
}

/**
 * Write it down.
 *
 * Through the same payment engine a card payment or a cheque goes through, so
 * there is one way money is recorded and one place it can be wrong.
 */
function record(db, ctx, membership, planned, options = {}) {
  const payments = require('../accounting/payments');
  const receipt = payments.record(db, ctx, membership, {
    direction: 'SUPPLIER_PAYMENT',
    supplierId: planned.supplier.id,
    paymentDate: (options.paidAt || nowIso()).slice(0, 10),
    amountMinor: planned.amountMinor,
    method: options.method || 'bank_transfer',
    reference: planned.bill.bill_number,
    sourceKey: options.sourceKey || `told-foundry:${planned.bill.id}:${planned.amountMinor}:${(options.paidAt || nowIso()).slice(0, 10)}`,
    allocations: [{ billId: planned.bill.id, amountMinor: planned.amountMinor }],
  });
  const after = db.prepare('SELECT * FROM accounting_supplier_bills WHERE id = ?').get(planned.bill.id);
  return { payment: receipt.payment || receipt, bill: after };
}

module.exports = { plan, record, owing, findSupplier };
