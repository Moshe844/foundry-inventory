'use strict';

const { ValidationError } = require('../domain/errors');
const { dateOnly, settings } = require('./ledger');

function range(input = {}) {
  const from = dateOnly(input.from || '1900-01-01', 'Report start date');
  const to = dateOnly(input.to || '9999-12-31', 'Report end date');
  if (from > to) throw new ValidationError('Report start date must be on or before its end date.');
  return { from, to };
}

function accountActivity(db, workspaceId, input = {}) {
  const { from, to } = range(input);
  return db.prepare(`SELECT a.id, a.code, a.name, a.account_type, a.subtype,
      a.normal_balance, a.system_key, a.is_control,
      COALESCE(SUM(l.debit_minor), 0) AS debit_minor,
      COALESCE(SUM(l.credit_minor), 0) AS credit_minor
    FROM accounting_accounts a
    LEFT JOIN accounting_journal_lines l ON l.account_id = a.id AND l.workspace_id = a.workspace_id
      AND l.entry_id IN (SELECT e.id FROM accounting_journal_entries e
        WHERE e.workspace_id = ? AND e.status = 'POSTED'
          AND e.posting_date BETWEEN ? AND ?)
    WHERE a.workspace_id = ?
    GROUP BY a.id ORDER BY a.code, a.rowid`).all(workspaceId, from, to, workspaceId)
    .map((row) => ({
      ...row,
      debit_minor: Number(row.debit_minor), credit_minor: Number(row.credit_minor),
      net_minor: row.normal_balance === 'DEBIT'
        ? Number(row.debit_minor) - Number(row.credit_minor)
        : Number(row.credit_minor) - Number(row.debit_minor),
    }));
}

function trialBalance(db, workspaceId, input = {}) {
  const dates = range(input);
  const accounts = accountActivity(db, workspaceId, dates).map((account) => {
    const signed = account.debit_minor - account.credit_minor;
    return {
      ...account,
      ending_debit_minor: Math.max(0, signed),
      ending_credit_minor: Math.max(0, -signed),
    };
  }).filter((account) => input.includeZero || account.debit_minor || account.credit_minor);
  const totals = accounts.reduce((sum, account) => ({
    activity_debit_minor: sum.activity_debit_minor + account.debit_minor,
    activity_credit_minor: sum.activity_credit_minor + account.credit_minor,
    ending_debit_minor: sum.ending_debit_minor + account.ending_debit_minor,
    ending_credit_minor: sum.ending_credit_minor + account.ending_credit_minor,
  }), { activity_debit_minor: 0, activity_credit_minor: 0, ending_debit_minor: 0, ending_credit_minor: 0 });
  return { ...dates, currency: settings(db, workspaceId).currency, accounts, totals,
    balanced: totals.activity_debit_minor === totals.activity_credit_minor
      && totals.ending_debit_minor === totals.ending_credit_minor };
}

function profitAndLoss(db, workspaceId, input = {}) {
  const dates = range(input);
  const activity = accountActivity(db, workspaceId, dates);
  const income = activity.filter((a) => a.account_type === 'INCOME');
  const cogs = activity.filter((a) => a.account_type === 'COGS');
  const expenses = activity.filter((a) => a.account_type === 'EXPENSE');
  // Contra-revenue accounts carry a debit normal balance, so `net_minor` is
  // positive for returns and must reduce, rather than increase, revenue.
  const revenueMinor = income.reduce((sum, a) => sum + (a.normal_balance === 'DEBIT' ? -a.net_minor : a.net_minor), 0);
  const cogsMinor = cogs.reduce((sum, a) => sum + a.net_minor, 0);
  const expenseMinor = expenses.reduce((sum, a) => sum + a.net_minor, 0);
  return {
    ...dates, currency: settings(db, workspaceId).currency,
    income, cogs, expenses,
    revenueMinor, cogsMinor,
    grossProfitMinor: revenueMinor - cogsMinor,
    operatingExpenseMinor: expenseMinor,
    operatingProfitMinor: revenueMinor - cogsMinor - expenseMinor,
    netIncomeMinor: revenueMinor - cogsMinor - expenseMinor,
  };
}

function balanceSheet(db, workspaceId, input = {}) {
  const asOf = dateOnly(input.asOf || new Date().toISOString().slice(0, 10), 'Balance sheet date');
  const activity = accountActivity(db, workspaceId, { from: '1900-01-01', to: asOf });
  const assets = activity.filter((a) => a.account_type === 'ASSET');
  const liabilities = activity.filter((a) => a.account_type === 'LIABILITY');
  const equity = activity.filter((a) => a.account_type === 'EQUITY');
  const assetMinor = assets.reduce((sum, a) => sum + a.net_minor, 0);
  const liabilityMinor = liabilities.reduce((sum, a) => sum + a.net_minor, 0);
  const postedEquityMinor = equity.reduce((sum, a) => sum + a.net_minor, 0);
  const earnings = activity.filter((a) => ['INCOME', 'COGS', 'EXPENSE'].includes(a.account_type))
    .reduce((sum, a) => {
      if (a.account_type === 'INCOME') return sum + (a.normal_balance === 'DEBIT' ? -a.net_minor : a.net_minor);
      return sum - a.net_minor;
    }, 0);
  const equityMinor = postedEquityMinor + earnings;
  return {
    asOf, currency: settings(db, workspaceId).currency,
    assets, liabilities, equity,
    assetMinor, liabilityMinor, postedEquityMinor,
    currentEarningsMinor: earnings, equityMinor,
    liabilitiesAndEquityMinor: liabilityMinor + equityMinor,
    balanced: assetMinor === liabilityMinor + equityMinor,
  };
}

function generalLedger(db, workspaceId, input = {}) {
  const dates = range(input);
  const where = [`e.workspace_id = ?`, `e.status = 'POSTED'`, `e.posting_date BETWEEN ? AND ?`];
  const params = [workspaceId, dates.from, dates.to];
  if (input.accountId) { where.push('l.account_id = ?'); params.push(input.accountId); }
  const rows = db.prepare(`SELECT e.id AS entry_id, e.entry_number, e.posting_date,
      e.description, e.source_type, e.source_record_type, e.source_record_id,
      e.source_event_id, e.reversal_of_entry_id, e.engine_version,
      l.id AS line_id, l.line_number, l.account_id, l.debit_minor, l.credit_minor,
      l.currency, l.customer_id, l.supplier_id, l.item_id, l.sku_id, l.location_id,
      l.memo, a.code AS account_code, a.name AS account_name, a.account_type
    FROM accounting_journal_entries e
    JOIN accounting_journal_lines l ON l.entry_id = e.id
    JOIN accounting_accounts a ON a.id = l.account_id
    WHERE ${where.join(' AND ')}
    ORDER BY e.posting_date, e.entry_number, l.line_number`).all(...params);
  return { ...dates, rows };
}

function cashFlow(db, workspaceId, input = {}) {
  const dates = range(input);
  const rows = db.prepare(`SELECT e.id, e.entry_number, e.posting_date, e.description,
      e.source_type, cash.debit_minor - cash.credit_minor AS cash_change_minor,
      CASE
        WHEN EXISTS (SELECT 1 FROM accounting_journal_lines ol
          JOIN accounting_accounts oa ON oa.id = ol.account_id
          WHERE ol.entry_id = e.id AND ol.id <> cash.id AND oa.account_type = 'EQUITY')
          THEN 'financing'
        WHEN EXISTS (SELECT 1 FROM accounting_journal_lines ol
          JOIN accounting_accounts oa ON oa.id = ol.account_id
          WHERE ol.entry_id = e.id AND ol.id <> cash.id AND oa.account_type = 'ASSET'
            AND COALESCE(oa.subtype, '') NOT IN ('RECEIVABLE', 'INVENTORY', 'TAX', 'CASH'))
          THEN 'investing'
        ELSE 'operating'
      END AS section
    FROM accounting_journal_entries e
    JOIN accounting_journal_lines cash ON cash.entry_id = e.id
    JOIN accounting_accounts ca ON ca.id = cash.account_id AND ca.system_key = 'CASH'
    WHERE e.workspace_id = ? AND e.status = 'POSTED' AND e.posting_date BETWEEN ? AND ?
    ORDER BY e.posting_date, e.entry_number`).all(workspaceId, dates.from, dates.to);
  const sections = { operating: 0, investing: 0, financing: 0 };
  for (const row of rows) {
    sections[row.section] += Number(row.cash_change_minor);
  }
  return { ...dates, currency: settings(db, workspaceId).currency, rows, sections,
    netCashChangeMinor: sections.operating + sections.investing + sections.financing };
}

function agingBuckets(rows, asOf) {
  const end = new Date(`${asOf}T00:00:00.000Z`).getTime();
  const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
  for (const row of rows) {
    const due = row.due_date || row.issue_date;
    const days = Math.floor((end - new Date(`${due}T00:00:00.000Z`).getTime()) / 86400000);
    const amount = Number(row.balance_minor);
    if (days <= 0) buckets.current += amount;
    else if (days <= 30) buckets.days1to30 += amount;
    else if (days <= 60) buckets.days31to60 += amount;
    else if (days <= 90) buckets.days61to90 += amount;
    else buckets.over90 += amount;
    row.daysPastDue = Math.max(0, days);
  }
  return buckets;
}

function arAging(db, workspaceId, input = {}) {
  const asOf = dateOnly(input.asOf || new Date().toISOString().slice(0, 10), 'Aging date');
  const rows = db.prepare(`SELECT i.*, c.name AS customer_name
    FROM accounting_customer_invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.workspace_id = ? AND i.issue_date <= ? AND i.balance_minor > 0
      AND i.status IN ('OPEN','PARTIALLY_PAID') ORDER BY COALESCE(i.due_date, i.issue_date), i.invoice_number`)
    .all(workspaceId, asOf);
  const buckets = agingBuckets(rows, asOf);
  return { asOf, rows, buckets, totalMinor: Object.values(buckets).reduce((sum, n) => sum + n, 0) };
}

function apAging(db, workspaceId, input = {}) {
  const asOf = dateOnly(input.asOf || new Date().toISOString().slice(0, 10), 'Aging date');
  const rows = db.prepare(`SELECT b.*, s.name AS supplier_name
    FROM accounting_supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.workspace_id = ? AND b.issue_date <= ? AND b.balance_minor > 0
      AND b.status IN ('OPEN','PARTIALLY_PAID') ORDER BY COALESCE(b.due_date, b.issue_date), b.bill_number`)
    .all(workspaceId, asOf);
  const buckets = agingBuckets(rows, asOf);
  return { asOf, rows, buckets, totalMinor: Object.values(buckets).reduce((sum, n) => sum + n, 0) };
}

function controlReconciliation(db, workspaceId, input = {}) {
  const asOf = dateOnly(input.asOf || new Date().toISOString().slice(0, 10), 'Reconciliation date');
  const activity = accountActivity(db, workspaceId, { from: '1900-01-01', to: asOf });
  const arControlMinor = Number(activity.find((row) => row.system_key === 'ACCOUNTS_RECEIVABLE')?.net_minor || 0);
  const apControlMinor = Number(activity.find((row) => row.system_key === 'ACCOUNTS_PAYABLE')?.net_minor || 0);
  const arSubledgerMinor = db.prepare(`SELECT COALESCE(SUM(balance_minor), 0) AS n
    FROM accounting_customer_invoices WHERE workspace_id = ? AND issue_date <= ?
      AND status IN ('OPEN','PARTIALLY_PAID')`).get(workspaceId, asOf).n;
  const apSubledgerMinor = db.prepare(`SELECT COALESCE(SUM(balance_minor), 0) AS n
    FROM accounting_supplier_bills WHERE workspace_id = ? AND issue_date <= ?
      AND status IN ('OPEN','PARTIALLY_PAID')`).get(workspaceId, asOf).n;
  return {
    asOf,
    ar: { controlMinor: arControlMinor, subledgerMinor: Number(arSubledgerMinor),
      differenceMinor: arControlMinor - Number(arSubledgerMinor), reconciled: arControlMinor === Number(arSubledgerMinor) },
    ap: { controlMinor: apControlMinor, subledgerMinor: Number(apSubledgerMinor),
      differenceMinor: apControlMinor - Number(apSubledgerMinor), reconciled: apControlMinor === Number(apSubledgerMinor) },
  };
}

function inventoryReconciliation(db, workspaceId, input = {}) {
  const asOf = dateOnly(input.asOf || new Date().toISOString().slice(0, 10), 'Inventory reconciliation date');
  const valuation = require('./costing').valuation(db, workspaceId);
  const inventory = accountActivity(db, workspaceId, { from: '1900-01-01', to: asOf })
    .find((row) => row.system_key === 'INVENTORY_ASSET');
  const ledgerMinor = Number(inventory?.net_minor || 0);
  return { asOf, valuationMinor: valuation.totalCostMinor, totalCostMinor: valuation.totalCostMinor,
    totalUnits: valuation.totalUnits,
    ledgerMinor,
    differenceMinor: ledgerMinor - valuation.totalCostMinor,
    reconciled: ledgerMinor === valuation.totalCostMinor, rows: valuation.rows };
}

/**
 * Owner-facing economics for the stock physically on hand right now.
 * Book cost, selling value, and potential gross profit are deliberately kept
 * separate. Missing evidence remains null and is counted; it is never treated
 * as zero or replaced with a supplier catalogue price.
 */
function inventoryEconomics(db, workspaceId, input = {}) {
  const dates = range({ from: input.from || '1900-01-01', to: input.to || '9999-12-31' });
  const rows = db.prepare(`SELECT b.sku_id, b.location_id, b.on_hand,
      s.code, s.variant_label, i.name AS item_name, l.name AS location_name,
      cb.quantity_units AS cost_quantity_units, cb.total_cost_minor,
      (SELECT sp.amount_minor FROM sku_prices sp
        WHERE sp.workspace_id = b.workspace_id AND sp.sku_id = b.sku_id
        ORDER BY sp.created_at DESC, sp.rowid DESC LIMIT 1) AS selling_price_minor,
      (SELECT sp.currency FROM sku_prices sp
        WHERE sp.workspace_id = b.workspace_id AND sp.sku_id = b.sku_id
        ORDER BY sp.created_at DESC, sp.rowid DESC LIMIT 1) AS selling_currency,
      (SELECT CAST(ROUND(si.last_unit_cost * 100) AS INTEGER)
        FROM supplier_items si WHERE si.workspace_id = b.workspace_id
          AND si.sku_id = b.sku_id AND si.is_active = 1 AND si.last_unit_cost IS NOT NULL
        ORDER BY si.is_preferred DESC, si.last_cost_at DESC, si.updated_at DESC LIMIT 1) AS supplier_reference_cost_minor,
      (SELECT sup.name FROM supplier_items si JOIN suppliers sup ON sup.id = si.supplier_id
        WHERE si.workspace_id = b.workspace_id AND si.sku_id = b.sku_id
          AND si.is_active = 1 AND si.last_unit_cost IS NOT NULL
        ORDER BY si.is_preferred DESC, si.last_cost_at DESC, si.updated_at DESC LIMIT 1) AS supplier_reference_name
    FROM balances b JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = b.location_id
    LEFT JOIN accounting_inventory_cost_balances cb ON cb.workspace_id = b.workspace_id
      AND cb.sku_id = b.sku_id AND cb.location_id = b.location_id
    WHERE b.workspace_id = ? AND b.on_hand > 0 AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name, s.position, l.name`).all(workspaceId).map((row) => {
    const units = Number(row.on_hand);
    const costKnown = row.cost_quantity_units !== null
      && Number(row.cost_quantity_units) === units && row.total_cost_minor !== null;
    const priceKnown = row.selling_price_minor !== null;
    const costMinor = costKnown ? Number(row.total_cost_minor) : null;
    const sellingValueMinor = priceKnown ? Number(row.selling_price_minor) * units : null;
    const comparable = costKnown && priceKnown;
    const potentialGrossProfitMinor = comparable ? sellingValueMinor - costMinor : null;
    return {
      ...row, units, costKnown, priceKnown, comparable,
      costMinor,
      averageUnitCostMinor: costKnown && units ? Math.round(costMinor / units) : null,
      sellingPriceMinor: priceKnown ? Number(row.selling_price_minor) : null,
      sellingValueMinor,
      potentialGrossProfitMinor,
      potentialMarginPercent: comparable && sellingValueMinor
        ? potentialGrossProfitMinor / sellingValueMinor * 100 : null,
      status: comparable ? 'complete' : costKnown ? 'missing_price' : priceKnown ? 'missing_cost' : 'missing_both',
    };
  });
  const realizedBySku = new Map(profitability(db, workspaceId,
    { ...dates, dimension: 'product' }).rows.map((row) => [row.id, row]));
  const soldBySku = new Map(db.prepare(`SELECT arl.sku_id,
      COALESCE(SUM(arl.quantity), 0) AS sold_units,
      COALESCE(SUM(arl.line_total_minor), 0) AS sold_value_minor
    FROM accounting_customer_invoice_lines arl
    JOIN accounting_customer_invoices ari ON ari.id = arl.invoice_id
    WHERE arl.workspace_id = ? AND ari.issue_date BETWEEN ? AND ?
    GROUP BY arl.sku_id`).all(workspaceId, dates.from, dates.to)
    .map((row) => [row.sku_id, row]));
  const realizedShown = new Set();
  rows.forEach((row) => {
    const realized = realizedBySku.get(row.sku_id);
    const sold = soldBySku.get(row.sku_id);
    row.soldUnits = Number(sold?.sold_units || 0);
    row.realizedRevenueMinor = Number(realized?.revenueMinor || sold?.sold_value_minor || 0);
    row.realizedCogsMinor = Number(realized?.cogsMinor || 0);
    row.realizedGrossProfitMinor = Number(realized?.grossProfitMinor || 0);
    row.showRealized = !realizedShown.has(row.sku_id);
    realizedShown.add(row.sku_id);
  });
  const comparableRows = rows.filter((row) => row.comparable);
  return {
    ...dates, rows,
    totalUnits: rows.reduce((sum, row) => sum + row.units, 0),
    knownCostMinor: rows.reduce((sum, row) => sum + (row.costMinor || 0), 0),
    costKnownUnits: rows.reduce((sum, row) => sum + (row.costKnown ? row.units : 0), 0),
    knownSellingValueMinor: rows.reduce((sum, row) => sum + (row.sellingValueMinor || 0), 0),
    priceKnownUnits: rows.reduce((sum, row) => sum + (row.priceKnown ? row.units : 0), 0),
    comparableUnits: comparableRows.reduce((sum, row) => sum + row.units, 0),
    comparableCostMinor: comparableRows.reduce((sum, row) => sum + row.costMinor, 0),
    comparableSellingValueMinor: comparableRows.reduce((sum, row) => sum + row.sellingValueMinor, 0),
    potentialGrossProfitMinor: comparableRows.reduce((sum, row) => sum + row.potentialGrossProfitMinor, 0),
    missingCostPositions: rows.filter((row) => !row.costKnown).length,
    missingPricePositions: rows.filter((row) => !row.priceKnown).length,
    complete: rows.every((row) => row.comparable),
  };
}

/** Shows how partial and complete sales/purchases become financial facts. */
function workflowFinance(db, workspaceId) {
  const sales = db.prepare(`SELECT so.id, so.order_number, so.status, so.currency,
      c.name AS customer_name,
      SUM(sol.quantity_ordered) AS ordered_units,
      SUM(sol.quantity_fulfilled) AS fulfilled_units,
      SUM(CASE WHEN sol.unit_price_minor IS NOT NULL
        THEN sol.quantity_ordered * sol.unit_price_minor ELSE 0 END) AS ordered_value_minor,
      SUM(CASE WHEN sol.unit_price_minor IS NULL THEN 1 ELSE 0 END) AS missing_price_lines,
      COALESCE(ar.gross_minor, 0) AS recognized_revenue_minor,
      COALESCE(ar.fulfilled_units, 0) AS recognized_units
    FROM sales_orders so JOIN customers c ON c.id = so.customer_id
    JOIN sales_order_lines sol ON sol.sales_order_id = so.id
    LEFT JOIN accounting_sales_recognition ar ON ar.workspace_id = so.workspace_id
      AND ar.sales_order_id = so.id
    WHERE so.workspace_id = ? AND so.status <> 'CANCELLED'
    GROUP BY so.id ORDER BY so.updated_at DESC LIMIT 8`).all(workspaceId).map((row) => ({
    ...row,
    orderedUnits: Number(row.ordered_units), fulfilledUnits: Number(row.fulfilled_units),
    orderedValueMinor: Number(row.ordered_value_minor),
    recognizedRevenueMinor: Number(row.recognized_revenue_minor),
    recognizedUnits: Number(row.recognized_units),
    pricesComplete: Number(row.missing_price_lines) === 0,
  }));
  const purchases = db.prepare(`SELECT po.id, po.po_number, po.status, po.currency,
      sup.name AS supplier_name,
      SUM(pol.quantity_units) AS ordered_units,
      SUM(pol.quantity_received_units) AS received_units,
      SUM(CASE WHEN pol.unit_cost IS NOT NULL
        THEN CAST(ROUND(pol.unit_cost * 100) AS INTEGER) * pol.quantity_units ELSE 0 END) AS ordered_cost_minor,
      SUM(CASE WHEN pol.unit_cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_lines
    FROM purchase_orders po JOIN suppliers sup ON sup.id = po.supplier_id
    JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
    WHERE po.workspace_id = ? AND po.status <> 'CANCELLED'
    GROUP BY po.id ORDER BY po.updated_at DESC LIMIT 8`).all(workspaceId).map((row) => ({
    ...row,
    orderedUnits: Number(row.ordered_units), receivedUnits: Number(row.received_units),
    orderedCostMinor: Number(row.ordered_cost_minor),
    costsComplete: Number(row.missing_cost_lines) === 0,
  }));
  return { sales, purchases };
}

function profitability(db, workspaceId, input = {}) {
  const dates = range(input);
  const dimension = input.dimension === 'location' ? 'location' : 'product';
  const select = dimension === 'location'
    ? `l.location_id AS id, COALESCE(loc.name, 'Unassigned location') AS label`
    : `l.sku_id AS id, COALESCE(i.name || CASE WHEN s.variant_label IS NULL OR s.variant_label = '' THEN '' ELSE ' / ' || s.variant_label END, 'Unassigned product') AS label`;
  const joins = dimension === 'location'
    ? 'LEFT JOIN locations loc ON loc.id = l.location_id'
    : 'LEFT JOIN skus s ON s.id = l.sku_id LEFT JOIN items i ON i.id = s.item_id';
  const rows = db.prepare(`SELECT ${select},
      SUM(CASE WHEN a.account_type = 'INCOME' THEN
        CASE WHEN a.normal_balance = 'DEBIT' THEN l.credit_minor - l.debit_minor ELSE l.credit_minor - l.debit_minor END
        ELSE 0 END) AS revenue_minor,
      SUM(CASE WHEN a.account_type = 'COGS' THEN l.debit_minor - l.credit_minor ELSE 0 END) AS cogs_minor
    FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l.entry_id
    JOIN accounting_accounts a ON a.id = l.account_id ${joins}
    WHERE l.workspace_id = ? AND e.status = 'POSTED' AND e.posting_date BETWEEN ? AND ?
      AND a.account_type IN ('INCOME','COGS')
    GROUP BY ${dimension === 'location' ? 'l.location_id' : 'l.sku_id'}
    ORDER BY (SUM(CASE WHEN a.account_type = 'INCOME' THEN l.credit_minor - l.debit_minor ELSE 0 END)
      - SUM(CASE WHEN a.account_type = 'COGS' THEN l.debit_minor - l.credit_minor ELSE 0 END)) DESC`)
    .all(workspaceId, dates.from, dates.to).map((row) => ({ ...row,
      revenueMinor: Number(row.revenue_minor), cogsMinor: Number(row.cogs_minor),
      grossProfitMinor: Number(row.revenue_minor) - Number(row.cogs_minor) }));
  return { ...dates, dimension, rows };
}

function slowInventoryValue(db, workspaceId, input = {}) {
  const before = dateOnly(input.before || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), 'Slow-stock cutoff');
  const rows = db.prepare(`SELECT b.*, i.name || CASE WHEN s.variant_label IS NULL OR s.variant_label = '' THEN '' ELSE ' / ' || s.variant_label END AS label,
      l.name AS location_name,
      (SELECT MAX(m.occurred_at) FROM movements m WHERE m.workspace_id = b.workspace_id
        AND m.sku_id = b.sku_id AND m.location_id = b.location_id AND m.quantity_delta < 0) AS last_outbound
    FROM accounting_inventory_cost_balances b JOIN skus s ON s.id = b.sku_id
    JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = b.location_id
    WHERE b.workspace_id = ? AND b.quantity_units > 0
      AND ((SELECT MAX(m.occurred_at) FROM movements m WHERE m.workspace_id = b.workspace_id
        AND m.sku_id = b.sku_id AND m.location_id = b.location_id AND m.quantity_delta < 0) IS NULL
        OR date((SELECT MAX(m.occurred_at) FROM movements m WHERE m.workspace_id = b.workspace_id
          AND m.sku_id = b.sku_id AND m.location_id = b.location_id AND m.quantity_delta < 0)) < ?)
    ORDER BY b.total_cost_minor DESC`).all(workspaceId, before);
  return { before, rows, totalCostMinor: rows.reduce((sum, row) => sum + Number(row.total_cost_minor), 0) };
}

module.exports = { accountActivity, trialBalance, profitAndLoss, balanceSheet, generalLedger,
  cashFlow, arAging, apAging, controlReconciliation, inventoryReconciliation,
  inventoryEconomics, workflowFinance, profitability, slowInventoryValue };
