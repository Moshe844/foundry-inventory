'use strict';

const express = require('express');
const paymentIntent = require('../../accounting/payment-intent');
const { requireAuth, asyncRoute } = require('../middleware');
const permissions = require('../../actions/permissions');
const ledger = require('../../accounting/ledger');
const reports = require('../../accounting/reports');
const costing = require('../../accounting/costing');
const openingBalances = require('../../accounting/opening-balances');
const openingCostEvidence = require('../../accounting/opening-cost-evidence');
const automaticAccounting = require('../../accounting/automatic');
const operationalAccounting = require('../../accounting/operational-adapter');
const ownerAccounting = require('../../accounting/owner-dashboard');
const sales = require('../../sales/sales-order-service');
const purchaseOrders = require('../../purchasing/po-service');
const receivables = require('../../accounting/receivables');
const payables = require('../../accounting/payables');
const payments = require('../../accounting/payments');
const refunds = require('../../accounting/refunds');
const supplierCredits = require('../../accounting/supplier-credits');
const banking = require('../../accounting/banking');
const tax = require('../../accounting/tax');
const pricing = require('../../pricing/price-service');
const { ValidationError } = require('../../domain/errors');
const { trimOrNull, newId, nowIso } = require('../../lib/util');

/*
 * Two addresses, one page, on purpose.
 *
 * The nav now says Orders and Money, so those are the addresses it uses. The
 * older paths keep serving the same handler rather than redirecting, because
 * they are in bookmarks, in links across the app and in a year of tests, and a
 * redirect would still be two addresses with a round trip added. Nothing here
 * renders differently depending on which one you arrive by.
 */
const router = express.Router();
router.use(['/accounting', '/money'], requireAuth);

function permit(permission, action) {
  return (req, res, next) => {
    try { permissions.assertCan(req.user, permission, action); return next(); }
    catch (error) { return next(error); }
  };
}

function today() {
  const date = new Date();
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}
function monthStart() { return `${today().slice(0, 7)}-01`; }
function utcDate(value) { return new Date(`${value}T00:00:00.000Z`); }
function dateText(value) { return value.toISOString().slice(0, 10); }
function startOfWeek(value) {
  const date = utcDate(value); const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1); return dateText(date);
}
function ownerPeriod(query, throughDate, accountingStart) {
  const choice = String(query.period || 'this_month');
  const current = utcDate(throughDate);
  let from; let to = throughDate; let label;
  if (choice === 'today') { from = throughDate; label = 'Today'; }
  else if (choice === 'this_week') { from = startOfWeek(throughDate); label = 'This week'; }
  else if (choice === 'last_month') {
    const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0));
    from = dateText(first); to = dateText(last); label = 'Last month';
  } else if (choice === 'this_quarter') {
    from = dateText(new Date(Date.UTC(current.getUTCFullYear(),
      Math.floor(current.getUTCMonth() / 3) * 3, 1))); label = 'This quarter';
  } else if (choice === 'this_year') { from = `${throughDate.slice(0, 4)}-01-01`; label = 'This year'; }
  else if (choice === 'all_time') { from = accountingStart || '1900-01-01'; label = 'All time'; }
  else if (choice === 'custom') {
    from = ledger.dateOnly(query.from || throughDate, 'Start date');
    to = ledger.dateOnly(query.to || throughDate, 'End date');
    if (from > to) throw new ValidationError('The start date must be on or before the end date.');
    if (to > throughDate) to = throughDate;
    label = 'Custom dates';
  } else { from = `${throughDate.slice(0, 7)}-01`; label = 'This month'; }
  return { key: choice, from, to, label };
}
function signedMinor(value, label) {
  const text = String(value ?? '').trim();
  const negative = text.startsWith('-');
  const amount = pricing.toMinor(negative ? text.slice(1) : text, label);
  return negative ? -amount : amount;
}

function documentTaxMinor(req, taxableMinor, appliesTo) {
  const explicit = trimOrNull(req.body.tax);
  if (explicit !== null) return pricing.toMinor(explicit, 'Tax');
  const taxRateId = trimOrNull(req.body.taxRateId);
  return taxRateId ? tax.calculate(req.db, req.ctx.workspaceId, taxRateId, taxableMinor,
    req.body.issueDate, appliesTo) : 0;
}
function formArray(value) { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }

function setupPositions(db, workspaceId) {
  return db.prepare(`SELECT b.sku_id, b.location_id, b.on_hand, s.code, s.variant_label,
      i.name AS item_name, l.name AS location_name
    FROM balances b JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = b.location_id
    WHERE b.workspace_id = ? AND b.on_hand > 0 AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name, s.position, l.name`).all(workspaceId);
}

router.get(['/money', '/accounting'], permit(permissions.VIEW_ACCOUNTING, 'view accounting'), asyncRoute(async (req, res) => {
  const automatic = automaticAccounting.ensure(req.db, req.ctx.workspaceId, {
    actorId: req.ctx.actorId, recoverCurrent: true,
  });
  const configured = automatic.configured;
  // Operational timestamps are stored in UTC while the owner may still be on
  // the preceding local date. Never hide a just-posted entry behind that
  // midnight boundary on the daily dashboard.
  const latestPosting = req.db.prepare(`SELECT MAX(posting_date) AS date
    FROM accounting_journal_entries WHERE workspace_id = ? AND status = 'POSTED'`)
    .get(req.ctx.workspaceId).date;
  const throughDate = [today(), latestPosting, configured.startDate]
    .filter(Boolean).sort().at(-1);
  const period = ownerPeriod(req.query, throughDate, configured.startDate);
  const periodStart = period.from;
  const periodEnd = period.to;
  const pnl = reports.profitAndLoss(req.db, req.ctx.workspaceId, { from: periodStart, to: periodEnd });
  const lifetimePnl = reports.profitAndLoss(req.db, req.ctx.workspaceId, {
    from: configured.startDate || '1900-01-01', to: throughDate,
  });
  const balance = reports.balanceSheet(req.db, req.ctx.workspaceId, { asOf: throughDate });
  const ar = reports.arAging(req.db, req.ctx.workspaceId, { asOf: throughDate });
  const ap = reports.apAging(req.db, req.ctx.workspaceId, { asOf: throughDate });
  const valuation = costing.valuation(req.db, req.ctx.workspaceId);
  const controls = reports.controlReconciliation(req.db, req.ctx.workspaceId, { asOf: throughDate });
  const inventoryControl = reports.inventoryReconciliation(req.db, req.ctx.workspaceId, { asOf: throughDate });
  const inventoryEconomics = reports.inventoryEconomics(req.db, req.ctx.workspaceId,
    { from: periodStart, to: periodEnd });
  const workflowFinance = reports.workflowFinance(req.db, req.ctx.workspaceId);
  const inventoryAcquired = req.db.prepare(`SELECT
      COALESCE(SUM(prl.quantity_units), 0) AS units,
      COALESCE(SUM(prl.quantity_units * CAST(ROUND(pol.unit_cost * 100) AS INTEGER)), 0) AS cost_minor
    FROM purchase_order_receipt_lines prl
    JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
    WHERE prl.workspace_id = ? AND pol.unit_cost IS NOT NULL`).get(req.ctx.workspaceId);
  const openingInventory = req.db.prepare(`SELECT
      COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0) AS cost_minor
    FROM accounting_journal_lines jl
    JOIN accounting_journal_entries je ON je.id = jl.entry_id
    JOIN accounting_accounts aa ON aa.id = jl.account_id
    WHERE jl.workspace_id = ? AND je.status = 'POSTED'
      AND aa.system_key = 'INVENTORY_ASSET'
      AND (je.source_type = 'opening_balance' OR je.source_record_type = 'supplier_item_cost')`)
    .get(req.ctx.workspaceId);
  const supplierPaid = req.db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor
    FROM accounting_payments WHERE workspace_id = ? AND direction = 'SUPPLIER_PAYMENT'
      AND status = 'POSTED'`).get(req.ctx.workspaceId);
  const supplierBills = req.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('OPEN','PARTIALLY_PAID','PAID') THEN 1 ELSE 0 END), 0) AS count,
      COALESCE(SUM(CASE WHEN status IN ('OPEN','PARTIALLY_PAID','PAID') THEN total_minor ELSE 0 END), 0) AS total_minor,
      COALESCE(SUM(CASE WHEN status IN ('OPEN','PARTIALLY_PAID','PAID') THEN balance_minor ELSE 0 END), 0) AS balance_minor,
      COALESCE(SUM(CASE WHEN status IN ('OPEN','PARTIALLY_PAID','PAID') THEN total_minor - balance_minor ELSE 0 END), 0) AS paid_minor,
      COALESCE(SUM(CASE WHEN status IN ('DRAFT','DISPUTED') THEN 1 ELSE 0 END), 0) AS review_count
    FROM accounting_supplier_bills
    WHERE workspace_id = ? AND issue_date <= ? AND status <> 'VOID'`)
    .get(req.ctx.workspaceId, throughDate);
  const cashActivity = req.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction = 'CUSTOMER_RECEIPT' THEN amount_minor ELSE 0 END), 0) AS customer_received_minor,
      COALESCE(SUM(CASE WHEN direction = 'SUPPLIER_PAYMENT' THEN amount_minor ELSE 0 END), 0) AS supplier_paid_minor
    FROM accounting_payments WHERE workspace_id = ? AND status = 'POSTED'
      AND payment_date BETWEEN ? AND ?`).get(req.ctx.workspaceId, periodStart, periodEnd);
  const lifetimePayments = req.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction = 'CUSTOMER_RECEIPT' THEN amount_minor ELSE 0 END), 0) AS customer_received_minor,
      COALESCE(SUM(CASE WHEN direction = 'SUPPLIER_PAYMENT' THEN amount_minor ELSE 0 END), 0) AS supplier_paid_minor
    FROM accounting_payments WHERE workspace_id = ? AND status = 'POSTED'
      AND payment_date <= ?`).get(req.ctx.workspaceId, throughDate);
  const cashHistory = req.db.prepare(`SELECT
      COALESCE(SUM(jl.debit_minor), 0) AS cash_in_minor,
      COALESCE(SUM(jl.credit_minor), 0) AS cash_out_minor
    FROM accounting_journal_lines jl
    JOIN accounting_journal_entries je ON je.id = jl.entry_id
    JOIN accounting_accounts aa ON aa.id = jl.account_id
    WHERE jl.workspace_id = ? AND je.status = 'POSTED' AND je.posting_date <= ?
      AND aa.account_type = 'ASSET' AND aa.subtype = 'CASH'`)
    .get(req.ctx.workspaceId, throughDate);
  const cashMinor = balance.assets.filter((a) => a.subtype === 'CASH').reduce((sum, a) => sum + a.net_minor, 0);
  const review = req.db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND status IN ('NEEDS_REVIEW','FAILED') ORDER BY created_at DESC`)
    .all(req.ctx.workspaceId).map((row) => ({ ...row, outcome: JSON.parse(row.outcome || '{}') }));
  const recentEntries = req.db.prepare(`SELECT * FROM accounting_journal_entries
    WHERE workspace_id = ? AND status = 'POSTED' ORDER BY posting_date DESC, entry_number DESC LIMIT 8`)
    .all(req.ctx.workspaceId);
  const receivedCostMinor = Number(inventoryAcquired.cost_minor);
  const openingCostMinor = Number(openingInventory.cost_minor);
  const acquiredCostMinor = receivedCostMinor + openingCostMinor;
  const otherInventoryReductionMinor = acquiredCostMinor
    - Number(lifetimePnl.cogsMinor) - Number(inventoryEconomics.knownCostMinor);
  const owner = ownerAccounting.ownerDashboard(req.db, req.ctx.workspaceId, {
    from: periodStart, to: periodEnd, asOf: throughDate,
  });
  return res.page('accounting/index', {
    title: 'Accounting', nav: 'accounting', configured, pnl, lifetimePnl, balance, ar, ap,
    valuation, controls, inventoryControl, inventoryEconomics, workflowFinance,
    automatic, cashMinor, review, recentEntries, cashActivity: {
      customerReceivedMinor: Number(cashActivity.customer_received_minor),
      supplierPaidMinor: Number(cashActivity.supplier_paid_minor),
    }, cashHistory: {
      cashInMinor: Number(cashHistory.cash_in_minor),
      cashOutMinor: Number(cashHistory.cash_out_minor),
      customerReceivedMinor: Number(lifetimePayments.customer_received_minor),
      supplierPaidMinor: Number(lifetimePayments.supplier_paid_minor),
    }, supplierBills: {
      count: Number(supplierBills.count), totalMinor: Number(supplierBills.total_minor),
      balanceMinor: Number(supplierBills.balance_minor), paidMinor: Number(supplierBills.paid_minor),
      reviewCount: Number(supplierBills.review_count),
    }, inventoryAcquired: {
      units: Number(inventoryAcquired.units), costMinor: acquiredCostMinor,
      receivedCostMinor, openingCostMinor,
      supplierPaidMinor: Number(supplierPaid.amount_minor),
      otherInventoryReductionMinor,
    }, owner, period, asOf: throughDate, from: periodStart, to: periodEnd,
  });
}));

router.get('/accounting/migration', permit(permissions.MANAGE_ACCOUNTING, 'review opening balances'), asyncRoute(async (req, res) => {
  const automatic = automaticAccounting.ensure(req.db, req.ctx.workspaceId, { actorId: req.ctx.actorId });
  const latest = req.db.prepare(`SELECT id FROM accounting_opening_balance_sets
    WHERE workspace_id = ? AND status = 'DRAFT' ORDER BY created_at DESC LIMIT 1`).get(req.ctx.workspaceId);
  return res.page('accounting/setup', {
    title: 'Earlier balances', nav: 'accounting', configured: automatic.configured,
    positions: setupPositions(req.db, req.ctx.workspaceId), latestOpeningId: latest?.id || null,
    today: today(), automatic, focusInventoryCost: req.query.focus === 'inventory-cost',
  });
}));

router.post('/accounting/setup/start', permit(permissions.MANAGE_ACCOUNTING, 'set up accounting'), asyncRoute(async (req, res) => {
  const automatic = automaticAccounting.ensure(req.db, req.ctx.workspaceId, {
    actorId: req.ctx.actorId, startDate: req.body.startDate || today(), currency: req.body.currency || 'USD',
  });
  req.flash('success', automatic.seeded.length
    ? `Foundry carried forward verified purchase cost for ${automatic.seeded.length} inventory position${automatic.seeded.length === 1 ? '' : 's'}.`
    : 'Accounting is already working automatically. No activation is required.');
  return res.redirect(303, '/accounting');
}));

function accountingReview(db, workspaceId, reviewId) {
  const review = db.prepare(`SELECT aei.*, de.source_record_type, de.source_record_id,
      de.payload AS domain_payload, de.created_at AS event_created_at
    FROM accounting_event_inbox aei JOIN domain_events de ON de.id = aei.domain_event_id
    WHERE aei.id = ? AND aei.workspace_id = ?`).get(reviewId, workspaceId);
  if (!review) return null;
  let outcome = {}; let domainPayload = {};
  try { outcome = JSON.parse(review.outcome || '{}'); } catch { outcome = {}; }
  try { domainPayload = JSON.parse(review.domain_payload || '{}'); } catch { domainPayload = {}; }
  const result = { ...review, outcome, domainPayload, order: null, saleEvent: null,
    inference: null, fulfilled: [], revenueMinor: 0, cogsMinor: null, grossProfitMinor: null };
  if (review.source_record_type !== 'sales_order_event') return result;
  const saleEvent = db.prepare(`SELECT * FROM sales_order_events
    WHERE id = ? AND workspace_id = ?`).get(review.source_record_id, workspaceId);
  if (!saleEvent) return result;
  let detail = {};
  try { detail = JSON.parse(saleEvent.detail || '{}'); } catch { detail = {}; }
  const order = sales.getOrder(db, workspaceId, saleEvent.sales_order_id);
  const byLine = new Map(order.lines.map((line) => [line.id, line]));
  const fulfilled = (Array.isArray(detail.fulfilled) ? detail.fulfilled : []).map((entry) => ({
    ...entry, quantity: Number(entry.quantity), line: byLine.get(entry.lineId),
  })).filter((entry) => entry.line && entry.locationId);
  const configured = ledger.settings(db, workspaceId);
  const movementIds = [...new Set(fulfilled.flatMap((entry) => Array.isArray(entry.movementIds)
    ? entry.movementIds : []))];
  const boundary = movementIds.length ? db.prepare(`SELECT occurred_at FROM movements
    WHERE workspace_id = ? AND id IN (${movementIds.map(() => '?').join(',')})
    ORDER BY occurred_at, seq LIMIT 1`).get(workspaceId, ...movementIds)?.occurred_at : null;
  const inference = openingCostEvidence.infer(db, workspaceId, configured.startDate,
    fulfilled.map((entry) => ({ skuId: entry.line.sku_id, locationId: entry.locationId })),
    boundary ? { boundary } : {});
  const inferredByPosition = new Map(inference.known.map((row) => [`${row.sku_id}:${row.location_id}`, row]));
  const revenueMinor = fulfilled.reduce((sum, entry) => sum
    + Number(entry.line.unit_price_minor || 0) * entry.quantity, 0);
  const exact = inference.unknown.length === 0 && fulfilled.length > 0;
  const cogsMinor = exact ? fulfilled.reduce((sum, entry) => sum
    + inferredByPosition.get(`${entry.line.sku_id}:${entry.locationId}`).averageUnitCostMinor * entry.quantity, 0) : null;
  return { ...result, saleEvent: { ...saleEvent, detail }, order, fulfilled, inference,
    revenueMinor, cogsMinor, grossProfitMinor: cogsMinor === null ? null : revenueMinor - cogsMinor,
    canUseVerifiedCosts: exact };
}

router.get('/accounting/review/:id', permit(permissions.VIEW_ACCOUNTING, 'review accounting exceptions'), asyncRoute(async (req, res) => {
  const review = accountingReview(req.db, req.ctx.workspaceId, req.params.id);
  if (!review) throw new (require('../../domain/errors').NotFoundError)('That accounting review could not be found.');
  res.page('accounting/review', { title: review.order ? `Finish ${review.order.order_number} accounting` : 'Accounting review',
    nav: 'accounting', review, configured: ledger.settings(req.db, req.ctx.workspaceId) });
}));

router.post('/accounting/review/:id/use-verified-costs', permit(permissions.MANAGE_ACCOUNTING, 'resolve accounting exceptions'), asyncRoute(async (req, res) => {
  const review = accountingReview(req.db, req.ctx.workspaceId, req.params.id);
  if (!review) throw new (require('../../domain/errors').NotFoundError)('That accounting review could not be found.');
  if (!review.order || !review.canUseVerifiedCosts) {
    throw new ValidationError('Foundry cannot prove every affected product cost from prior purchase receipts. No amount was guessed.');
  }
  openingCostEvidence.apply(req.db, req.ctx, review.inference);
  const processed = operationalAccounting.retry(req.db, req.ctx.workspaceId, review.domain_event_id);
  if (processed.status !== 'POSTED') {
    req.flash('warn', processed.outcome?.message || processed.error_message || 'The order still needs a specific accounting decision.');
    return res.redirect(303, `/accounting/review/${review.id}`);
  }
  req.flash('success', `${review.order.order_number} is now posted automatically: revenue ${pricing.formatMinor(review.revenueMinor, review.order.currency)}, product cost ${pricing.formatMinor(review.cogsMinor, review.order.currency)}, gross profit ${pricing.formatMinor(review.grossProfitMinor, review.order.currency)}. Inventory was not moved again.`);
  return res.redirect(303, `/sales/orders/${review.order.id}`);
}));

router.post('/accounting/setup/review', permit(permissions.MANAGE_ACCOUNTING, 'set up accounting'), asyncRoute(async (req, res) => {
  const skuIds = Array.isArray(req.body.skuId) ? req.body.skuId : req.body.skuId ? [req.body.skuId] : [];
  const locationIds = Array.isArray(req.body.locationId) ? req.body.locationId : req.body.locationId ? [req.body.locationId] : [];
  const costs = Array.isArray(req.body.inventoryCost) ? req.body.inventoryCost : req.body.inventoryCost !== undefined ? [req.body.inventoryCost] : [];
  const positions = setupPositions(req.db, req.ctx.workspaceId);
  const known = new Map(positions.map((row) => [`${row.sku_id}:${row.location_id}`, row]));
  const inventory = skuIds.map((skuId, index) => {
    const locationId = locationIds[index]; const row = known.get(`${skuId}:${locationId}`);
    if (!row) return null;
    const entered = trimOrNull(costs[index]);
    if (!entered) throw new (require('../../domain/errors').ValidationError)(`Enter the total cost value for ${row.item_name}${row.variant_label ? ` / ${row.variant_label}` : ''} at ${row.location_name}.`);
    return { skuId, locationId, quantityUnits: Number(row.on_hand), totalCostMinor: pricing.toMinor(entered, 'Inventory value') };
  }).filter(Boolean);
  const cash = pricing.toMinor(trimOrNull(req.body.cash) || '0', 'Cash opening balance') || 0;
  const ar = pricing.toMinor(trimOrNull(req.body.receivables) || '0', 'Receivables opening balance') || 0;
  const ap = pricing.toMinor(trimOrNull(req.body.payables) || '0', 'Payables opening balance') || 0;
  const inventoryTotal = inventory.reduce((sum, row) => sum + row.totalCostMinor, 0);
  const lines = [];
  if (cash) lines.push({ accountKey: 'CASH', debitMinor: cash, memo: 'Opening cash' });
  if (ar) lines.push({ accountKey: 'ACCOUNTS_RECEIVABLE', debitMinor: ar, memo: 'Opening customer balances' });
  if (inventoryTotal) lines.push({ accountKey: 'INVENTORY_ASSET', debitMinor: inventoryTotal, memo: 'Opening inventory at cost' });
  if (ap) lines.push({ accountKey: 'ACCOUNTS_PAYABLE', creditMinor: ap, memo: 'Opening supplier balances' });
  const netAssets = cash + ar + inventoryTotal - ap;
  if (netAssets > 0) lines.push({ accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: netAssets, memo: 'Opening balance offset' });
  else if (netAssets < 0) lines.push({ accountKey: 'OPENING_BALANCE_EQUITY', debitMinor: Math.abs(netAssets), memo: 'Opening balance offset' });
  if (!lines.length) {
    ledger.configure(req.db, req.ctx, req.user, {
      startDate: req.body.startDate, currency: req.body.currency || 'USD',
      costingMethod: req.body.costingMethod || 'WEIGHTED_AVERAGE',
    });
    req.flash('success', 'Accounting is ready from the date you chose. No earlier activity was replayed.');
    return res.redirect(303, '/accounting');
  }
  const opening = openingBalances.prepare(req.db, req.ctx, req.user, {
    startDate: req.body.startDate, currency: req.body.currency || 'USD',
    costingMethod: req.body.costingMethod || 'WEIGHTED_AVERAGE', lines, inventory,
    sourceDescription: trimOrNull(req.body.sourceDescription),
  });
  return res.redirect(303, `/accounting/opening/${opening.id}`);
}));

router.get('/accounting/opening/:id', permit(permissions.MANAGE_ACCOUNTING, 'review opening balances'), asyncRoute(async (req, res) => {
  const opening = openingBalances.hydrate(req.db, req.ctx.workspaceId, req.params.id);
  if (!opening) throw new (require('../../domain/errors').NotFoundError)('That opening-balance review could not be found.');
  res.page('accounting/opening-review', { title: 'Review opening balances', nav: 'accounting', opening });
}));

router.post('/accounting/opening/:id/approve', permit(permissions.MANAGE_ACCOUNTING, 'approve opening balances'), asyncRoute(async (req, res) => {
  openingBalances.approve(req.db, req.ctx, req.user, req.params.id, req.body.integrityHash);
  req.flash('success', 'Opening balances are posted. Earlier operations were not replayed.');
  res.redirect(303, '/accounting');
}));

router.get('/accounting/reports/:kind', permit(permissions.VIEW_ACCOUNTING, 'view financial reports'), asyncRoute(async (req, res) => {
  const kind = req.params.kind;
  const from = trimOrNull(req.query.from) || monthStart(); const to = trimOrNull(req.query.to) || today();
  let report; let title;
  if (kind === 'profit-and-loss') { report = reports.profitAndLoss(req.db, req.ctx.workspaceId, { from, to }); title = 'Profit and loss'; }
  else if (kind === 'balance-sheet') { report = reports.balanceSheet(req.db, req.ctx.workspaceId, { asOf: trimOrNull(req.query.asOf) || today() }); title = 'Balance sheet'; }
  else if (kind === 'trial-balance') { report = reports.trialBalance(req.db, req.ctx.workspaceId, { from, to }); title = 'Trial balance'; }
  else if (kind === 'cash-flow') { report = reports.cashFlow(req.db, req.ctx.workspaceId, { from, to }); title = 'Cash flow'; }
  else if (kind === 'general-ledger') { report = reports.generalLedger(req.db, req.ctx.workspaceId, { from, to, accountId: trimOrNull(req.query.accountId) }); title = 'General ledger'; }
  else if (kind === 'inventory-valuation') { report = reports.inventoryReconciliation(req.db, req.ctx.workspaceId, { asOf: trimOrNull(req.query.asOf) || today() }); title = 'Inventory valuation'; }
  else throw new (require('../../domain/errors').NotFoundError)('That accounting report does not exist.');
  res.page('accounting/report', { title, nav: 'accounting', kind, report, from, to,
    configured: ledger.settings(req.db, req.ctx.workspaceId) });
}));

router.get('/accounting/entries/:id', permit(permissions.VIEW_ACCOUNTING, 'view journal entries'), asyncRoute(async (req, res) => {
  const entry = ledger.getEntry(req.db, req.ctx.workspaceId, req.params.id);
  if (!entry) throw new (require('../../domain/errors').NotFoundError)('That journal entry could not be found.');
  res.page('accounting/entry', { title: `Entry ${entry.entry_number}`, nav: 'accounting', entry });
}));

router.post('/accounting/entries/:id/reverse', permit(permissions.MANAGE_ACCOUNTING, 'reverse journal entries'), asyncRoute(async (req, res) => {
  const reversed = ledger.reverse(req.db, req.ctx, req.user, req.params.id, {
    postingDate: req.body.postingDate, reason: trimOrNull(req.body.reason),
  });
  req.flash('success', `Correction posted as entry #${reversed.entry.entry_number}. The original remains unchanged.`);
  res.redirect(303, `/accounting/entries/${reversed.entry.id}`);
}));

router.get('/accounting/transactions', permit(permissions.VIEW_ACCOUNTING, 'view accounting transactions'), asyncRoute(async (req, res) => {
  const from = trimOrNull(req.query.from) || monthStart(); const to = trimOrNull(req.query.to) || today();
  res.page('accounting/transactions', { title: 'Accounting transactions', nav: 'accounting', from, to,
    rows: reports.generalLedger(req.db, req.ctx.workspaceId, { from, to }).rows,
    entries: req.db.prepare(`SELECT * FROM accounting_journal_entries WHERE workspace_id = ?
      AND status = 'POSTED' AND posting_date BETWEEN ? AND ? ORDER BY posting_date DESC, entry_number DESC`)
      .all(req.ctx.workspaceId, from, to) });
}));

router.get('/accounting/adjustments/new', permit(permissions.MANAGE_ACCOUNTING, 'create accounting adjustments'), asyncRoute(async (req, res) => {
  res.page('accounting/adjustment-new', { title: 'New accounting adjustment', nav: 'accounting', today: today(),
    accounts: ledger.listAccounts(req.db, req.ctx.workspaceId, { activeOnly: true }) });
}));

router.post('/accounting/adjustments', permit(permissions.MANAGE_ACCOUNTING, 'create accounting adjustments'), asyncRoute(async (req, res) => {
  if (req.body.debitAccountId === req.body.creditAccountId) {
    throw new ValidationError('Choose two different accounts for an adjustment.');
  }
  const amountMinor = pricing.toMinor(req.body.amount, 'Adjustment amount');
  const posted = ledger.post(req.db, req.ctx, { postingDate: req.body.postingDate,
    description: req.body.description, sourceType: 'manual_adjustment',
    sourceRecordType: 'manual_adjustment', sourceKey: `manual-adjustment:${newId('form')}`,
    createdByType: 'USER', approvedByUserId: req.ctx.actorId,
    metadata: { reason: trimOrNull(req.body.reason) },
    lines: [{ accountId: req.body.debitAccountId, debitMinor: amountMinor,
      memo: trimOrNull(req.body.reason) },
    { accountId: req.body.creditAccountId, creditMinor: amountMinor,
      memo: trimOrNull(req.body.reason) }],
  });
  req.flash('success', `Adjustment #${posted.entry.entry_number} posted. It remains reversible and auditable.`);
  res.redirect(303, `/accounting/entries/${posted.entry.id}`);
}));

router.get('/accounting/chart', permit(permissions.VIEW_ACCOUNTING, 'view the chart of accounts'), asyncRoute(async (req, res) => {
  res.page('accounting/chart', { title: 'Chart of accounts', nav: 'accounting',
    accounts: ledger.listAccounts(req.db, req.ctx.workspaceId) });
}));

router.post('/accounting/chart', permit(permissions.MANAGE_ACCOUNTING, 'add accounting accounts'), asyncRoute(async (req, res) => {
  ledger.createAccount(req.db, req.ctx, req.user, { code: req.body.code, name: req.body.name,
    type: req.body.type, subtype: trimOrNull(req.body.subtype), normalBalance: req.body.normalBalance });
  req.flash('success', 'Account added to this inventory’s chart.');
  res.redirect(303, '/accounting/chart');
}));

router.get('/accounting/periods', permit(permissions.VIEW_ACCOUNTING, 'view accounting periods'), asyncRoute(async (req, res) => {
  res.page('accounting/periods', { title: 'Accounting periods', nav: 'accounting',
    periods: ledger.listPeriods(req.db, req.ctx.workspaceId), today: today() });
}));

router.post('/accounting/periods/:id/close', permit(permissions.CLOSE_ACCOUNTING_PERIOD, 'close accounting periods'), asyncRoute(async (req, res) => {
  ledger.closePeriod(req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.note));
  req.flash('success', 'Period closed. Later corrections must post in an open period and preserve history.');
  res.redirect(303, '/accounting/periods');
}));

router.get('/accounting/receivables', permit(permissions.VIEW_ACCOUNTING, 'view receivables'), asyncRoute(async (req, res) => {
  res.page('accounting/subledger', { title: 'Money customers owe', nav: 'accounting', kind: 'receivables',
    rows: receivables.list(req.db, req.ctx.workspaceId), aging: reports.arAging(req.db, req.ctx.workspaceId),
    counterparties: req.db.prepare('SELECT id, name FROM customers WHERE workspace_id = ? ORDER BY name').all(req.ctx.workspaceId) });
}));

router.get('/accounting/payables', permit(permissions.VIEW_ACCOUNTING, 'view payables'), asyncRoute(async (req, res) => {
  res.page('accounting/subledger', { title: 'Bills to pay', nav: 'accounting', kind: 'payables',
    rows: payables.list(req.db, req.ctx.workspaceId), aging: reports.apAging(req.db, req.ctx.workspaceId),
    counterparties: req.db.prepare("SELECT id, name FROM suppliers WHERE workspace_id = ? AND status = 'active' ORDER BY name").all(req.ctx.workspaceId) });
}));

router.get('/accounting/receivables/new', permit(permissions.MANAGE_ACCOUNTING, 'create customer invoices'), asyncRoute(async (req, res) => {
  res.page('accounting/document-new', { title: 'New customer invoice', nav: 'accounting', kind: 'invoice', today: today(),
    prefill: null, expenseMode: false,
    counterparties: req.db.prepare('SELECT id, name FROM customers WHERE workspace_id = ? ORDER BY name').all(req.ctx.workspaceId),
    accounts: [], taxRates: tax.list(req.db, req.ctx.workspaceId, { activeOnly: true, appliesTo: 'SALES' }) });
}));

router.post('/accounting/receivables', permit(permissions.MANAGE_ACCOUNTING, 'create customer invoices'), asyncRoute(async (req, res) => {
  const unitPriceMinor = pricing.toMinor(req.body.unitAmount, 'Unit price');
  const quantity = Number(req.body.quantity);
  const draft = receivables.createDraft(req.db, req.ctx, req.user, {
    customerId: req.body.counterpartyId, invoiceNumber: trimOrNull(req.body.documentNumber),
    issueDate: req.body.issueDate, dueDate: trimOrNull(req.body.dueDate),
    taxMinor: documentTaxMinor(req, Math.round(quantity * unitPriceMinor), 'SALES'),
    sourceKey: `manual-invoice:${newId('form')}`, notes: trimOrNull(req.body.notes),
    lines: [{ description: req.body.description, quantity, unitPriceMinor }],
  });
  const invoice = receivables.open(req.db, req.ctx, req.user, draft.invoice.id);
  req.flash('success', `${invoice.invoice_number} posted. Revenue and receivable are recorded separately from payment.`);
  res.redirect(303, '/accounting/receivables');
}));

router.get('/accounting/payables/new', permit(permissions.MANAGE_ACCOUNTING, 'create supplier bills'), asyncRoute(async (req, res) => {
  const purchaseOrderId = trimOrNull(req.query.purchaseOrderId);
  const order = purchaseOrderId ? purchaseOrders.get(req.db, req.ctx.workspaceId, purchaseOrderId) : null;
  const prefill = order ? {
    purchaseOrderId: order.id, supplierId: order.supplierId, poNumber: order.poNumber,
    lines: order.lines.map((line) => ({ description: line.displayName,
      quantity: line.quantityUnits, unitAmount: Number(line.unitCost || 0).toFixed(2),
      skuId: line.skuId, purchaseOrderLineId: line.id })),
  } : null;
  const expenseMode = req.query.kind === 'expense';
  res.page('accounting/document-new', { title: expenseMode ? 'Record a business expense' : 'New supplier bill', nav: 'accounting', kind: 'bill', today: today(), prefill, expenseMode,
    counterparties: req.db.prepare("SELECT id, name FROM suppliers WHERE workspace_id = ? AND status = 'active' ORDER BY name").all(req.ctx.workspaceId),
    accounts: ledger.listAccounts(req.db, req.ctx.workspaceId, { activeOnly: true })
      .filter((account) => (expenseMode ? account.account_type === 'EXPENSE'
        : ['EXPENSE', 'ASSET', 'COGS'].includes(account.account_type)) && !account.is_control),
    taxRates: tax.list(req.db, req.ctx.workspaceId, { activeOnly: true, appliesTo: 'PURCHASES' }) });
}));

router.post('/accounting/payables', permit(permissions.MANAGE_ACCOUNTING, 'create supplier bills'), asyncRoute(async (req, res) => {
  const descriptions = formArray(req.body.description);
  const quantities = formArray(req.body.quantity);
  const amounts = formArray(req.body.unitAmount);
  const accountIds = formArray(req.body.accountId);
  const skuIds = formArray(req.body.skuId);
  const poLineIds = formArray(req.body.purchaseOrderLineId);
  const lines = descriptions.map((description, index) => ({ description,
    quantity: Number(quantities[index]), unitCostMinor: pricing.toMinor(amounts[index], `Line ${index + 1} unit cost`),
    debitAccountId: accountIds[index] || accountIds[0] || null,
    skuId: skuIds[index] || null, purchaseOrderLineId: poLineIds[index] || null,
    itemId: skuIds[index] ? req.db.prepare('SELECT item_id FROM skus WHERE id = ? AND workspace_id = ?')
      .get(skuIds[index], req.ctx.workspaceId)?.item_id || null : null,
  }));
  const subtotalMinor = lines.reduce((sum, line) => sum + Math.round(line.quantity * line.unitCostMinor), 0);
  const draft = payables.createDraft(req.db, req.ctx, req.user, {
    supplierId: req.body.counterpartyId, supplierInvoiceNumber: trimOrNull(req.body.documentNumber),
    purchaseOrderId: trimOrNull(req.body.purchaseOrderId),
    issueDate: req.body.issueDate, dueDate: trimOrNull(req.body.dueDate),
    taxMinor: documentTaxMinor(req, subtotalMinor, 'PURCHASES'),
    sourceKey: `manual-bill:${newId('form')}`, notes: trimOrNull(req.body.notes),
    lines,
  });
  const bill = payables.open(req.db, req.ctx, req.user, draft.bill.id);
  const paymentStatus = String(req.body.paymentStatus || 'unpaid');
  if (bill.status === 'OPEN' && ['paid', 'partially_paid'].includes(paymentStatus)) {
    const amountMinor = paymentStatus === 'paid' ? Number(bill.balance_minor)
      : pricing.toMinor(req.body.paymentAmount, 'Amount paid');
    payments.record(req.db, req.ctx, req.user, { direction: 'SUPPLIER_PAYMENT',
      supplierId: bill.supplier_id, paymentDate: req.body.paymentDate || req.body.issueDate,
      amountMinor, method: trimOrNull(req.body.paymentMethod),
      reference: trimOrNull(req.body.paymentReference),
      sourceKey: `bill-form-payment:${newId('form')}`,
      allocations: [{ billId: bill.id, amountMinor }] });
  }
  req.flash('success', `${bill.supplier_invoice_number || bill.bill_number} posted as a bill. No inventory quantity was changed.`);
  res.redirect(303, req.body.returnSection === 'expenses' ? '/accounting#expenses' : '/accounting/payables');
}));

router.get('/accounting/tax', permit(permissions.VIEW_ACCOUNTING, 'view tax accounting'), asyncRoute(async (req, res) => {
  const todayDate = today();
  const trial = reports.trialBalance(req.db, req.ctx.workspaceId, { from: '1900-01-01', to: todayDate });
  res.page('accounting/tax', { title: 'Sales tax', nav: 'accounting', today: todayDate,
    rates: tax.list(req.db, req.ctx.workspaceId),
    payableMinor: Number(trial.accounts.find((row) => row.system_key === 'SALES_TAX_PAYABLE')?.net_minor || 0),
    recoverableMinor: Number(trial.accounts.find((row) => row.system_key === 'SALES_TAX_RECOVERABLE')?.net_minor || 0),
    currency: ledger.settings(req.db, req.ctx.workspaceId).currency });
}));

router.post('/accounting/tax/rates', permit(permissions.MANAGE_ACCOUNTING, 'configure tax rates'), asyncRoute(async (req, res) => {
  tax.create(req.db, req.ctx, req.user, req.body);
  req.flash('success', 'Tax rate saved. It calculates tax only when you select it; Foundry does not claim to file taxes.');
  res.redirect(303, '/accounting/tax');
}));

router.get('/accounting/banking', permit(permissions.VIEW_ACCOUNTING, 'view banking and reconciliation'), asyncRoute(async (req, res) => {
  const banks = req.db.prepare(`SELECT b.*, a.name AS ledger_account_name, a.code AS ledger_account_code
    FROM accounting_bank_accounts b JOIN accounting_accounts a ON a.id = b.ledger_account_id
    WHERE b.workspace_id = ? AND b.active = 1 ORDER BY b.name`).all(req.ctx.workspaceId);
  const transactions = req.db.prepare(`SELECT t.*, b.name AS bank_name FROM accounting_bank_transactions t
    JOIN accounting_bank_accounts b ON b.id = t.bank_account_id WHERE t.workspace_id = ?
    ORDER BY t.transaction_date DESC, t.rowid DESC LIMIT 100`).all(req.ctx.workspaceId);
  const reconciliations = req.db.prepare(`SELECT r.*, b.name AS bank_name FROM accounting_reconciliations r
    JOIN accounting_bank_accounts b ON b.id = r.bank_account_id WHERE r.workspace_id = ?
    ORDER BY r.statement_end_date DESC`).all(req.ctx.workspaceId);
  const paymentMatches = req.db.prepare(`SELECT p.id, p.payment_date, p.amount_minor, p.direction,
      p.reference, COALESCE(c.name, s.name, 'Unapplied payment') AS counterparty
    FROM accounting_payments p
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.workspace_id = ? AND p.status = 'POSTED'
    ORDER BY p.payment_date DESC, p.rowid DESC LIMIT 100`).all(req.ctx.workspaceId);
  const journalMatches = req.db.prepare(`SELECT e.id, e.entry_number, e.posting_date, e.description
    FROM accounting_journal_entries e WHERE e.workspace_id = ? AND e.status = 'POSTED'
    ORDER BY e.posting_date DESC, e.entry_number DESC LIMIT 100`).all(req.ctx.workspaceId);
  res.page('accounting/banking', { title: 'Banking and reconciliation', nav: 'accounting', banks,
    transactions, reconciliations, paymentMatches, journalMatches, today: today(), accounts: ledger.listAccounts(req.db, req.ctx.workspaceId, { activeOnly: true })
      .filter((account) => ['ASSET', 'LIABILITY'].includes(account.account_type)) });
}));

router.post('/accounting/banking/accounts', permit(permissions.MANAGE_ACCOUNTING, 'add financial accounts'), asyncRoute(async (req, res) => {
  banking.createAccount(req.db, req.ctx, req.user, { name: req.body.name, kind: req.body.kind,
    ledgerAccountId: req.body.ledgerAccountId, institutionName: trimOrNull(req.body.institutionName),
    maskedIdentifier: trimOrNull(req.body.maskedIdentifier) });
  req.flash('success', 'Financial account added. Connecting or importing activity does not post entries until it is matched.');
  res.redirect(303, '/accounting/banking');
}));

router.post('/accounting/banking/:id/import', permit(permissions.RECONCILE_ACCOUNTS, 'import bank transactions'), asyncRoute(async (req, res) => {
  banking.importTransactions(req.db, req.ctx, req.user, req.params.id, [{
    externalId: trimOrNull(req.body.externalId), transactionDate: req.body.transactionDate,
    amountMinor: signedMinor(req.body.amount, 'Transaction amount'), description: req.body.description,
    counterparty: trimOrNull(req.body.counterparty), reference: trimOrNull(req.body.reference),
  }], { source: 'manual_bank_import' });
  req.flash('success', 'Bank activity imported as unmatched evidence. It did not become income or expense.');
  res.redirect(303, '/accounting/banking');
}));

router.post('/accounting/banking/:id/reconcile', permit(permissions.RECONCILE_ACCOUNTS, 'reconcile financial accounts'), asyncRoute(async (req, res) => {
  const result = banking.reconcile(req.db, req.ctx, req.user, req.params.id, {
    statementEndDate: req.body.statementEndDate,
    statementEndingBalanceMinor: signedMinor(req.body.statementEndingBalance, 'Statement ending balance'),
    complete: req.body.complete === 'yes',
  });
  req.flash('success', result.status === 'COMPLETED' ? 'Reconciliation completed exactly.'
    : `Reconciliation saved. Difference: ${result.difference_minor} minor units.`);
  res.redirect(303, '/accounting/banking');
}));

router.post('/accounting/banking/transactions/:id/match', permit(permissions.RECONCILE_ACCOUNTS, 'match bank transactions'), asyncRoute(async (req, res) => {
  const [matchType, targetId] = String(req.body.matchTarget || '').split(':', 2);
  if (!targetId) throw new ValidationError('Choose the payment or accounting entry this statement line represents.');
  if (matchType === 'payment') banking.matchPayment(req.db, req.ctx, req.user, req.params.id, targetId);
  else if (matchType === 'journal') banking.matchJournal(req.db, req.ctx, req.user, req.params.id, targetId);
  else throw new ValidationError('Choose payment or journal-entry matching.');
  req.flash('success', 'Statement activity matched. No new revenue, expense, or inventory entry was created.');
  res.redirect(303, '/accounting/banking');
}));

router.post('/accounting/receivables/:id/payment', permit(permissions.RECORD_PAYMENTS, 'record customer payments'), asyncRoute(async (req, res) => {
  const invoice = receivables.requireInvoice(req.db, req.ctx.workspaceId, req.params.id);
  payments.record(req.db, req.ctx, req.user, { direction: 'CUSTOMER_RECEIPT', customerId: invoice.customer_id,
    paymentDate: req.body.paymentDate, amountMinor: pricing.toMinor(req.body.amount, 'Payment amount'),
    method: trimOrNull(req.body.method), reference: trimOrNull(req.body.reference),
    sourceKey: `manual-customer-payment:${req.body.idempotencyKey}`,
    allocations: [{ invoiceId: invoice.id, amountMinor: pricing.toMinor(req.body.amount, 'Payment amount') }] });
  req.flash('success', `Payment recorded against ${invoice.invoice_number}.`);
  const returnTo = String(req.body.returnTo || '');
  res.redirect(303, /^\/accounting(?:[/?#]|$)/.test(returnTo) ? returnTo : '/accounting/receivables');
}));

router.post('/accounting/receivables/:id/confirm-unpaid', permit(permissions.RECORD_PAYMENTS, 'confirm an unpaid customer balance'), asyncRoute(async (req, res) => {
  const invoice = receivables.requireInvoice(req.db, req.ctx.workspaceId, req.params.id);
  if (!['OPEN', 'PARTIALLY_PAID'].includes(invoice.status) || Number(invoice.balance_minor) <= 0) {
    throw new ValidationError('This customer balance is no longer unpaid.');
  }
  req.db.prepare(`UPDATE accounting_customer_invoices SET payment_status_confirmed_at = ?,
    updated_at = ? WHERE id = ? AND workspace_id = ?`).run(nowIso(), nowIso(), invoice.id, req.ctx.workspaceId);
  req.flash('success', `${invoice.invoice_number} remains unpaid. Foundry will keep the balance open without asking you to confirm it again.`);
  res.redirect(303, '/accounting#customers');
}));

router.get('/accounting/refunds/new', permit(permissions.MANAGE_ACCOUNTING, 'record customer refunds'), asyncRoute(async (req, res) => {
  const invoice = receivables.requireInvoice(req.db, req.ctx.workspaceId, req.query.invoiceId);
  const entry = invoice.sales_order_id ? req.db.prepare(`SELECT id FROM accounting_journal_entries
    WHERE workspace_id = ? AND status = 'POSTED' AND source_type = 'sales_fulfillment'
      AND json_extract(metadata, '$.salesOrderId') = ? ORDER BY posting_date, entry_number LIMIT 1`)
    .get(req.ctx.workspaceId, invoice.sales_order_id) : null;
  if (!entry) throw new ValidationError('This invoice has no completed Sales Order evidence to refund.');
  res.page('accounting/refund-new', { title: `Refund ${invoice.order_number || invoice.invoice_number}`,
    nav: 'accounting', invoice, originalJournalEntryId: entry.id, today: today() });
}));

router.post('/accounting/refunds', permit(permissions.MANAGE_ACCOUNTING, 'record customer refunds'), asyncRoute(async (req, res) => {
  const invoice = receivables.requireInvoice(req.db, req.ctx.workspaceId, req.body.invoiceId);
  const amountMinor = pricing.toMinor(req.body.amount, 'Refund amount');
  const destination = req.body.refundFrom === 'cash' ? 'CASH' : 'AR';
  if (destination === 'AR' && amountMinor > Number(invoice.balance_minor)) {
    throw new ValidationError(`Only ${pricing.formatMinor(Number(invoice.balance_minor), invoice.currency)} remains unpaid. Choose cash for money already returned to the customer.`);
  }
  refunds.refundSale(req.db, req.ctx, req.user, {
    originalJournalEntryId: req.body.originalJournalEntryId, refundDate: req.body.refundDate,
    revenueMinor: amountMinor, taxMinor: 0, cogsMinor: 0, physicalReturn: false,
    destination, reference: trimOrNull(req.body.reference), sourceKey: newId('manual-refund'),
  });
  req.flash('success', `Refund recorded for ${invoice.order_number || invoice.invoice_number}. Inventory was not changed.`);
  res.redirect(303, `/accounting#customer-${invoice.id}`);
}));

router.get('/accounting/supplier-credits/new', permit(permissions.MANAGE_ACCOUNTING, 'record supplier credits'), asyncRoute(async (req, res) => {
  const bill = payables.requireBill(req.db, req.ctx.workspaceId, req.query.billId);
  res.page('accounting/supplier-credit-new', { title: `Credit from ${bill.supplier_name}`,
    nav: 'accounting', bill, today: today() });
}));

router.post('/accounting/supplier-credits', permit(permissions.MANAGE_ACCOUNTING, 'record supplier credits'), asyncRoute(async (req, res) => {
  const bill = payables.requireBill(req.db, req.ctx.workspaceId, req.body.billId);
  supplierCredits.record(req.db, req.ctx, req.user, { billId: bill.id,
    amountMinor: pricing.toMinor(req.body.amount, 'Supplier credit amount'),
    creditNumber: trimOrNull(req.body.creditNumber), creditDate: req.body.creditDate,
    reason: trimOrNull(req.body.reason), sourceKey: newId('manual-supplier-credit') });
  req.flash('success', `Supplier credit recorded against ${bill.supplier_invoice_number || bill.bill_number}. The original bill remains in history.`);
  res.redirect(303, `/accounting#supplier-${bill.id}`);
}));

router.post('/accounting/payables/:id/payment', permit(permissions.RECORD_PAYMENTS, 'record supplier payments'), asyncRoute(async (req, res) => {
  const bill = payables.requireBill(req.db, req.ctx.workspaceId, req.params.id);
  payments.record(req.db, req.ctx, req.user, { direction: 'SUPPLIER_PAYMENT', supplierId: bill.supplier_id,
    paymentDate: req.body.paymentDate, amountMinor: pricing.toMinor(req.body.amount, 'Payment amount'),
    method: trimOrNull(req.body.method), reference: trimOrNull(req.body.reference),
    sourceKey: `manual-supplier-payment:${req.body.idempotencyKey}`,
    allocations: [{ billId: bill.id, amountMinor: pricing.toMinor(req.body.amount, 'Payment amount') }] });
  req.flash('success', `Payment recorded against ${bill.bill_number}.`);
  const returnTo = String(req.body.returnTo || '');
  res.redirect(303, /^\/purchasing\/orders\/[A-Za-z0-9_-]+$/.test(returnTo)
    ? returnTo : '/accounting/payables');
}));

/*
 * A payment the owner reported in a sentence.
 *
 * The proposal is rebuilt from records on every view, including at approval, so
 * a balance that moved between reading and approving cannot be applied from a
 * stale preview. What is carried in the session is only what was said.
 */
router.get('/accounting/payments/reported', requireAuth, asyncRoute(async (req, res) => {
  const reported = req.session.reportedPayment;
  if (!reported) return res.redirect(303, '/accounting');
  const outcome = paymentIntent.propose(req.db, req.ctx.workspaceId, reported.fields);
  return res.page('accounting/reported-payment', {
    title: 'Record this payment',
    nav: 'accounting',
    said: reported.said,
    fields: reported.fields,
    outcome,
  });
}));

router.post('/accounting/payments/reported', requireAuth, asyncRoute(async (req, res) => {
  const reported = req.session.reportedPayment;
  if (!reported) return res.redirect(303, '/accounting');

  // Answering a question Foundry asked continues the same report rather than
  // making somebody retype the sentence.
  const chosen = trimOrNull(req.body.documentId);
  const fields = chosen ? { ...reported.fields, documentId: chosen } : reported.fields;

  // Rebuilt from records at the moment of approval, so a balance that moved
  // since the preview cannot be applied from a stale figure.
  const resolved = paymentIntent.propose(req.db, req.ctx.workspaceId, fields);

  if (!resolved.ok) {
    req.session.reportedPayment = { ...reported, fields };
    return res.redirect(303, '/accounting/payments/reported');
  }

  try {
    paymentIntent.apply(req.db, req.ctx, req.user, resolved.proposal, {
      sourceKey: `reported-payment:${req.ctx.workspaceId}:${reported.said}:${resolved.proposal.paymentDate}`,
    });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
    return res.redirect(303, '/accounting/payments/reported');
  }

  delete req.session.reportedPayment;
  req.flash('success', resolved.proposal.target
    ? `Recorded against ${resolved.proposal.target.number}.`
    : 'Payment recorded.');
  return res.redirect(303, '/accounting');
}));

module.exports = router;
