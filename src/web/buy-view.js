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
  const size = query.pageSize || PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.page, 10) || 1));
  const shown = filtered.slice((page - 1) * size, page * size);

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
async function purchaseEntryExtras(database, workspaceId, supplierId, supplierItems, pageRows) {
  // The picker shows the same bounded page of suppliers (50, searched on the server) the route already read.
  const counts = pageRows.length ? (await database.query(`SELECT supplier_id,COUNT(*)::int AS n FROM supplier_items
    WHERE workspace_id=$1 AND supplier_id=ANY($2::text[]) AND is_active=1 GROUP BY supplier_id`, [workspaceId, pageRows.map((row) => row.id)])).rows : [];
  const itemCount = new Map(counts.map((row) => [row.supplier_id, Number(row.n)]));
  const supplierRows = pageRows.map((row) => ({ ...row, item_count: itemCount.get(row.id) || 0 }));
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

async function owedBySupplier(database, workspaceId) {
  const rows = (await database.query(`SELECT supplier_id,COUNT(*)::int AS n,COALESCE(SUM(balance_minor),0)::bigint AS owed,MIN(due_date) AS due
    FROM accounting_supplier_bills WHERE workspace_id=$1 AND status IN ('OPEN','PARTIALLY_PAID') AND balance_minor>0 GROUP BY supplier_id`, [workspaceId])).rows;
  return new Map(rows.map((row) => [row.supplier_id, { bills: Number(row.n), minor: Number(row.owed), due: row.due }]));
}

const SUPPLIER_TABS = ['all', 'email', 'owed', 'archived'];

/*
 * Suppliers: active ones under All, with the two things that stop work —
 * no email to send orders to, money owed — as their own tabs.
 */
async function suppliersList(database, workspaceId, suppliers, query = {}) {
  const tab = SUPPLIER_TABS.includes(query.tab) ? query.tab : 'all';
  const q = String(query.q || '').trim().toLowerCase().slice(0, 120);
  let owed = new Map();
  try { owed = await owedBySupplier(database, workspaceId); } catch { owed = new Map(); }
  const all = suppliers.map((s) => ({ ...s, initials: initials(s.name), owed: owed.get(s.id) || null }));
  const active = all.filter((s) => s.isActive);
  const inTab = { all: active, email: active.filter((s) => !s.email), owed: active.filter((s) => s.owed && s.owed.minor > 0),
    archived: all.filter((s) => !s.isActive) };
  const counts = Object.fromEntries(Object.entries(inTab).map(([key, list]) => [key, list.length]));
  const rows = inTab[tab].filter((s) => !q || [s.name, s.contactName, s.email].filter(Boolean).join(' ').toLowerCase().includes(q));
  return { tab, q, counts, rows, total: active.length };
}

/*
 * One supplier: how much is open and owed, how long deliveries really take,
 * what was bought this year, and the setup steps with the one to do now.
 */
async function supplierView(database, workspaceId, supplier, allOrders, can, today = isoDay(new Date())) {
  const mine = allOrders.filter((row) => row.supplier_id === supplier.id).map(decorate);
  const open = mine.filter((o) => ['DRAFT', 'AWAITING_APPROVAL'].includes(o.status) || (OPEN.includes(o.status) && o.outstandingUnits > 0));
  const year = today.slice(0, 4);
  const bought = mine.filter((o) => !['DRAFT', 'AWAITING_APPROVAL', 'CANCELLED'].includes(o.status) && o.orderDate.startsWith(year));
  const [billRows, leadRows] = await Promise.all([
    database.query(`SELECT b.id,b.bill_number,b.supplier_invoice_number,b.status,b.total_minor,b.balance_minor,b.due_date,b.currency,
        b.purchase_order_id,po.po_number FROM accounting_supplier_bills b
        LEFT JOIN purchase_orders po ON po.id=b.purchase_order_id AND po.workspace_id=b.workspace_id
      WHERE b.workspace_id=$1 AND b.supplier_id=$2 AND b.status<>'VOID' ORDER BY b.created_at DESC,b.id DESC LIMIT 50`, [workspaceId, supplier.id]).catch(() => ({ rows: [] })),
    database.query(`SELECT AVG(EXTRACT(EPOCH FROM (first_in::timestamptz-po.order_date::timestamptz))/86400)::numeric AS days,COUNT(*)::int AS n
      FROM (SELECT r.purchase_order_id,MIN(r.received_at) AS first_in FROM purchase_order_receipts r WHERE r.workspace_id=$1 GROUP BY r.purchase_order_id) f
      JOIN purchase_orders po ON po.id=f.purchase_order_id AND po.workspace_id=$1 WHERE po.supplier_id=$2 AND po.order_date IS NOT NULL`, [workspaceId, supplier.id]).catch(() => ({ rows: [] })),
  ]);
  const bills = billRows.rows.map((b) => {
    const total = Number(b.total_minor); const balance = Number(b.balance_minor);
    const badge = b.status === 'PAID' || balance === 0 ? { text: 'Paid', tone: 'green' } : ['DRAFT', 'DISPUTED'].includes(b.status) ? { text: 'Needs review', tone: 'amber' }
      : total > balance ? { text: 'Partly paid', tone: 'amber' } : { text: 'Unpaid', tone: 'rose' };
    return { id: b.id, number: b.supplier_invoice_number || b.bill_number, totalMinor: total, balanceMinor: balance, currency: b.currency || supplier.currency || 'USD',
      poId: b.purchase_order_id, poNumber: b.po_number, due: b.due_date ? shortDay(b.due_date) : null, badge,
      open: ['OPEN', 'PARTIALLY_PAID'].includes(b.status) && balance > 0 };
  });
  const owedBills = bills.filter((b) => b.open);
  const lead = leadRows.rows[0] && Number(leadRows.rows[0].n) > 0 ? Math.round(Number(leadRows.rows[0].days)) : null;
  return {
    initials: initials(supplier.name),
    orders: mine.map((o) => ({ ...o, badge: statusBadge(o.status), expected: o.expectedDate ? shortDay(o.expectedDate) : null })),
    bills,
    kpis: {
      open: { count: open.length, first: open[0] ? `${open[0].number} · ${statusBadge(open[0].status).text.toLowerCase()}` : null },
      owed: { minor: owedBills.reduce((s, b) => s + b.balanceMinor, 0), bills: owedBills.length, due: owedBills.map((b) => b.due).filter(Boolean)[0] || null },
      lead: lead != null ? { days: lead, note: `average of ${leadRows.rows[0].n} deliver${Number(leadRows.rows[0].n) === 1 ? 'y' : 'ies'}` }
        : { days: supplier.defaultLeadTimeDays, note: supplier.defaultLeadTimeDays != null ? 'the lead time you set' : 'not set yet' },
      year: { minor: bought.reduce((s, o) => s + o.totalMinor, 0), orders: bought.length },
    },
  };
}

/*
 * What to order, grouped by the supplier each item is bought from. The
 * suggested amount is the existing "needed" figure from the shortage list,
 * turned into the supplier's packs; nothing here orders anything.
 */
async function reorderView(database, workspaceId, overview) {
  const rows = (overview.rows || []).filter((row) => Number(row.needed) > 0);
  const skuIds = [...new Set(rows.map((row) => row.sku_id))];
  const [links, locations] = await Promise.all([
    skuIds.length ? database.query(`SELECT DISTINCT ON (si.sku_id) si.sku_id,s.id AS supplier_id,s.name,s.email,s.default_lead_time_days,s.currency,
        si.last_unit_cost,si.units_per_purchase_unit,si.purchase_unit,si.supplier_sku
      FROM supplier_items si JOIN suppliers s ON s.id=si.supplier_id AND s.workspace_id=si.workspace_id
      WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND s.status='active'
      ORDER BY si.sku_id,si.is_preferred DESC,lower(s.name),si.id`, [workspaceId, skuIds]) : { rows: [] },
    database.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name,id', [workspaceId]),
  ]);
  const bySku = new Map(links.rows.map((row) => [row.sku_id, row]));
  const groups = new Map();
  const unlinked = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.sku_id}|${row.location_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const link = bySku.get(row.sku_id);
    const item = { skuId: row.sku_id, name: row.displayName || row.item_name, code: row.code || '', locationId: row.location_id || null,
      location: row.location_name || 'All locations', onHand: Number(row.onHand || 0), coming: Number(row.incoming || 0),
      reorderAt: row.effectiveReorder ?? row.reorderPoint ?? null, needed: Number(row.needed) };
    if (!link) { unlinked.push(item); continue; }
    const pack = Math.max(1, Number(link.units_per_purchase_unit || 1));
    const cost = link.last_unit_cost == null ? null : Number(link.last_unit_cost);
    item.pack = pack;
    item.packName = link.purchase_unit || 'unit';
    item.order = Math.max(1, Math.ceil(item.needed / pack));
    item.unitCostMinor = cost == null ? null : Math.round(cost * 100);
    item.costMinor = cost == null ? null : Math.round(item.order * pack * cost * 100);
    if (!groups.has(link.supplier_id)) {
      groups.set(link.supplier_id, { id: link.supplier_id, name: link.name, initials: initials(link.name), email: link.email,
        leadDays: link.default_lead_time_days, currency: link.currency || 'USD', items: [] });
    }
    groups.get(link.supplier_id).items.push(item);
  }
  const list = [...groups.values()].map((group) => {
    const counts = new Map();
    group.items.forEach((item) => { if (item.locationId) counts.set(item.locationId, (counts.get(item.locationId) || 0) + 1); });
    const deliverTo = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || locations.rows[0]?.id || null;
    return { ...group, deliverTo, totalMinor: group.items.reduce((sum, item) => sum + (item.costMinor || 0), 0) };
  }).sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  return { groups: list, unlinked, count: Math.max(seen.size, Number(overview.atOrBelowTotal || 0)), hasMore: Boolean(overview.hasMore), nextAfter: overview.nextAfterSkuId,
    totalMinor: list.reduce((sum, group) => sum + group.totalMinor, 0) };
}

const RETURN_TABS = ['all', 'waiting', 'done'];
const RETURN_DONE = ['RECONCILED', 'CREDIT_MISMATCH', 'CANCELLED'];

/*
 * Supplier returns: each with its PO, units and credit, and the purchase
 * orders a new return can start from (received goods and an open bill to
 * credit, which the existing request requires).
 */
async function supplierReturnsList(database, workspaceId, rows, query = {}) {
  const tab = RETURN_TABS.includes(query.tab) ? query.tab : 'all';
  const q = String(query.q || '').trim().toLowerCase().slice(0, 120);
  const ids = rows.map((row) => row.id);
  const poIds = [...new Set(rows.map((row) => row.purchase_order_id).filter(Boolean))];
  const [units, pos, sources] = await Promise.all([
    ids.length ? database.query(`SELECT supplier_return_id,COALESCE(SUM(quantity),0)::numeric AS n FROM supplier_return_lines WHERE workspace_id=$1 AND supplier_return_id=ANY($2::text[]) GROUP BY supplier_return_id`, [workspaceId, ids]).catch(() => ({ rows: [] })) : { rows: [] },
    poIds.length ? database.query('SELECT id,po_number FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[])', [workspaceId, poIds]) : { rows: [] },
    database.query(`SELECT po.id,po.po_number,s.name AS supplier_name,po.currency,
        (SELECT COALESCE(SUM(quantity_received_units),0) FROM purchase_order_lines l WHERE l.workspace_id=po.workspace_id AND l.purchase_order_id=po.id)::numeric AS received
      FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id AND s.workspace_id=po.workspace_id
      WHERE po.workspace_id=$1 AND EXISTS(SELECT 1 FROM purchase_order_lines l WHERE l.workspace_id=po.workspace_id AND l.purchase_order_id=po.id AND l.quantity_received_units>0)
        AND EXISTS(SELECT 1 FROM accounting_supplier_bills b WHERE b.workspace_id=po.workspace_id AND b.purchase_order_id=po.id AND b.status IN ('OPEN','PARTIALLY_PAID'))
      ORDER BY po.created_at DESC LIMIT 30`, [workspaceId]).catch(() => ({ rows: [] })),
  ]);
  const unitMap = new Map(units.rows.map((row) => [row.supplier_return_id, Number(row.n)]));
  const poMap = new Map(pos.rows.map((row) => [row.id, row.po_number]));
  const all = rows.map((row) => ({ id: row.id, number: row.return_number, supplierName: row.supplier_name, initials: initials(row.supplier_name),
    poId: row.purchase_order_id, poNumber: poMap.get(row.purchase_order_id) || null, units: unitMap.get(row.id) ?? null,
    badge: returnBadge(row.status), done: RETURN_DONE.includes(row.status), createdAt: row.created_at,
    creditMinor: row.actual_credit_minor == null ? null : Number(row.actual_credit_minor), currency: row.currency || 'USD' }));
  const counts = { all: all.length, waiting: all.filter((r) => !r.done).length, done: all.filter((r) => r.done).length };
  const shown = all.filter((r) => (tab === 'all' || (tab === 'done') === r.done) && (!q || [r.number, r.supplierName, r.poNumber].filter(Boolean).join(' ').toLowerCase().includes(q)));
  return { tab, q, counts, rows: shown, sources: sources.rows.map((row) => ({ id: row.id, number: row.po_number, supplierName: row.supplier_name, received: Number(row.received) })) };
}

function supplierReturnSteps(r) {
  const order = ['REQUESTED', 'AUTHORIZED', 'AWAITING_CREDIT', 'RECONCILED'];
  const at = r.status === 'CREDIT_MISMATCH' ? 3 : order.indexOf(r.status);
  const day = (value) => (value ? shortDay(value) : '');
  return [
    { label: 'Requested', note: day(r.created_at), done: at >= 0 },
    { label: 'Approved', note: day(r.authorized_at) || (at < 1 ? 'by supplier' : ''), done: at >= 1 },
    { label: 'Shipped back', note: day(r.shipped_at) || '—', done: at >= 2 },
    { label: 'Credited', note: r.actual_credit_minor == null ? '—' : money(Number(r.actual_credit_minor), r.currency || 'USD'), done: at >= 3 },
  ].map((step, index, list) => ({ ...step, now: r.status !== 'CANCELLED' && !step.done && (index === 0 || list[index - 1].done) }));
}

module.exports = { purchaseOrdersList, purchaseEntryExtras, purchaseOrderView, returnBadge, suppliersList, supplierView, reorderView,
  supplierReturnsList, supplierReturnSteps, statusBadge, billBadge, money, weekday, isoDay, initials, shortDay, TABS };
