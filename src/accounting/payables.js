'use strict';

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const { newId, nowIso, requireText } = require('../lib/util');
const ledger = require('./ledger');

function nextNumber(db, workspaceId) {
  let highest = 1000;
  for (const row of db.prepare('SELECT bill_number FROM accounting_supplier_bills WHERE workspace_id = ?').all(workspaceId)) {
    const match = String(row.bill_number || '').match(/^BILL-(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `BILL-${highest + 1}`;
}

function hydrate(db, workspaceId, id) {
  const row = db.prepare(`SELECT b.*, s.name AS supplier_name, po.po_number
    FROM accounting_supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
    WHERE b.id = ? AND b.workspace_id = ?`).get(id, workspaceId);
  if (!row) return null;
  return { ...row, exception_detail: JSON.parse(row.exception_detail || '{}'),
    lines: db.prepare(`SELECT l.*, a.code AS debit_account_code, a.name AS debit_account_name
      FROM accounting_supplier_bill_lines l JOIN accounting_accounts a ON a.id = l.debit_account_id
      WHERE l.bill_id = ? ORDER BY l.line_number`).all(id) };
}

function requireBill(db, workspaceId, id) {
  const bill = hydrate(db, workspaceId, id);
  if (!bill) throw new NotFoundError('That supplier bill could not be found.');
  return bill;
}

function createDraft(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'create supplier bills');
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ? AND workspace_id = ?')
    .get(input.supplierId, ctx.workspaceId);
  if (!supplier) throw new ValidationError('Choose a supplier from this inventory.');
  const configured = ledger.settings(db, ctx.workspaceId);
  if (!configured.enabled) throw new ValidationError('Configure accounting before creating a bill.');
  const issueDate = ledger.dateOnly(input.issueDate || nowIso().slice(0, 10), 'Bill date');
  const dueDate = input.dueDate ? ledger.dateOnly(input.dueDate, 'Bill due date') : null;
  if (dueDate && dueDate < issueDate) throw new ValidationError('Bill due date cannot be before its issue date.');
  if (!Array.isArray(input.lines) || !input.lines.length) throw new ValidationError('Add at least one bill line.');
  const lines = input.lines.map((line, index) => {
    const description = requireText(line.description, `Line ${index + 1} description`, { max: 250 });
    const quantity = Number(line.quantity);
    const unitCostMinor = Number(line.unitCostMinor);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new ValidationError(`Line ${index + 1} quantity must be greater than zero.`);
    if (!Number.isSafeInteger(unitCostMinor) || unitCostMinor < 0) throw new ValidationError(`Line ${index + 1} cost must be whole minor currency units.`);
    const lineTotalMinor = Math.round(quantity * unitCostMinor);
    const account = line.debitAccountId
      ? db.prepare(`SELECT * FROM accounting_accounts WHERE id = ? AND workspace_id = ? AND active = 1`).get(line.debitAccountId, ctx.workspaceId)
      : ledger.accountBySystemKey(db, ctx.workspaceId, line.skuId ? 'INVENTORY_ASSET' : 'OPERATING_EXPENSE');
    if (!account) throw new ValidationError(`Line ${index + 1} needs an active debit account.`);
    return { ...line, description, quantity, unitCostMinor, lineTotalMinor, account };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const tax = Number(input.taxMinor || 0);
  if (!Number.isSafeInteger(tax) || tax < 0) throw new ValidationError('Tax must use non-negative minor currency units.');
  const total = subtotal + tax;
  const sourceKey = String(input.sourceKey || `manual-bill:${newId('source')}`);
  const existing = db.prepare(`SELECT id FROM accounting_supplier_bills
    WHERE workspace_id = ? AND source_key = ?`).get(ctx.workspaceId, sourceKey);
  if (existing) return { bill: requireBill(db, ctx.workspaceId, existing.id), replayed: true };
  return inTransaction(db, () => {
    const id = newId('apbill'); const now = nowIso();
    try {
      db.prepare(`INSERT INTO accounting_supplier_bills
        (id, workspace_id, bill_number, supplier_id, purchase_order_id, purchase_receipt_id,
         supplier_invoice_number, issue_date, due_date, status, match_status, currency,
         subtotal_minor, tax_minor, total_minor, balance_minor, evidence_message_id,
         evidence_document_id, source_key, exception_detail, notes, created_by_user_id,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 'NOT_MATCHED', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`)
        .run(id, ctx.workspaceId, input.billNumber || nextNumber(db, ctx.workspaceId), supplier.id,
          input.purchaseOrderId || null, input.purchaseReceiptId || null,
          input.supplierInvoiceNumber || null, issueDate, dueDate, configured.currency,
          subtotal, tax, total, total, input.evidenceMessageId || null,
          input.evidenceDocumentId || null, sourceKey, input.notes || null, ctx.actorId, now, now);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ValidationError('That supplier invoice is already recorded.');
      throw error;
    }
    const insert = db.prepare(`INSERT INTO accounting_supplier_bill_lines
      (id, workspace_id, bill_id, line_number, description, quantity, unit_cost_minor,
       line_total_minor, debit_account_id, item_id, sku_id, purchase_order_line_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((line, index) => insert.run(newId('apline'), ctx.workspaceId, id, index + 1,
      line.description, line.quantity, line.unitCostMinor, line.lineTotalMinor, line.account.id,
      line.itemId || null, line.skuId || null, line.purchaseOrderLineId || null, now));
    return { bill: requireBill(db, ctx.workspaceId, id), replayed: false };
  });
}

function threeWayMatch(db, workspaceId, bill) {
  if (!bill.purchase_order_id) return { status: 'NOT_MATCHED', differences: [] };
  const supplier = db.prepare('SELECT price_tolerance_percent FROM suppliers WHERE id = ? AND workspace_id = ?')
    .get(bill.supplier_id, workspaceId);
  const tolerance = Number(supplier ? supplier.price_tolerance_percent : 0);
  const poLines = new Map(db.prepare(`SELECT * FROM purchase_order_lines
    WHERE purchase_order_id = ? AND workspace_id = ?`).all(bill.purchase_order_id, workspaceId).map((line) => [line.id, line]));
  const received = new Map(db.prepare(`SELECT purchase_order_line_id, SUM(quantity_units) AS quantity
    FROM purchase_order_receipt_lines WHERE workspace_id = ? AND purchase_order_line_id IN
      (SELECT id FROM purchase_order_lines WHERE purchase_order_id = ?)
    GROUP BY purchase_order_line_id`).all(workspaceId, bill.purchase_order_id)
    .map((row) => [row.purchase_order_line_id, Number(row.quantity)]));
  const previouslyBilled = new Map(db.prepare(`SELECT bl.purchase_order_line_id,
      COALESCE(SUM(bl.quantity), 0) AS quantity
    FROM accounting_supplier_bill_lines bl
    JOIN accounting_supplier_bills b ON b.id = bl.bill_id
    WHERE bl.workspace_id = ? AND b.purchase_order_id = ? AND b.id <> ?
      AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')
    GROUP BY bl.purchase_order_line_id`).all(workspaceId, bill.purchase_order_id, bill.id)
    .map((row) => [row.purchase_order_line_id, Number(row.quantity)]));
  const differences = [];
  for (const line of bill.lines) {
    const po = poLines.get(line.purchase_order_line_id);
    if (!po) { differences.push({ lineId: line.id, kind: 'missing_po_line' }); continue; }
    const ordered = Number(po.quantity_units);
    const receivedQty = Number(received.get(po.id) || 0);
    const priorBilledQty = Number(previouslyBilled.get(po.id) || 0);
    const billed = Number(line.quantity);
    if (priorBilledQty + billed > ordered) differences.push({ lineId: line.id,
      kind: 'quantity_above_ordered', ordered, previouslyBilled: priorBilledQty, billed });
    else if (priorBilledQty + billed > receivedQty) differences.push({ lineId: line.id,
      kind: 'invoice_ahead_of_receipt', ordered, received: receivedQty,
      previouslyBilled: priorBilledQty, billed });
    const orderedCost = Math.round(Number(po.unit_cost) * 100);
    const changePercent = orderedCost === 0 ? (line.unit_cost_minor === 0 ? 0 : Infinity)
      : ((Number(line.unit_cost_minor) - orderedCost) / orderedCost) * 100;
    if (Math.abs(changePercent) > tolerance) differences.push({ lineId: line.id, kind: 'price_outside_tolerance',
      orderedUnitCostMinor: orderedCost, billedUnitCostMinor: line.unit_cost_minor, changePercent, tolerancePercent: tolerance });
  }
  if (differences.some((d) => ['missing_po_line', 'quantity_above_ordered', 'price_outside_tolerance'].includes(d.kind))) {
    return { status: 'EXCEPTION', differences, tolerancePercent: tolerance };
  }
  const exact = bill.lines.every((line) => {
    const po = poLines.get(line.purchase_order_line_id);
    return po && Math.round(Number(po.unit_cost) * 100) === Number(line.unit_cost_minor)
      && Number(previouslyBilled.get(po.id) || 0) + Number(line.quantity)
        <= Number(received.get(po.id) || 0);
  });
  return { status: exact ? 'MATCHED' : 'WITHIN_TOLERANCE', differences, tolerancePercent: tolerance };
}

function open(db, ctx, membership, id) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'approve supplier bills');
  const bill = requireBill(db, ctx.workspaceId, id);
  if (bill.status !== 'DRAFT') return bill;
  const match = threeWayMatch(db, ctx.workspaceId, bill);
  if (match.status === 'EXCEPTION') {
    db.prepare(`UPDATE accounting_supplier_bills SET status = 'DISPUTED', match_status = 'EXCEPTION',
      exception_detail = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(JSON.stringify(match), nowIso(), id, ctx.workspaceId);
    return requireBill(db, ctx.workspaceId, id);
  }
  const journalLines = [];
  if (bill.purchase_order_id) {
    // Older Foundry versions recognized supplier debt at receipt time. Keep
    // those immutable journals intact, but do not create the same payable a
    // second time when the real supplier invoice is later matched.
    const legacyReceiptApMinor = Number(db.prepare(`SELECT COALESCE(SUM(jl.credit_minor - jl.debit_minor), 0) AS n
      FROM accounting_journal_entries je
      JOIN accounting_journal_lines jl ON jl.entry_id = je.id
      JOIN accounting_accounts a ON a.id = jl.account_id
      WHERE je.workspace_id = ? AND je.status = 'POSTED' AND je.source_type = 'purchase_receipt'
        AND json_extract(je.metadata, '$.purchaseOrderId') = ?
        AND a.system_key = 'ACCOUNTS_PAYABLE'`).get(ctx.workspaceId, bill.purchase_order_id).n);
    const priorBillApMinor = Number(db.prepare(`SELECT COALESCE(SUM(total_minor), 0) AS n
      FROM accounting_supplier_bills
      WHERE workspace_id = ? AND purchase_order_id = ? AND id <> ?
        AND status IN ('OPEN','PARTIALLY_PAID','PAID')`)
      .get(ctx.workspaceId, bill.purchase_order_id, bill.id).n);
    let legacyApAvailableMinor = Math.max(0, legacyReceiptApMinor - priorBillApMinor);
    let legacyApReusedMinor = 0;
    for (const line of bill.lines) {
      const po = db.prepare(`SELECT * FROM purchase_order_lines
        WHERE id = ? AND workspace_id = ? AND purchase_order_id = ?`)
        .get(line.purchase_order_line_id, ctx.workspaceId, bill.purchase_order_id);
      if (!po) throw new ValidationError('Every supplier invoice line must match the purchase order before posting.');
      const previouslyBilled = Number(db.prepare(`SELECT COALESCE(SUM(bl.quantity), 0) AS n
        FROM accounting_supplier_bill_lines bl
        JOIN accounting_supplier_bills b ON b.id = bl.bill_id
        WHERE bl.workspace_id = ? AND bl.purchase_order_line_id = ? AND b.id <> ?
          AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')`)
        .get(ctx.workspaceId, po.id, bill.id).n);
      const received = Number(db.prepare(`SELECT COALESCE(SUM(quantity_units), 0) AS n
        FROM purchase_order_receipt_lines WHERE workspace_id = ? AND purchase_order_line_id = ?`)
        .get(ctx.workspaceId, po.id).n);
      const quantity = Number(line.quantity);
      const receivedUnbilled = Math.max(0, received - previouslyBilled);
      const receivedQuantity = Math.min(quantity, receivedUnbilled);
      const inTransitQuantity = quantity - receivedQuantity;
      const orderedUnitCostMinor = Math.round(Number(po.unit_cost) * 100);
      const receivedCostMinor = Math.round(receivedQuantity * orderedUnitCostMinor);
      const inTransitCostMinor = Math.round(inTransitQuantity * orderedUnitCostMinor);
      const orderedBaseMinor = receivedCostMinor + inTransitCostMinor;
      const invoiceLineMinor = Number(line.line_total_minor);
      const varianceMinor = invoiceLineMinor - orderedBaseMinor;
      const legacyOffsetMinor = Math.min(receivedCostMinor, legacyApAvailableMinor);
      legacyApAvailableMinor -= legacyOffsetMinor;
      legacyApReusedMinor += legacyOffsetMinor;
      const receivedNotInvoicedMinor = receivedCostMinor - legacyOffsetMinor;
      const payableToRecognizeMinor = invoiceLineMinor - legacyOffsetMinor;
      if (receivedNotInvoicedMinor > 0) journalLines.push({ accountKey: 'RECEIVED_NOT_INVOICED',
        debitMinor: receivedNotInvoicedMinor, supplierId: bill.supplier_id,
        itemId: line.item_id, skuId: line.sku_id,
        memo: `${receivedQuantity} received unit${receivedQuantity === 1 ? '' : 's'} now invoiced` });
      if (inTransitCostMinor > 0) journalLines.push({ accountKey: 'INVENTORY_IN_TRANSIT',
        debitMinor: inTransitCostMinor, supplierId: bill.supplier_id,
        itemId: line.item_id, skuId: line.sku_id,
        memo: `${inTransitQuantity} invoiced unit${inTransitQuantity === 1 ? '' : 's'} still expected` });
      if (varianceMinor > 0) journalLines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE',
        debitMinor: varianceMinor, supplierId: bill.supplier_id,
        itemId: line.item_id, skuId: line.sku_id });
      else if (varianceMinor < 0) journalLines.push({ accountKey: 'PURCHASE_PRICE_VARIANCE',
        creditMinor: Math.abs(varianceMinor), supplierId: bill.supplier_id,
        itemId: line.item_id, skuId: line.sku_id });
      if (payableToRecognizeMinor > 0) journalLines.push({ accountKey: 'ACCOUNTS_PAYABLE',
        creditMinor: payableToRecognizeMinor, supplierId: bill.supplier_id,
        itemId: line.item_id, skuId: line.sku_id });
      else if (payableToRecognizeMinor < 0) journalLines.push({ accountKey: 'ACCOUNTS_PAYABLE',
        debitMinor: Math.abs(payableToRecognizeMinor), supplierId: bill.supplier_id,
        itemId: line.item_id, skuId: line.sku_id,
        memo: 'Supplier invoice is lower than the payable recorded by an earlier Foundry version' });
    }
    if (legacyApReusedMinor > 0 && journalLines.length === 0 && Number(bill.tax_minor) === 0) {
      db.prepare(`UPDATE accounting_supplier_bills SET status = 'OPEN', match_status = ?,
        opened_at = ?, updated_at = ?, exception_detail = ? WHERE id = ? AND workspace_id = ?`)
        .run(match.status, nowIso(), nowIso(), JSON.stringify({ ...match, legacyApReusedMinor }),
          id, ctx.workspaceId);
      return requireBill(db, ctx.workspaceId, id);
    }
  } else {
    journalLines.push(...bill.lines.map((line) => ({ accountId: line.debit_account_id,
      debitMinor: Number(line.line_total_minor), supplierId: bill.supplier_id,
      itemId: line.item_id, skuId: line.sku_id })));
    journalLines.push({ accountKey: 'ACCOUNTS_PAYABLE', creditMinor: Number(bill.subtotal_minor),
      supplierId: bill.supplier_id });
  }
  if (Number(bill.tax_minor)) {
    journalLines.push({ accountKey: 'SALES_TAX_RECOVERABLE', debitMinor: Number(bill.tax_minor),
      supplierId: bill.supplier_id });
    journalLines.push({ accountKey: 'ACCOUNTS_PAYABLE', creditMinor: Number(bill.tax_minor),
      supplierId: bill.supplier_id });
  }
  const posted = ledger.post(db, ctx, {
    postingDate: bill.issue_date, description: `Supplier bill ${bill.supplier_invoice_number || bill.bill_number}`,
    sourceType: 'supplier_bill', sourceRecordType: 'supplier_bill', sourceRecordId: bill.id,
    sourceKey: `supplier-bill:${bill.id}`, createdByType: 'SYSTEM', approvedByUserId: ctx.actorId,
    metadata: { purchaseOrderId: bill.purchase_order_id || null,
      purchaseReceiptId: bill.purchase_receipt_id || null, matchStatus: match.status },
    lines: journalLines,
  });
  const journalEntryId = posted.entry.id;
  db.prepare(`UPDATE accounting_supplier_bills SET status = 'OPEN', match_status = ?,
    journal_entry_id = ?, opened_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(match.status, journalEntryId, nowIso(), nowIso(), id, ctx.workspaceId);
  return requireBill(db, ctx.workspaceId, id);
}

function list(db, workspaceId, { status = null, supplierId = null } = {}) {
  const where = ['workspace_id = ?']; const params = [workspaceId];
  if (status) { where.push('status = ?'); params.push(status); }
  if (supplierId) { where.push('supplier_id = ?'); params.push(supplierId); }
  return db.prepare(`SELECT id FROM accounting_supplier_bills WHERE ${where.join(' AND ')}
    ORDER BY issue_date DESC, bill_number DESC`).all(...params).map((row) => hydrate(db, workspaceId, row.id));
}

module.exports = { nextNumber, hydrate, requireBill, createDraft, threeWayMatch, open, list };
