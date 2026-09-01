'use strict';

/**
 * Foundry's read-only, workspace-scoped business state.
 *
 * This module does not mutate inventory, accounting, purchasing, authority, or
 * communication. It joins evidence already written by those deterministic
 * engines so Home, Ask Foundry, and consistency checks tell the same story.
 */

const ownerAccounting = require('../accounting/owner-dashboard');
const accountingLedger = require('../accounting/ledger');
const accountingReports = require('../accounting/reports');
const inventoryEngine = require('../domain/inventory-engine');

const number = (value) => Number(value || 0);
const plural = (value, one, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;
const money = (minor, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style: 'currency', currency,
}).format(number(minor) / 100);

function inventoryState(db, workspaceId) {
  const rows = db.prepare(`SELECT b.sku_id, b.location_id, b.on_hand,
      i.name AS item_name, s.code, s.variant_label, l.name AS location_name,
      COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a
        JOIN sales_order_lines sol ON sol.id = a.sales_order_line_id
        JOIN sales_orders so ON so.id = sol.sales_order_id
        WHERE a.workspace_id = b.workspace_id AND sol.sku_id = b.sku_id
          AND a.location_id = b.location_id
          AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')), 0) AS committed,
      COALESCE((SELECT SUM(pol.quantity_units - pol.quantity_received_units)
        FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
        WHERE pol.workspace_id = b.workspace_id AND pol.sku_id = b.sku_id
          AND COALESCE(pol.destination_location_id, po.destination_location_id) = b.location_id
          AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')), 0) AS incoming
    FROM balances b JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = b.location_id
    WHERE b.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name, s.variant_label, l.name`).all(workspaceId).map((row) => ({
    ...row,
    onHand: number(row.on_hand),
    committed: number(row.committed),
    available: number(row.on_hand) - number(row.committed),
    incoming: number(row.incoming),
  }));
  return {
    rows,
    onHand: rows.reduce((sum, row) => sum + row.onHand, 0),
    committed: rows.reduce((sum, row) => sum + row.committed, 0),
    available: rows.reduce((sum, row) => sum + row.available, 0),
    incoming: rows.reduce((sum, row) => sum + row.incoming, 0),
  };
}

function salesState(db, workspaceId, today) {
  const rows = db.prepare(`SELECT so.id, so.order_number, so.status, so.needed_by,
      c.name AS customer_name,
      SUM(sol.quantity_ordered) AS ordered,
      SUM(sol.quantity_fulfilled) AS fulfilled,
      COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a
        JOIN sales_order_lines al ON al.id = a.sales_order_line_id
        WHERE al.sales_order_id = so.id), 0) AS committed,
      SUM(sol.quantity_ordered * COALESCE(sol.unit_price_minor, 0))
        - so.discount_minor + so.tax_minor AS total_minor
    FROM sales_orders so JOIN customers c ON c.id = so.customer_id
    JOIN sales_order_lines sol ON sol.sales_order_id = so.id
    WHERE so.workspace_id = ? AND so.status <> 'CANCELLED'
    GROUP BY so.id ORDER BY COALESCE(so.needed_by, '9999-12-31'), so.created_at`).all(workspaceId)
    .map((row) => {
      const ordered = number(row.ordered);
      const fulfilled = number(row.fulfilled);
      const committed = number(row.committed);
      const outstanding = Math.max(0, ordered - fulfilled);
      const unprotected = Math.max(0, outstanding - committed);
      return { ...row, ordered, fulfilled, committed, outstanding, unprotected,
        totalMinor: number(row.total_minor), atRisk: unprotected > 0 && Boolean(row.needed_by),
        overdue: outstanding > 0 && Boolean(row.needed_by) && row.needed_by < today };
    });
  return {
    rows,
    open: rows.filter((row) => row.outstanding > 0).length,
    backorderedUnits: rows.reduce((sum, row) => sum + row.unprotected, 0),
    atRisk: rows.filter((row) => row.atRisk),
  };
}

function purchasingState(db, workspaceId, today) {
  const rows = db.prepare(`SELECT po.id, po.po_number, po.status, po.expected_date,
      s.name AS supplier_name, po.currency,
      SUM(pol.quantity_units) AS ordered,
      SUM(pol.quantity_received_units) AS received,
      SUM(COALESCE(ple.shipping_units, 0)) AS shipping,
      SUM(COALESCE(ple.backordered_units, 0)) AS backordered,
      SUM(pol.quantity_units * COALESCE(pol.unit_cost, 0)) AS ordered_cost,
      MAX(COALESCE(ple.expected_arrival_date, po.expected_date)) AS current_eta
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
    LEFT JOIN purchase_order_line_expectations ple ON ple.purchase_order_line_id = pol.id
    WHERE po.workspace_id = ? AND po.status <> 'CANCELLED'
    GROUP BY po.id ORDER BY COALESCE(current_eta, '9999-12-31'), po.created_at`).all(workspaceId)
    .map((row) => ({ ...row,
      ordered: number(row.ordered), received: number(row.received),
      outstanding: Math.max(0, number(row.ordered) - number(row.received)),
      shipping: number(row.shipping), backordered: number(row.backordered),
      orderedCostMinor: Math.round(number(row.ordered_cost) * 100),
      late: number(row.ordered) > number(row.received) && Boolean(row.current_eta)
        && row.current_eta < today,
    }));
  return { rows, open: rows.filter((row) => row.outstanding > 0).length,
    incomingUnits: rows.reduce((sum, row) => sum + row.outstanding, 0),
    backorderedUnits: rows.reduce((sum, row) => sum + row.backordered, 0),
    late: rows.filter((row) => row.late) };
}

function acquisitionState(db, workspaceId, finance) {
  const row = db.prepare(`SELECT
      COALESCE(SUM(rl.quantity_units), 0) AS units,
      COALESCE(SUM(rl.quantity_units * CAST(ROUND(pol.unit_cost * 100) AS INTEGER)), 0) AS cost_minor
    FROM purchase_order_receipt_lines rl
    JOIN purchase_order_receipts r ON r.id = rl.receipt_id
    JOIN purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
    WHERE rl.workspace_id = ?`).get(workspaceId);
  const receivedCostMinor = number(row.cost_minor);
  return {
    receivedUnits: number(row.units),
    receivedCostMinor,
    stillOwnedMinor: finance ? finance.inventory.totalCostMinor : 0,
    currentUnits: finance ? finance.inventory.totalUnits : 0,
    costedUnits: finance ? finance.inventory.costedUnits : 0,
    missingCostUnits: finance ? finance.inventory.missingCostUnits : 0,
    valuationComplete: finance ? finance.inventory.missingCostUnits === 0 : false,
    becameProductCostMinor: finance ? number(finance.pnl.cogsMinor) : 0,
    supplierBilledMinor: finance ? finance.suppliers.totalMinor : 0,
    supplierPaidMinor: finance ? finance.suppliers.paidMinor : 0,
    supplierOwedMinor: finance ? finance.suppliers.balanceMinor : 0,
    receivedWithoutBillMinor: finance
      ? finance.missingBills.reduce((sum, entry) => sum + entry.receivedCostMinor, 0) : 0,
  };
}

function connectionState(db, workspaceId) {
  const rows = db.prepare(`SELECT c.id, c.display_name AS name, c.provider_type, c.status,
      c.last_activity_at, c.expected_interval_minutes,
      (SELECT COUNT(*) FROM connection_issues ci WHERE ci.connector_id = c.id
        AND ci.workspace_id = c.workspace_id AND ci.status = 'OPEN') AS open_issues
    FROM workspace_connectors c WHERE c.workspace_id = ? ORDER BY c.display_name`).all(workspaceId)
    .map((row) => ({ ...row, openIssues: number(row.open_issues) }));
  return { rows, connected: rows.filter((row) => row.status === 'connected').length,
    unhealthy: rows.filter((row) => row.status !== 'connected' || row.openIssues > 0) };
}

function consistencyChecks(db, workspaceId, finance) {
  const checks = [];
  const inventory = inventoryEngine.verifyIntegrity(db, workspaceId);
  checks.push({ key: 'inventory-ledger', passed: inventory.ok,
    title: 'Physical inventory agrees with its movement history',
    detail: inventory.ok ? 'Every balance is supported by inventory movements.'
      : `${inventory.problems.length} inventory difference(s) need review.`, evidence: inventory.problems,
    href: '/activity?view=checks' });

  const receiptMismatch = db.prepare(`SELECT po.id, po.po_number,
      SUM(COALESCE((SELECT SUM(rl.quantity_units) FROM purchase_order_receipt_lines rl
        WHERE rl.purchase_order_line_id = pol.id), 0)) AS receipt_units,
      SUM(pol.quantity_received_units) AS line_received_units
    FROM purchase_orders po JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
    WHERE po.workspace_id = ? GROUP BY po.id
    HAVING receipt_units <> SUM(pol.quantity_received_units)`).all(workspaceId);
  checks.push({ key: 'purchase-receipts', passed: receiptMismatch.length === 0,
    title: 'Purchase-order receipts agree with received quantities',
    detail: receiptMismatch.length ? `${receiptMismatch.length} purchase order(s) disagree.` : 'Every received quantity has receipt evidence.',
    evidence: receiptMismatch, href: '/purchasing' });

  const overFulfilled = db.prepare(`SELECT so.id, so.order_number, sol.id AS line_id,
      sol.quantity_ordered, sol.quantity_fulfilled FROM sales_order_lines sol
    JOIN sales_orders so ON so.id = sol.sales_order_id
    WHERE sol.workspace_id = ? AND sol.quantity_fulfilled > sol.quantity_ordered`).all(workspaceId);
  checks.push({ key: 'sales-fulfillment', passed: overFulfilled.length === 0,
    title: 'Customer fulfillment does not exceed what was ordered',
    detail: overFulfilled.length ? `${overFulfilled.length} order line(s) exceed the order.` : 'Fulfilled quantities are inside their customer orders.',
    evidence: overFulfilled, href: '/sales' });

  if (finance) {
    const controls = accountingReports.controlReconciliation(db, workspaceId);
    const valuation = accountingReports.inventoryReconciliation(db, workspaceId);
    checks.push({ key: 'customer-balances', passed: controls.ar.reconciled,
      title: 'Customer balances agree with accounting', detail: controls.ar.reconciled
        ? 'Customer invoices and the financial control total agree.' : `Difference: ${controls.ar.differenceMinor} cents.`, evidence: controls.ar,
      href: '/accounting#customers' });
    checks.push({ key: 'supplier-balances', passed: controls.ap.reconciled,
      title: 'Supplier balances agree with accounting', detail: controls.ap.reconciled
        ? 'Supplier bills and the financial control total agree.' : `Difference: ${controls.ap.differenceMinor} cents.`, evidence: controls.ap,
      href: '/accounting#suppliers' });
    checks.push({ key: 'inventory-value', passed: valuation.reconciled,
      title: 'Inventory value agrees with accounting', detail: valuation.reconciled
        ? 'The cost attached to stock agrees with the inventory financial balance.' : `Difference: ${valuation.differenceMinor} cents.`, evidence: valuation,
      href: '/accounting#inventory' });
    checks.push({ key: 'inventory-cost-coverage', passed: true,
      complete: finance.inventory.missingCostUnits === 0,
      needsOwner: false,
      title: 'Every unit on hand has purchase-cost evidence',
      detail: finance.inventory.missingCostUnits === 0
        ? 'Every physical unit is included in the recorded inventory value.'
        : `${plural(finance.inventory.missingCostUnits, 'unit')} ${finance.inventory.missingCostUnits === 1 ? 'is' : 'are'} physically on hand without a proven purchase or opening cost, so Foundry cannot state the full inventory value.`,
      evidence: finance.inventory.rows.filter((row) => row.missingCostUnits > 0),
      href: '/accounting/migration?focus=inventory-cost#inventory-costs' });
  }

  const duplicateInvoices = db.prepare(`SELECT supplier_id, supplier_invoice_number, COUNT(*) AS copies
    FROM accounting_supplier_bills WHERE workspace_id = ? AND status <> 'VOID'
      AND supplier_invoice_number IS NOT NULL
    GROUP BY supplier_id, supplier_invoice_number HAVING COUNT(*) > 1`).all(workspaceId);
  checks.push({ key: 'supplier-invoice-duplicates', passed: duplicateInvoices.length === 0,
    title: 'Supplier invoices are not duplicated', detail: duplicateInvoices.length
      ? `${duplicateInvoices.length} repeated supplier invoice reference(s) need review.` : 'No repeated live supplier invoice reference was found.',
    evidence: duplicateInvoices, href: '/accounting#suppliers' });

  const connectorMismatch = db.prepare(`SELECT cr.id, c.display_name AS name, cr.discrepancies
    FROM connection_reconciliations cr JOIN workspace_connectors c ON c.id = cr.connector_id
    WHERE cr.workspace_id = ? AND cr.status = 'MISMATCH'
      AND cr.created_at = (SELECT MAX(newer.created_at) FROM connection_reconciliations newer
        WHERE newer.workspace_id = cr.workspace_id AND newer.connector_id = cr.connector_id)`).all(workspaceId);
  checks.push({ key: 'connections', passed: connectorMismatch.length === 0,
    title: 'Connected-system history agrees with Foundry', detail: connectorMismatch.length
      ? `${connectorMismatch.length} connection comparison(s) disagree.` : 'No current connector reconciliation mismatch was found.',
    evidence: connectorMismatch, href: '/settings/connections' });
  return checks;
}

function prioritizedAttention({ sales, purchasing, connections, finance, checks }) {
  const entries = [];
  for (const order of sales.atRisk) entries.push({ priority: order.overdue ? 100 : 92, kind: 'customer-risk',
    title: `${order.order_number} may miss ${order.needed_by}`,
    because: `${plural(order.unprotected, 'unit')} needed by ${order.customer_name} is not protected by committed stock.`,
    href: `/sales/orders/${order.id}` });
  for (const po of purchasing.late) entries.push({ priority: 88, kind: 'supplier-delay',
    title: `${po.po_number} from ${po.supplier_name} is late`,
    because: `${plural(po.outstanding, 'unit')} is still expected; the latest recorded arrival was ${po.current_eta}.`,
    href: `/purchasing/orders/${po.id}` });
  for (const connector of connections.unhealthy) entries.push({ priority: 86, kind: 'connection',
    title: `${connector.name} may make Foundry's view incomplete`,
    because: connector.openIssues ? `${plural(connector.openIssues, 'connection issue')} is open.` : `Connection status is ${connector.status}.`,
    href: `/settings/connections/${connector.id}` });
  if (finance) {
    for (const missing of finance.missingBills) entries.push({ priority: 72, kind: 'missing-bill',
      id: missing.id,
      title: `${missing.po_number} was received but has no supplier bill`,
      because: `${plural(missing.receivedUnits, 'unit')} costing ${money(missing.receivedCostMinor, missing.currency)} arrived. Foundry cannot know what is owed until the bill is recorded.`,
      href: `/accounting/payables/new?purchaseOrderId=${missing.id}` });
  }
  for (const check of checks.filter((entry) => !entry.passed && entry.needsOwner !== false)) entries.push({ priority: 96,
    id: check.key, kind: 'consistency', title: check.title, because: check.detail,
    href: check.href || '/activity?view=checks' });
  return entries.sort((a, b) => b.priority - a.priority);
}

function briefing(state) {
  const { finance, acquisition, sales, purchasing, attention, consistency, currency } = state;
  const lines = [];
  if (finance) {
    lines.push(`Customers have paid ${money(finance.cashActivity.customerReceivedMinor, currency)} during this period and still owe ${money(finance.customers.balanceMinor, currency)}.`);
    if (acquisition.receivedCostMinor > 0) lines.push(acquisition.valuationComplete
      ? `You received ${money(acquisition.receivedCostMinor, currency)} of inventory: ${money(acquisition.stillOwnedMinor, currency)} remains in stock and ${money(acquisition.becameProductCostMinor, currency)} became product cost when items sold.`
      : `You received inventory with ${money(acquisition.receivedCostMinor, currency)} of documented purchase cost. You now own ${plural(acquisition.currentUnits, 'unit')}, but cost evidence is missing for ${plural(acquisition.missingCostUnits, 'unit')}, so Foundry cannot yet state the full value still in stock or the product cost used.`
    );
    if (acquisition.supplierBilledMinor > 0) lines.push(
      `Suppliers billed ${money(acquisition.supplierBilledMinor, currency)}; ${money(acquisition.supplierPaidMinor, currency)} is recorded paid and ${money(acquisition.supplierOwedMinor, currency)} remains owed.`
    );
    if (acquisition.receivedWithoutBillMinor > 0) lines.push(
      `${money(acquisition.receivedWithoutBillMinor, currency)} of received inventory still has no supplier bill, so Foundry does not call that amount owed yet.`
    );
  }
  if (sales.open) lines.push(`${plural(sales.open, 'customer order')} remains open; ${plural(sales.backorderedUnits, 'unit')} is not yet protected by committed stock.`);
  if (purchasing.incomingUnits) lines.push(`${plural(purchasing.incomingUnits, 'supplier unit')} is still expected across ${plural(purchasing.open, 'open purchase order')}.`);
  const failed = consistency.filter((entry) => !entry.passed && entry.needsOwner !== false).length;
  const headline = failed ? `${plural(failed, 'record inconsistency')} needs review.`
    : attention.length ? `${plural(attention.length, 'business risk')} needs attention.`
      : 'Everything Foundry can prove is internally consistent.';
  return { headline, lines: lines.slice(0, 5), needsYou: attention.slice(0, 3) };
}

function purchaseOrderStory(db, workspaceId, purchaseOrderId) {
  const order = db.prepare(`SELECT po.*, s.name AS supplier_name, l.name AS destination_name
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN locations l ON l.id = po.destination_location_id
    WHERE po.workspace_id = ? AND po.id = ?`).get(workspaceId, purchaseOrderId);
  if (!order) return null;
  const lines = db.prepare(`SELECT pol.*, i.name AS item_name, sk.variant_label, sk.code,
      COALESCE(ple.confirmed_units, 0) AS confirmed_units,
      COALESCE(ple.shipping_units, 0) AS shipping_units,
      COALESCE(ple.backordered_units, 0) AS backordered_units,
      ple.expected_ship_date, ple.expected_arrival_date
    FROM purchase_order_lines pol JOIN skus sk ON sk.id = pol.sku_id
    JOIN items i ON i.id = sk.item_id
    LEFT JOIN purchase_order_line_expectations ple ON ple.purchase_order_line_id = pol.id
    WHERE pol.workspace_id = ? AND pol.purchase_order_id = ? ORDER BY pol.line_number`)
    .all(workspaceId, order.id);
  const events = db.prepare(`SELECT event AS type, detail, created_at AS at,
      'purchase_order_event' AS source FROM purchase_order_events
    WHERE workspace_id = ? AND purchase_order_id = ? ORDER BY created_at, rowid`).all(workspaceId, order.id);
  const documents = db.prepare(`SELECT id, document_type AS type, document_reference,
      facts, discrepancies, status, processed_at AS at, 'supplier_document' AS source
    FROM supplier_documents WHERE workspace_id = ? AND purchase_order_id = ?
    ORDER BY processed_at, rowid`).all(workspaceId, order.id);
  const receipts = db.prepare(`SELECT id, reference, received_at AS at,
      result, 'physical_receipt' AS source FROM purchase_order_receipts
    WHERE workspace_id = ? AND purchase_order_id = ? ORDER BY received_at, rowid`).all(workspaceId, order.id);
  const bills = db.prepare(`SELECT id, bill_number, supplier_invoice_number, status,
      total_minor, balance_minor, issue_date AS at, 'supplier_bill' AS source
    FROM accounting_supplier_bills WHERE workspace_id = ? AND purchase_order_id = ?
      AND status <> 'VOID' ORDER BY issue_date, rowid`).all(workspaceId, order.id);
  for (const bill of bills) bill.payments = db.prepare(`SELECT p.id, p.payment_number,
      p.payment_date, pa.amount_minor, p.reference FROM accounting_payment_allocations pa
    JOIN accounting_payments p ON p.id = pa.payment_id
    WHERE pa.workspace_id = ? AND pa.supplier_bill_id = ? AND p.status = 'POSTED'
    ORDER BY p.payment_date, p.rowid`).all(workspaceId, bill.id);
  const skuIds = lines.map((line) => line.sku_id);
  const demand = skuIds.length ? db.prepare(`SELECT so.id, so.order_number, so.status,
      so.needed_by, c.name AS customer_name, sol.sku_id, sol.quantity_ordered,
      sol.quantity_fulfilled, so.created_at
    FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
    JOIN customers c ON c.id = so.customer_id
    WHERE sol.workspace_id = ? AND sol.sku_id IN (${skuIds.map(() => '?').join(',')})
      AND so.status <> 'CANCELLED' AND so.created_at <= ?
    ORDER BY so.created_at`).all(workspaceId, ...skuIds, order.created_at) : [];
  const timeline = [
    ...events,
    ...documents,
    ...receipts,
    ...bills,
    ...bills.flatMap((bill) => bill.payments.map((payment) => ({ ...payment,
      type: 'supplier_payment', source: 'accounting_payment', at: payment.payment_date }))),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const ordered = lines.reduce((sum, line) => sum + number(line.quantity_units), 0);
  const received = lines.reduce((sum, line) => sum + number(line.quantity_received_units), 0);
  const billed = bills.reduce((sum, bill) => sum + number(bill.total_minor), 0);
  const paid = bills.reduce((sum, bill) => sum + number(bill.total_minor) - number(bill.balance_minor), 0);
  return {
    order, lines, demand, documents, receipts, bills, timeline,
    totals: { ordered, received, stillExpected: Math.max(0, ordered - received), billedMinor: billed,
      paidMinor: paid, owedMinor: bills.reduce((sum, bill) => sum + number(bill.balance_minor), 0) },
    explanation: {
      whatHappened: `${order.po_number} ordered ${plural(ordered, 'unit')} from ${order.supplier_name}.`,
      whyKeeperConcludedThis: demand.length
        ? `${plural(demand.reduce((sum, row) => sum + Math.max(0, number(row.quantity_ordered) - number(row.quantity_fulfilled)), 0), 'unit')} of recorded customer demand used the same product lines when this order was created.`
        : 'The purchase order keeps its source detail and work-plan evidence; no linked customer demand was found for these product lines.',
      evidenceUsed: [
        { source: 'purchase_orders', id: order.id },
        ...demand.map((row) => ({ source: 'sales_orders', id: row.id })),
        ...documents.map((row) => ({ source: 'supplier_documents', id: row.id })),
        ...receipts.map((row) => ({ source: 'purchase_order_receipts', id: row.id })),
        ...bills.map((row) => ({ source: 'accounting_supplier_bills', id: row.id })),
      ],
      keeperAction: `${plural(received, 'unit')} received; ${plural(Math.max(0, ordered - received), 'unit')} still expected.`,
      whatHappensNext: billed
        ? `${money(bills.reduce((sum, bill) => sum + number(bill.balance_minor), 0), order.currency)} remains owed on recorded supplier bills.`
        : 'Foundry is waiting for supplier-bill evidence before saying what is owed.',
    },
  };
}

function build(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const from = options.from || `${today.slice(0, 7)}-01`;
  const to = options.to || today;
  const configured = accountingLedger.settings(db, workspaceId);
  let finance = null;
  if (configured.enabled) {
    finance = ownerAccounting.ownerDashboard(db, workspaceId, { from, to, asOf: to });
    const balance = accountingReports.balanceSheet(db, workspaceId, { asOf: to });
    finance.currentCashMinor = balance.assets
      .filter((account) => account.subtype === 'CASH')
      .reduce((sum, account) => sum + number(account.net_minor), 0);
  }
  const inventory = inventoryState(db, workspaceId);
  const sales = salesState(db, workspaceId, today);
  const purchasing = purchasingState(db, workspaceId, today);
  const connections = connectionState(db, workspaceId);
  const acquisition = acquisitionState(db, workspaceId, finance);
  const consistency = consistencyChecks(db, workspaceId, finance);
  const attention = prioritizedAttention({ sales, purchasing, connections, finance, checks: consistency });
  const state = { asOf: today, period: { from, to }, currency: configured.currency || 'USD',
    inventory, sales, purchasing, connections, finance, acquisition, consistency, attention };
  state.briefing = briefing(state);
  return state;
}

module.exports = { build, inventoryState, salesState, purchasingState, acquisitionState,
  connectionState, consistencyChecks, prioritizedAttention, briefing, purchaseOrderStory, money };
