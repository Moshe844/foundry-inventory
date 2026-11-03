'use strict';

/*
 * View models for the Buy pages.
 *
 * Nothing here is a new business fact. Purchase orders, supplier bills and the
 * reorder list are read from the same tables the engine writes; this only sorts
 * each order into exactly one tab (so the tab counts add up to All), names its
 * status and bill in plain words, and picks the one next step to offer.
 */

const { initials, shortDay } = require('./orders-view');

const PAGE_SIZE = 50;
const TABS = ['all', 'approve', 'way', 'pay', 'done'];
// Older links used ?view=; keep them landing on the matching tab.
const LEGACY_VIEWS = { waiting: 'approve', open: 'way', late: 'way', done: 'done' };
const OPEN = ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'];

const toMinor = (dollars) => Math.round(Number(dollars || 0) * 100);
const isoDay = (value) => (value instanceof Date ? value.toISOString() : String(value || '')).slice(0, 10);

function money(minor, currency = 'USD') {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(minor || 0) / 100); }
  catch { return (Number(minor || 0) / 100).toFixed(2); }
}

function weekday(value) {
  const day = isoDay(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function statusBadge(status) {
  switch (status) {
    case 'DRAFT': return { text: 'Draft', tone: 'amber' };
    case 'AWAITING_APPROVAL': return { text: 'To approve', tone: 'amber' };
    case 'APPROVED': return { text: 'Approved', tone: 'blue' };
    case 'ORDERED': return { text: 'On the way', tone: 'blue' };
    case 'PARTIALLY_RECEIVED': return { text: 'Partly received', tone: 'blue' };
    case 'RECEIVED': return { text: 'Received', tone: 'green' };
    case 'CANCELLED': return { text: 'Cancelled', tone: 'grey' };
    default: return { text: String(status || '').toLowerCase(), tone: 'grey' };
  }
}

// What the supplier's bills say about this order, in one badge.
function billBadge(order, bill) {
  if (!bill || !bill.count) {
    if (['DRAFT', 'AWAITING_APPROVAL', 'CANCELLED'].includes(order.status) || !order.receivedUnits) return null;
    return { text: 'No bill yet', tone: 'grey' };
  }
  if (bill.balanceMinor <= 0) return { text: 'Paid', tone: 'green' };
  if (bill.totalMinor > bill.balanceMinor) return { text: 'Partly paid', tone: 'amber' };
  return { text: `Owes ${money(bill.balanceMinor, order.currency).replace(/\.00$/, '')}`, tone: 'rose' };
}

function tabFor(order, bill) {
  if (['DRAFT', 'AWAITING_APPROVAL'].includes(order.status)) return 'approve';
  if (OPEN.includes(order.status) && order.outstandingUnits > 0) return 'way';
  if (order.status !== 'CANCELLED' && bill && bill.balanceMinor > 0) return 'pay';
  return 'done';
}

function nextAction(order, tab, can) {
  const href = `/purchasing/orders/${order.id}`;
  if (tab === 'approve' && can.approve) return { label: 'Approve', href };
  if (tab === 'way' && can.receive) return { label: order.receivedUnits ? 'Receive rest' : 'Receive', href: `${href}/receive` };
  if (tab === 'pay' && can.payments) return { label: 'Record payment', href: `${href}?pay=1`, ghost: true };
  return null;
}

// One line under the PO number on a phone: who, and the fact that matters now.
function phoneLine(order, tab, bill) {
  if (tab === 'approve') return `${order.supplierName} · draft`;
  if (tab === 'way' && order.receivedUnits) return `${order.supplierName} · ${order.receivedUnits} of ${order.orderedUnits} in`;
  if (tab === 'way' && order.expectedDate) return `${order.supplierName} · arriving ${shortDay(order.expectedDate)}`;
  if (tab === 'pay') return `${order.supplierName} · owes ${money(bill.balanceMinor, order.currency).replace(/\.00$/, '')}`;
  return order.supplierName;
}

async function billsByOrder(database, workspaceId) {
  const rows = (await database.query(`SELECT purchase_order_id,COUNT(*)::int AS n,COALESCE(SUM(total_minor),0)::bigint AS total,
      COALESCE(SUM(balance_minor),0)::bigint AS balance FROM accounting_supplier_bills
    WHERE workspace_id=$1 AND purchase_order_id IS NOT NULL AND status<>'VOID' GROUP BY purchase_order_id`, [workspaceId])).rows;
  return new Map(rows.map((row) => [row.purchase_order_id,
    { count: Number(row.n), totalMinor: Number(row.total), balanceMinor: Number(row.balance) }]));
}

async function matchingOrderIds(database, workspaceId, q) {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = (await database.query(`SELECT DISTINCT po.id FROM purchase_orders po
      JOIN suppliers s ON s.id=po.supplier_id AND s.workspace_id=po.workspace_id
      LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id=po.id AND pol.workspace_id=po.workspace_id
      LEFT JOIN skus k ON k.id=pol.sku_id AND k.workspace_id=po.workspace_id
      LEFT JOIN items i ON i.id=k.item_id AND i.workspace_id=po.workspace_id
    WHERE po.workspace_id=$1 AND (po.po_number ILIKE $2 OR s.name ILIKE $2 OR COALESCE(i.name,'') ILIKE $2
      OR COALESCE(k.code,'') ILIKE $2 OR COALESCE(k.variant_label,'') ILIKE $2)`, [workspaceId, like])).rows;
  return new Set(rows.map((row) => row.id));
}

function decorate(row) {
  const ordered = Number(row.ordered_units || 0);
  const outstanding = Number(row.units_outstanding || 0);
  return {
    id: row.id, number: row.po_number, status: row.status, supplierId: row.supplier_id, supplierName: row.supplier_name,
    initials: initials(row.supplier_name), currency: row.currency || 'USD',
    expectedDate: isoDay(row.expected_date) || null, orderDate: isoDay(row.order_date || row.created_at),
    orderedUnits: ordered, outstandingUnits: outstanding, receivedUnits: Math.max(0, ordered - outstanding),
    totalMinor: toMinor(row.total), createdAt: row.created_at,
  };
}

async function purchaseOrdersList(database, workspaceId, rows, query = {}, can = {}, today = isoDay(new Date())) {
  const requested = String(query.status || LEGACY_VIEWS[query.view] || 'all');
  const tab = TABS.includes(requested) ? requested : 'all';
  const q = String(query.q || '').trim().slice(0, 120);
  let bills = new Map();
  let moneyReady = true;
  try { bills = await billsByOrder(database, workspaceId); } catch { moneyReady = false; }

  const all = rows.map(decorate).map((order) => {
    const bill = bills.get(order.id) || null;
    const tabKey = tabFor(order, bill);
    const done = tabKey === 'done';
    return { ...order, tab: tabKey, bill, badge: statusBadge(order.status), billBadge: moneyReady ? billBadge(order, bill) : null,
      action: nextAction(order, tabKey, can), phone: phoneLine(order, tabKey, bill),
      expected: order.expectedDate ? shortDay(order.expectedDate) : null,
      expectedMuted: done || (order.expectedDate && order.expectedDate < today),
      progress: order.orderedUnits ? Math.round((order.receivedUnits / order.orderedUnits) * 100) : 0,
      cancelled: order.status === 'CANCELLED' };
  });
  const counts = { all: all.length, approve: 0, way: 0, pay: 0, done: 0 };
  all.forEach((order) => { counts[order.tab] += 1; });

  const matches = q ? await matchingOrderIds(database, workspaceId, q) : null;
  const filtered = all.filter((order) => (tab === 'all' || order.tab === tab) && (!matches || matches.has(order.id)));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.page, 10) || 1));
  const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const open = all.filter((order) => OPEN.includes(order.status) && order.outstandingUnits > 0);
  const weekEnd = isoDay(new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000));
  const arriving = open.filter((order) => order.expectedDate && order.expectedDate >= today && order.expectedDate <= weekEnd)
    .sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : 1));
  const month = today.slice(0, 7);
  const bought = all.filter((order) => !['DRAFT', 'AWAITING_APPROVAL', 'CANCELLED'].includes(order.status) && order.orderDate.startsWith(month));
  const owing = all.filter((order) => order.bill && order.bill.balanceMinor > 0);
  const owedSuppliers = [...new Set(owing.map((order) => order.supplierName))];
  const kpis = {
    onOrder: { minor: open.reduce((sum, order) => sum + order.totalMinor, 0), orders: open.length,
      units: open.reduce((sum, order) => sum + order.outstandingUnits, 0) },
    arriving: { count: arriving.length, next: arriving[0] ? `${arriving[0].number} · ${weekday(arriving[0].expectedDate)}` : null },
    owed: moneyReady ? { minor: owing.reduce((sum, order) => sum + order.bill.balanceMinor, 0),
      bills: owing.reduce((sum, order) => sum + order.bill.count, 0), who: owedSuppliers.length === 1 ? owedSuppliers[0] : null } : null,
    month: { minor: bought.reduce((sum, order) => sum + order.totalMinor, 0), orders: bought.length },
  };
  return { tab, q, counts, rows: shown, page, pages, matching: filtered.length, kpis, moneyReady,
    currency: (all[0] && all[0].currency) || 'USD' };
}

/*
 * What the one-page purchase order needs beyond the supplier's linked
 * products: every active supplier for the picker, stock on hand per product,
 * weighed products, and that supplier's items on What to order as suggestions.
 */
async function purchaseEntryExtras(database, workspaceId, supplierId, supplierItems) {
  const supplierRows = (await database.query(`SELECT s.id,s.name,s.contact_name,s.email,s.default_lead_time_days,s.payment_terms,s.currency,
      (SELECT COUNT(*) FROM supplier_items si WHERE si.workspace_id=s.workspace_id AND si.supplier_id=s.id AND si.is_active=1)::int AS item_count
    FROM suppliers s WHERE s.workspace_id=$1 AND s.status='active' ORDER BY lower(s.name),s.id LIMIT 500`, [workspaceId])).rows;
  const suppliers = supplierRows.map((s) => ({ id: s.id, name: s.name, initials: initials(s.name), contactName: s.contact_name, email: s.email,
    defaultLeadTimeDays: s.default_lead_time_days, paymentTerms: s.payment_terms, currency: s.currency || 'USD', itemCount: Number(s.item_count) }));
  if (!supplierId || !supplierItems.length) return { suppliers, items: supplierItems, suggestions: [] };
  const skuIds = supplierItems.map((item) => item.skuId);
  const [stockRows, skuRows, shortages] = await Promise.all([
    database.query(`SELECT sku_id,COALESCE(SUM(on_hand),0)::numeric AS on_hand FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) GROUP BY sku_id`, [workspaceId, skuIds]),
    database.query(`SELECT s.id,s.code,i.secondary_unit_label FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`, [workspaceId, skuIds]),
    require('../purchasing/postgres-shortage-list').read(database, workspaceId, {}).catch(() => ({ rows: [] })),
  ]);
  const stock = new Map(stockRows.rows.map((row) => [row.sku_id, Number(row.on_hand)]));
  const sku = new Map(skuRows.rows.map((row) => [row.id, row]));
  const short = new Map(shortages.rows.filter((row) => Number(row.needed) > 0).map((row) => [row.sku_id, row]));
  const items = supplierItems.map((item) => ({ ...item, code: sku.get(item.skuId)?.code || '', secondaryUnit: sku.get(item.skuId)?.secondary_unit_label || null,
    onHand: stock.get(item.skuId) || 0, low: short.has(item.skuId) || !(stock.get(item.skuId) > 0) }));
  const suggestions = items.filter((item) => short.has(item.skuId)).map((item) => {
    const pack = Number(item.unitsPerPurchaseUnit || 1);
    return { skuId: item.skuId, label: String(item.displayName).replace(/\s*\/\s*/g, ' '), onHand: item.onHand,
      quantity: Math.max(1, Math.ceil(Number(short.get(item.skuId).needed) / pack)) };
  });
  return { suppliers, items, suggestions };
}

// A supplier return in plain words. Shipped goods wait for the supplier's credit.
function returnBadge(status) {
  switch (status) {
    case 'REQUESTED': return { text: 'Requested', tone: 'amber' };
    case 'AUTHORIZED': return { text: 'Approved by supplier', tone: 'blue' };
    case 'AWAITING_CREDIT': return { text: 'Shipped back', tone: 'blue' };
    case 'RECONCILED': return { text: 'Credited', tone: 'green' };
    case 'CREDIT_MISMATCH': return { text: 'Credit differs', tone: 'amber' };
    case 'CANCELLED': return { text: 'Cancelled', tone: 'grey' };
    default: return { text: String(status || '').toLowerCase().replace(/_/g, ' '), tone: 'grey' };
  }
}

const EVENT_WORDS = { created: 'Draft created', approved: 'Approved', ordered: 'Sent to the supplier', placed: 'Sent to the supplier',
  received: 'Delivery received', cancelled: 'Cancelled', draft_reference_revised: 'Reference changed', priced: 'Prices added' };

function dateTime(value) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/*
 * The purchase order page: where it stands (the Draft → Paid strip), the one
 * next step, and the money in four numbers. Everything is read from the page
 * data the route already builds.
 */
async function purchaseOrderView(database, workspaceId, page, can, today = isoDay(new Date())) {
  const { order, receipts, supplierBills, billSummary, supplier } = page;
  const skuIds = order.lines.map((line) => line.sku_id).filter(Boolean);
  const stockRows = skuIds.length ? (await database.query(`SELECT sku_id,COALESCE(SUM(on_hand),0)::numeric AS on_hand FROM balances
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) GROUP BY sku_id`, [workspaceId, skuIds])).rows : [];
  const stock = new Map(stockRows.map((row) => [row.sku_id, Number(row.on_hand)]));
  const events = [...page.events].reverse();
  const at = (type) => { const hit = events.find((event) => event.event === type); return hit ? shortDay(hit.created_at) : null; };
  const status = order.status;
  const draft = ['DRAFT', 'AWAITING_APPROVAL'].includes(status);
  const cancelled = status === 'CANCELLED';
  const billed = billSummary.approvedTotalMinor;
  const openBills = supplierBills.filter((bill) => ['OPEN', 'PARTIALLY_PAID'].includes(bill.status));
  const unbilled = order.lines.some((line) => line.quantityUnbilledUnits > 0);
  const lastReceipt = receipts.length ? shortDay(receipts[receipts.length - 1].receivedAt) : null;
  const orderTotalMinor = Math.round(Number(order.subtotal || 0) * 100);

  const steps = [
    { key: 'draft', label: 'Draft', note: shortDay(order.createdAt) || 'Started', done: true },
    { key: 'approve', label: 'Approve', note: at('approved') || (draft ? 'You' : '—'), done: !draft },
    { key: 'sent', label: 'Sent', note: at('ordered') || at('placed') || 'to supplier', done: ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(status) },
    { key: 'received', label: 'Received', note: `${order.receivedUnits} / ${order.orderedUnits}${lastReceipt && order.receivedUnits ? ' · ' + lastReceipt : ''}`, done: order.orderedUnits > 0 && order.outstandingUnits === 0 },
    { key: 'billed', label: 'Billed', note: billed ? money(billed, order.currency) : '—', done: supplierBills.length > 0 && !unbilled },
    { key: 'paid', label: 'Paid', note: billSummary.paidMinor ? money(billSummary.paidMinor, order.currency) : '—', done: supplierBills.length > 0 && !unbilled && billSummary.owedMinor === 0 },
  ];
  const now = cancelled ? -1 : steps.findIndex((step) => !step.done);
  steps.forEach((step, index) => { step.now = index === now; });

  let next = null;
  if (cancelled) next = null;
  else if (draft && order.hasCosts && can.approve) next = { kind: 'approve', label: 'Approve' };
  else if (status === 'APPROVED' && can.approve) next = { kind: 'place', label: 'Mark as sent' };
  else if (['ORDERED', 'PARTIALLY_RECEIVED'].includes(status) && order.outstandingUnits > 0 && can.receive) next = { kind: 'receive', label: 'Receive delivery', href: `/purchasing/orders/${order.id}/receive` };
  else if (unbilled && order.receivedUnits > 0 && can.accounting) next = { kind: 'bill', label: 'Add supplier bill' };
  else if (openBills.length && can.payments) next = { kind: 'pay', label: 'Record payment' };

  const subtitle = [order.supplierName, `${order.orderedUnits} unit${order.orderedUnits === 1 ? '' : 's'}`,
    order.expectedDate && !['RECEIVED', 'CANCELLED'].includes(status) ? `expected ${weekday(order.expectedDate)}${order.destinationLocationName ? ' → ' + order.destinationLocationName : ''}` : order.destinationLocationName ? `→ ${order.destinationLocationName}` : null]
    .filter(Boolean).join(' · ');

  return {
    badge: statusBadge(status), subtitle, steps, next, draft, cancelled, openBills, unbilled,
    stock: Object.fromEntries(stock),
    moneyRows: { totalMinor: orderTotalMinor, billedMinor: billed, paidMinor: billSummary.paidMinor, owedMinor: billSummary.owedMinor },
    supplier: supplier ? { id: supplier.id, name: supplier.name, initials: initials(supplier.name), contactName: supplier.contact_name, email: supplier.email,
      phone: supplier.phone, leadDays: supplier.default_lead_time_days, terms: supplier.payment_terms } : { name: order.supplierName, initials: initials(order.supplierName) },
    history: events.map((event) => ({ text: EVENT_WORDS[event.event] || String(event.event).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      when: dateTime(event.created_at), done: true })),
    late: Boolean(order.expectedDate && order.expectedDate < today && order.outstandingUnits > 0 && !draft && !cancelled),
  };
}

module.exports = { purchaseOrdersList, purchaseEntryExtras, purchaseOrderView, returnBadge, statusBadge, billBadge, money, weekday, isoDay, initials, shortDay, TABS };
