'use strict';

/**
 * Owner-facing accounting read model.
 *
 * This module does not create financial facts. It joins the existing immutable
 * inventory, purchasing, sales, bill, payment, and journal evidence into the
 * plain-English story shown on Accounting. Keeping this separate from posting
 * services prevents a dashboard request from ever changing the books.
 */

const reports = require('./reports');

function number(value) { return Number(value || 0); }

function paymentsFor(db, workspaceId, column, id) {
  return db.prepare(`SELECT p.id, p.payment_number, p.payment_date, p.amount_minor,
      p.method, p.reference, pa.amount_minor AS applied_minor, p.created_at,
      u.name AS recorded_by
    FROM accounting_payment_allocations pa
    JOIN accounting_payments p ON p.id = pa.payment_id
    LEFT JOIN users u ON u.id = p.created_by_user_id
    WHERE pa.workspace_id = ? AND pa.${column} = ? AND p.status = 'POSTED'
    ORDER BY p.payment_date, p.created_at, p.id`).all(workspaceId, id)
    .map((row) => ({ ...row, amount_minor: number(row.amount_minor),
      applied_minor: number(row.applied_minor) }));
}

function customerBalances(db, workspaceId, asOf) {
  const costRows = db.prepare(`SELECT json_extract(e.metadata, '$.salesOrderId') AS sales_order_id,
      l.sku_id, SUM(l.debit_minor - l.credit_minor) AS cost_minor
    FROM accounting_journal_entries e
    JOIN accounting_journal_lines l ON l.entry_id = e.id
    JOIN accounting_accounts a ON a.id = l.account_id
    WHERE e.workspace_id = ? AND e.status = 'POSTED' AND e.posting_date <= ?
      AND e.source_type = 'sales_fulfillment' AND a.system_key = 'COST_OF_GOODS_SOLD'
    GROUP BY json_extract(e.metadata, '$.salesOrderId'), l.sku_id`)
    .all(workspaceId, asOf);
  const costByOrderSku = new Map(costRows.map((row) => [
    `${row.sales_order_id}:${row.sku_id}`, number(row.cost_minor),
  ]));
  const rows = db.prepare(`SELECT i.*, c.name AS customer_name, so.order_number,
      u.name AS recorded_by
    FROM accounting_customer_invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN sales_orders so ON so.id = i.sales_order_id
    LEFT JOIN users u ON u.id = i.created_by_user_id
    WHERE i.workspace_id = ? AND i.issue_date <= ? AND i.status <> 'VOID'
    ORDER BY CASE WHEN i.balance_minor > 0 THEN 0 ELSE 1 END,
      COALESCE(i.due_date, i.issue_date), i.invoice_number`).all(workspaceId, asOf)
    .map((row) => {
      const rawLines = db.prepare(`SELECT il.*, s.code, s.variant_label, it.name AS item_name
        FROM accounting_customer_invoice_lines il
        LEFT JOIN skus s ON s.id = il.sku_id
        LEFT JOIN items it ON it.id = s.item_id
        WHERE il.invoice_id = ? ORDER BY il.line_number`).all(row.id);
      const totalsBySku = new Map();
      for (const line of rawLines) totalsBySku.set(line.sku_id,
        number(totalsBySku.get(line.sku_id)) + Number(line.quantity));
      const lines = rawLines.map((line) => {
        const totalSkuQuantity = number(totalsBySku.get(line.sku_id));
        const skuCost = costByOrderSku.get(`${row.sales_order_id}:${line.sku_id}`);
        const costMinor = skuCost === undefined || !totalSkuQuantity ? null
          : Math.round(skuCost * Number(line.quantity) / totalSkuQuantity);
        return { ...line, quantity: Number(line.quantity), line_total_minor: number(line.line_total_minor),
          costMinor, grossProfitMinor: costMinor === null ? null : number(line.line_total_minor) - costMinor };
      });
      const paymentRows = paymentsFor(db, workspaceId, 'customer_invoice_id', row.id);
      const saleEntries = row.sales_order_id ? db.prepare(`SELECT id FROM accounting_journal_entries
        WHERE workspace_id = ? AND status = 'POSTED' AND source_type = 'sales_fulfillment'
          AND json_extract(metadata, '$.salesOrderId') = ? ORDER BY posting_date, entry_number`)
        .all(workspaceId, row.sales_order_id) : [];
      const refunds = saleEntries.flatMap((entry) => db.prepare(`SELECT r.*, u.name AS recorded_by
        FROM accounting_sale_refunds r LEFT JOIN users u ON u.id = r.created_by_user_id
        WHERE r.workspace_id = ? AND r.original_journal_entry_id = ? ORDER BY r.refund_date, r.created_at`)
        .all(workspaceId, entry.id)).map((refund) => ({ ...refund,
        amountMinor: number(refund.revenue_minor) + number(refund.tax_minor) }));
      const paidMinor = number(row.total_minor) - number(row.balance_minor);
      return { ...row, total_minor: number(row.total_minor), balance_minor: number(row.balance_minor),
        paidMinor, lines, payments: paymentRows, refunds,
        refundedMinor: refunds.reduce((sum, refund) => sum + refund.amountMinor, 0),
        originalJournalEntryId: saleEntries[0]?.id || null,
        productCostMinor: lines.some((line) => line.costMinor === null) ? null
          : lines.reduce((sum, line) => sum + line.costMinor, 0),
        daysPastDue: row.balance_minor > 0 && (row.due_date || row.issue_date) < asOf
          ? Math.floor((new Date(`${asOf}T00:00:00Z`) - new Date(`${row.due_date || row.issue_date}T00:00:00Z`)) / 86400000)
          : 0,
      };
    });
  return {
    rows,
    totalMinor: rows.reduce((sum, row) => sum + row.total_minor, 0),
    paidMinor: rows.reduce((sum, row) => sum + row.paidMinor, 0),
    balanceMinor: rows.reduce((sum, row) => sum + row.balance_minor, 0),
    overdueMinor: rows.filter((row) => row.daysPastDue > 0)
      .reduce((sum, row) => sum + row.balance_minor, 0),
  };
}

function supplierBalances(db, workspaceId, asOf) {
  const rows = db.prepare(`SELECT b.*, s.name AS supplier_name, po.po_number,
      po.status AS purchase_status, u.name AS recorded_by
    FROM accounting_supplier_bills b
    JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
    LEFT JOIN users u ON u.id = b.created_by_user_id
    WHERE b.workspace_id = ? AND b.issue_date <= ? AND b.status <> 'VOID'
    ORDER BY CASE WHEN b.balance_minor > 0 THEN 0 ELSE 1 END,
      COALESCE(b.due_date, b.issue_date), b.bill_number`).all(workspaceId, asOf)
    .map((row) => {
      const lines = db.prepare(`SELECT bl.*, a.name AS category_name, s.code,
          s.variant_label, it.name AS item_name,
          pol.quantity_units AS ordered_units, pol.quantity_received_units AS received_units
        FROM accounting_supplier_bill_lines bl
        JOIN accounting_accounts a ON a.id = bl.debit_account_id
        LEFT JOIN purchase_order_lines pol ON pol.id = bl.purchase_order_line_id
        LEFT JOIN skus s ON s.id = bl.sku_id
        LEFT JOIN items it ON it.id = s.item_id
        WHERE bl.bill_id = ? ORDER BY bl.line_number`).all(row.id)
        .map((line) => ({ ...line, quantity: Number(line.quantity),
          unit_cost_minor: number(line.unit_cost_minor), line_total_minor: number(line.line_total_minor),
          ordered_units: number(line.ordered_units), received_units: number(line.received_units) }));
      const paymentRows = paymentsFor(db, workspaceId, 'supplier_bill_id', row.id);
      const credits = db.prepare(`SELECT c.*, u.name AS recorded_by
        FROM accounting_supplier_credits c LEFT JOIN users u ON u.id = c.created_by_user_id
        WHERE c.workspace_id = ? AND c.supplier_bill_id = ? ORDER BY c.credit_date, c.created_at`)
        .all(workspaceId, row.id).map((credit) => ({ ...credit, amount_minor: number(credit.amount_minor) }));
      const paidMinor = paymentRows.reduce((sum, payment) => sum + payment.applied_minor, 0);
      const creditedMinor = credits.reduce((sum, credit) => sum + credit.amount_minor, 0);
      const po = row.purchase_order_id ? db.prepare(`SELECT
          COALESCE(SUM(quantity_units), 0) AS ordered_units,
          COALESCE(SUM(quantity_received_units), 0) AS received_units
        FROM purchase_order_lines WHERE workspace_id = ? AND purchase_order_id = ?`)
        .get(workspaceId, row.purchase_order_id) : { ordered_units: 0, received_units: 0 };
      return { ...row, total_minor: number(row.total_minor), balance_minor: number(row.balance_minor),
        paidMinor, creditedMinor, lines, payments: paymentRows, credits,
        orderedUnits: number(po.ordered_units),
        receivedUnits: number(po.received_units),
        stillExpectedUnits: Math.max(0, number(po.ordered_units) - number(po.received_units)),
        daysPastDue: row.balance_minor > 0 && (row.due_date || row.issue_date) < asOf
          ? Math.floor((new Date(`${asOf}T00:00:00Z`) - new Date(`${row.due_date || row.issue_date}T00:00:00Z`)) / 86400000)
          : 0,
      };
    });
  const dueSoonThrough = new Date(`${asOf}T00:00:00Z`);
  dueSoonThrough.setUTCDate(dueSoonThrough.getUTCDate() + 7);
  const dueSoonDate = dueSoonThrough.toISOString().slice(0, 10);
  return {
    rows,
    totalMinor: rows.filter((row) => ['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(row.status))
      .reduce((sum, row) => sum + row.total_minor, 0),
    paidMinor: rows.filter((row) => ['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(row.status))
      .reduce((sum, row) => sum + row.paidMinor, 0),
    balanceMinor: rows.filter((row) => ['OPEN', 'PARTIALLY_PAID'].includes(row.status))
      .reduce((sum, row) => sum + row.balance_minor, 0),
    overdueMinor: rows.filter((row) => row.daysPastDue > 0)
      .reduce((sum, row) => sum + row.balance_minor, 0),
    dueSoonMinor: rows.filter((row) => row.balance_minor > 0 && row.due_date
      && row.due_date >= asOf && row.due_date <= dueSoonDate)
      .reduce((sum, row) => sum + row.balance_minor, 0),
  };
}

function receivedWithoutBills(db, workspaceId) {
  return db.prepare(`SELECT po.id, po.po_number, po.currency, s.name AS supplier_name,
      SUM(pol.quantity_received_units) AS received_units,
      SUM(pol.quantity_received_units * CAST(ROUND(pol.unit_cost * 100) AS INTEGER)) AS received_cost_minor
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
    WHERE po.workspace_id = ? AND pol.quantity_received_units > 0
      AND NOT EXISTS (SELECT 1 FROM accounting_supplier_bills b
        WHERE b.workspace_id = po.workspace_id AND b.purchase_order_id = po.id
          AND b.status IN ('OPEN','PARTIALLY_PAID','PAID'))
    GROUP BY po.id
    ORDER BY po.updated_at DESC`).all(workspaceId).map((row) => ({ ...row,
    receivedUnits: number(row.received_units), receivedCostMinor: number(row.received_cost_minor),
  }));
}

function inventoryOwned(db, workspaceId) {
  // Start with physical balances so uncosted stock can never disappear from
  // the owner's accounting explanation. Cost is joined as separate evidence.
  const rows = db.prepare(`SELECT b.sku_id, b.location_id, b.on_hand,
      s.code, s.variant_label, i.name AS item_name, l.name AS location_name,
      COALESCE(cb.quantity_units, 0) AS costed_units,
      COALESCE(cb.total_cost_minor, 0) AS total_cost_minor
    FROM balances b
    JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN accounting_inventory_cost_balances cb
      ON cb.workspace_id = b.workspace_id AND cb.sku_id = b.sku_id
      AND cb.location_id = b.location_id
    WHERE b.workspace_id = ? AND b.on_hand > 0
    ORDER BY i.name, s.code, l.name`).all(workspaceId).map((row) => {
    const quantityUnits = number(row.on_hand);
    const costedUnits = Math.min(quantityUnits, number(row.costed_units));
    const totalCostMinor = number(row.total_cost_minor);
    return { ...row, quantityUnits, costedUnits,
      missingCostUnits: Math.max(0, quantityUnits - costedUnits), totalCostMinor,
      averageUnitCostMinor: costedUnits ? Math.round(totalCostMinor / costedUnits) : null };
  });
  return { rows, totalUnits: rows.reduce((sum, row) => sum + row.quantityUnits, 0),
    costedUnits: rows.reduce((sum, row) => sum + row.costedUnits, 0),
    missingCostUnits: rows.reduce((sum, row) => sum + row.missingCostUnits, 0),
    totalCostMinor: rows.reduce((sum, row) => sum + row.totalCostMinor, 0),
    skuCount: new Set(rows.map((row) => row.sku_id)).size,
    locationCount: new Set(rows.map((row) => row.location_id)).size };
}

function removalCategory(row) {
  if (row.cost_source_type === 'sales_fulfillment' || row.cost_source_type === 'connector_sale') return 'Sold to customers';
  if (row.operation === 'transfer') return 'Transferred';
  if (/damage/i.test(row.reason_code || '')) return 'Damaged';
  if (/lost|theft|missing/i.test(row.reason_code || '')) return 'Lost';
  if (/supplier|return/i.test(row.reason_code || '')) return 'Returned to supplier';
  if (row.operation === 'adjust') return 'Adjusted';
  return 'Other removal';
}

function inventoryRemoved(db, workspaceId, from, to) {
  const rows = db.prepare(`SELECT cm.*, m.operation, m.reason_code, m.notes, m.reference,
      m.occurred_at, i.name AS item_name, s.variant_label, s.code,
      l.name AS location_name, je.description AS accounting_description,
      json_extract(je.metadata, '$.salesOrderId') AS sales_order_id,
      so.order_number
    FROM accounting_inventory_cost_movements cm
    JOIN movements m ON m.id = cm.inventory_movement_id
    JOIN skus s ON s.id = cm.sku_id JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = cm.location_id
    LEFT JOIN accounting_journal_entries je ON je.id = cm.journal_entry_id
    LEFT JOIN sales_orders so ON so.id = json_extract(je.metadata, '$.salesOrderId')
    WHERE cm.workspace_id = ? AND cm.quantity_delta < 0
      AND date(m.occurred_at) BETWEEN ? AND ?
    ORDER BY m.occurred_at DESC, m.seq DESC`).all(workspaceId, from, to)
    .map((row) => ({ ...row, quantityUnits: Math.abs(number(row.quantity_delta)),
      costMinor: Math.abs(number(row.cost_delta_minor)), category: removalCategory(row) }));
  const categories = new Map();
  for (const row of rows) {
    const current = categories.get(row.category) || { label: row.category, units: 0, costMinor: 0 };
    current.units += row.quantityUnits; current.costMinor += row.costMinor;
    categories.set(row.category, current);
  }
  return { rows, categories: [...categories.values()] };
}

function expenses(db, workspaceId, from, to) {
  const rows = db.prepare(`SELECT e.id AS entry_id, e.posting_date, e.description AS entry_description,
      e.source_type, e.source_record_id, l.debit_minor - l.credit_minor AS amount_minor,
      l.memo, a.name AS category_name, a.system_key, s.name AS supplier_name,
      b.id AS bill_id, b.bill_number, b.supplier_invoice_number, b.status AS bill_status,
      b.total_minor, b.balance_minor
    FROM accounting_journal_entries e
    JOIN accounting_journal_lines l ON l.entry_id = e.id
    JOIN accounting_accounts a ON a.id = l.account_id
    LEFT JOIN suppliers s ON s.id = l.supplier_id
    LEFT JOIN accounting_supplier_bills b ON b.id = e.source_record_id AND e.source_type = 'supplier_bill'
    WHERE e.workspace_id = ? AND e.status = 'POSTED' AND e.posting_date BETWEEN ? AND ?
      AND a.account_type = 'EXPENSE'
    ORDER BY e.posting_date DESC, e.entry_number DESC, l.line_number`)
    .all(workspaceId, from, to).map((row) => ({ ...row,
      amountMinor: number(row.amount_minor), paidMinor: row.bill_id
        ? number(row.total_minor) - number(row.balance_minor) : null }));
  return { rows, totalMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0) };
}

function ownerDashboard(db, workspaceId, { from, to, asOf }) {
  const customers = customerBalances(db, workspaceId, asOf);
  const suppliers = supplierBalances(db, workspaceId, asOf);
  const inventory = inventoryOwned(db, workspaceId);
  const removals = inventoryRemoved(db, workspaceId, from, to);
  const expenseActivity = expenses(db, workspaceId, from, to);
  const pnl = reports.profitAndLoss(db, workspaceId, { from, to });
  const cash = reports.cashFlow(db, workspaceId, { from, to });
  const cashPayments = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction = 'CUSTOMER_RECEIPT' THEN amount_minor ELSE 0 END), 0) AS customer_minor,
      COALESCE(SUM(CASE WHEN direction = 'SUPPLIER_PAYMENT' THEN amount_minor ELSE 0 END), 0) AS supplier_minor
    FROM accounting_payments WHERE workspace_id = ? AND status = 'POSTED'
      AND payment_date BETWEEN ? AND ?`).get(workspaceId, from, to);
  const missingBills = receivedWithoutBills(db, workspaceId);
  const unconfirmedCustomerPayments = customers.rows.filter((row) => row.balance_minor > 0
    && !row.payment_status_confirmed_at && row.payments.length === 0);
  const slow = reports.slowInventoryValue(db, workspaceId, { before: (() => {
    const date = new Date(`${asOf}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 90);
    return date.toISOString().slice(0, 10);
  })() });
  const unitFlow = db.prepare(`SELECT
      (SELECT COALESCE(SUM(rl.quantity_units), 0)
         FROM purchase_order_receipt_lines rl
         JOIN purchase_order_receipts r ON r.id = rl.receipt_id
        WHERE rl.workspace_id = ? AND date(r.received_at) BETWEEN ? AND ?) AS received_units,
      (SELECT COALESCE(SUM(il.quantity), 0)
         FROM accounting_customer_invoice_lines il
         JOIN accounting_customer_invoices i ON i.id = il.invoice_id
        WHERE il.workspace_id = ? AND i.status <> 'VOID'
          AND i.issue_date BETWEEN ? AND ?) AS sold_units`).get(
    workspaceId, from, to, workspaceId, from, to);
  const duplicateSupplierPayments = db.prepare(`SELECT p1.payment_date, p1.amount_minor,
      s.name AS supplier_name, COUNT(*) AS copies
    FROM accounting_payments p1
    JOIN suppliers s ON s.id = p1.supplier_id
    WHERE p1.workspace_id = ? AND p1.status = 'POSTED'
      AND p1.direction = 'SUPPLIER_PAYMENT' AND p1.payment_date BETWEEN ? AND ?
    GROUP BY p1.supplier_id, p1.payment_date, p1.amount_minor,
      COALESCE(NULLIF(TRIM(p1.reference), ''), NULLIF(TRIM(p1.method), ''), '')
    HAVING COUNT(*) > 1
    ORDER BY p1.payment_date DESC`).all(workspaceId, from, to);
  const insights = [];
  if (customers.overdueMinor > 0) insights.push({ kind: 'warning', text: `Customers owe money past its due date.`, amountMinor: customers.overdueMinor });
  if (suppliers.overdueMinor > 0) insights.push({ kind: 'warning', text: `Supplier bills are past their due date.`, amountMinor: suppliers.overdueMinor });
  if (slow.totalCostMinor > 0) insights.push({ kind: 'info', text: `Inventory with no recorded sale for at least 90 days.`, amountMinor: slow.totalCostMinor });
  if (missingBills.length) insights.push({ kind: 'warning', text: `${missingBills.length} received purchase order${missingBills.length === 1 ? '' : 's'} still need supplier bill evidence.`, amountMinor: null });
  if (number(unitFlow.received_units) > number(unitFlow.sold_units)) insights.push({ kind: 'info',
    text: `You received ${number(unitFlow.received_units)} units and sold ${number(unitFlow.sold_units)} during this period. Inventory increased by ${number(unitFlow.received_units) - number(unitFlow.sold_units)} units before other removals.`, amountMinor: null });
  if (suppliers.dueSoonMinor > number(cashPayments.customer_minor)) insights.push({ kind: 'warning',
    text: `Supplier bills due within 7 days exceed customer payments recorded during this period by`,
    amountMinor: suppliers.dueSoonMinor - number(cashPayments.customer_minor) });
  for (const duplicate of duplicateSupplierPayments) insights.push({ kind: 'warning',
    text: `${duplicate.copies} identical-looking payments to ${duplicate.supplier_name} on ${duplicate.payment_date} should be reviewed for a duplicate.`,
    amountMinor: number(duplicate.amount_minor) });
  return {
    customers, suppliers, inventory, removals, expenses: expenseActivity, pnl, cash,
    cashActivity: { customerReceivedMinor: number(cashPayments.customer_minor),
      supplierPaidMinor: number(cashPayments.supplier_minor) },
    missingBills, unconfirmedCustomerPayments, insights, slowInventory: slow,
    unitFlow: { receivedUnits: number(unitFlow.received_units), soldUnits: number(unitFlow.sold_units) },
    duplicateSupplierPayments,
  };
}

module.exports = { ownerDashboard, customerBalances, supplierBalances, receivedWithoutBills,
  inventoryOwned, inventoryRemoved, expenses };
