'use strict';

/*
 * View model for the Orders list.
 *
 * Nothing here is a new business fact. The list reads the same orders the
 * presenter already decorated and only sorts each one into exactly one tab, so
 * the tab counts always add up to All. The two extra reads — which orders have
 * an invoice, and which orders contain a searched product — exist only so the
 * Payment badge can tell "not invoiced" from "paid" and the search box can
 * find a product name.
 */

const PAGE_SIZE = 50;
const TABS = ['all', 'needs', 'ship', 'unpaid', 'done'];
// Older links used ?view=; keep them landing on the matching tab.
const LEGACY_VIEWS = { stuck: 'needs', ready: 'ship', moving: 'ship', unpaid: 'unpaid', done: 'done' };

function isoDay(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function shortDay(value) {
  const day = isoDay(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function initials(name) {
  return String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
    .slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
}

// A cancelled order that had already shipped part of itself keeps its invoice,
// so it can still be owed money.
const shippedSome = (order) => Number(order.units_fulfilled || 0) > 0;

function bucket(order) {
  if (order.status === 'CANCELLED') return 'done';
  if (order.status === 'FULFILLED') return Number(order.balance_minor) > 0 ? 'unpaid' : 'done';
  if (order.status === 'DRAFT' || (order.next && order.next.rank >= 80)) return 'needs';
  return 'ship';
}

function statusBadge(order) {
  switch (order.status) {
    case 'DRAFT': return { text: 'Draft', tone: 'amber' };
    case 'BACKORDERED': return { text: 'Waiting for stock', tone: 'amber' };
    case 'CONFIRMED': return { text: 'Ready to ship', tone: 'blue' };
    case 'PARTIALLY_FULFILLED': return { text: 'Being shipped', tone: 'blue' };
    case 'FULFILLED': return { text: 'Delivered', tone: 'green' };
    case 'CANCELLED': return { text: require('../sales/order-status').label(order.status, Number(order.units_fulfilled || 0), order.delivery_method), tone: 'grey' };
    default: return { text: String(order.status || '').toLowerCase(), tone: 'grey' };
  }
}

// Payment is read from money actually received, not from whether an invoice
// exists yet: an order paid upfront is paid before anything has shipped.
function paymentBadge(order, invoiced, paidMinor) {
  const total = Number(order.pricing.totalMinor || 0);
  const quiet = order.status === 'DRAFT' || (order.status === 'CANCELLED' && !shippedSome(order));
  if (quiet && !paidMinor) return null;
  if ((invoiced && Number(order.balance_minor) === 0) || (total > 0 && paidMinor >= total)) return { text: 'Paid', tone: 'green' };
  if (paidMinor > 0) return { text: 'Partly paid', tone: 'amber' };
  return { text: 'Unpaid', tone: invoiced ? 'rose' : 'grey' };
}

function rowAction(order, tab) {
  const href = `/orders/${order.id}`;
  if (order.status === 'DRAFT') return { label: 'Confirm', href: `${href}#approve-order`, kind: 'secondary' };
  if (order.status === 'CONFIRMED' || order.status === 'PARTIALLY_FULFILLED') {
    return { label: 'Ship', href: `${href}?open=fulfilment#fulfilment`, kind: 'secondary' };
  }
  if (tab === 'unpaid') return { label: 'Record payment', href: `${href}?open=money#money`, kind: 'ghost' };
  return null;
}

async function matchingOrderIds(database, workspaceId, q) {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = (await database.query(`SELECT DISTINCT so.id FROM sales_orders so
      JOIN customers c ON c.id=so.customer_id AND c.workspace_id=so.workspace_id
      LEFT JOIN sales_order_lines sol ON sol.sales_order_id=so.id AND sol.workspace_id=so.workspace_id
      LEFT JOIN skus s ON s.id=sol.sku_id AND s.workspace_id=so.workspace_id
      LEFT JOIN items i ON i.id=s.item_id AND i.workspace_id=so.workspace_id
    WHERE so.workspace_id=$1 AND (so.order_number ILIKE $2 OR c.name ILIKE $2 OR COALESCE(c.email,'') ILIKE $2
      OR COALESCE(i.name,'') ILIKE $2 OR COALESCE(s.code,'') ILIKE $2 OR COALESCE(s.variant_label,'') ILIKE $2)`,
  [workspaceId, like])).rows;
  return new Set(rows.map((row) => row.id));
}

async function ordersList(database, workspaceId, result, query = {}) {
  const requested = String(query.status || LEGACY_VIEWS[query.view] || 'all');
  const tab = TABS.includes(requested) ? requested : 'all';
  const q = String(query.q || '').trim().slice(0, 120);
  const invoicedRows = (await database.query(`SELECT DISTINCT sales_order_id FROM accounting_customer_invoices
    WHERE workspace_id=$1 AND sales_order_id IS NOT NULL AND status<>'VOID'`, [workspaceId])).rows;
  const invoiced = new Set(invoicedRows.map((row) => row.sales_order_id));
  const paidRows = (await database.query(`SELECT sales_order_id,SUM(amount_minor)::bigint AS minor FROM accounting_payments
    WHERE workspace_id=$1 AND direction='CUSTOMER_RECEIPT' AND status='POSTED' AND sales_order_id IS NOT NULL
    GROUP BY sales_order_id`, [workspaceId])).rows;
  const paid = new Map(paidRows.map((row) => [row.sales_order_id, Number(row.minor)]));

  const all = result.orders.map((order) => {
    const tabKey = bucket(order);
    return {
      id: order.id, number: order.order_number, status: order.status, tab: tabKey,
      customer: order.customer.name, initials: initials(order.customer.name),
      date: shortDay(order.order_date || order.created_at), day: isoDay(order.order_date || order.created_at),
      totalMinor: Number(order.pricing.totalMinor || 0), balanceMinor: Number(order.balance_minor || 0),
      currency: order.currency || 'USD', badge: statusBadge(order), payment: paymentBadge(order, invoiced.has(order.id), paid.get(order.id) || 0),
      action: rowAction(order, tabKey), attention: tabKey === 'needs', muted: order.status === 'CANCELLED' && tabKey === 'done',
    };
  });
  const counts = { all: all.length, needs: 0, ship: 0, unpaid: 0, done: 0 };
  all.forEach((row) => { counts[row.tab] += 1; });

  const matches = q ? await matchingOrderIds(database, workspaceId, q) : null;
  const filtered = all.filter((row) => (tab === 'all' || row.tab === tab) && (!matches || matches.has(row.id)));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.page, 10) || 1));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const month = new Date().toISOString().slice(0, 7);
  const open = result.orders.filter((order) => ['CONFIRMED', 'BACKORDERED', 'PARTIALLY_FULFILLED'].includes(order.status));
  const readyToShip = all.filter((row) => row.status === 'CONFIRMED');
  const unpaid = all.filter((row) => row.tab === 'unpaid');
  const kpis = {
    open: { count: open.length, minor: open.reduce((sum, order) => sum + Number(order.pricing.totalMinor || 0), 0) },
    ready: { count: readyToShip.length, first: readyToShip.length === 1 ? readyToShip[0].number : null },
    unpaid: { count: unpaid.length, minor: unpaid.reduce((sum, row) => sum + row.balanceMinor, 0) },
    month: { minor: all.filter((row) => row.day.startsWith(month) && !['DRAFT', 'CANCELLED'].includes(row.status))
      .reduce((sum, row) => sum + row.totalMinor, 0) },
  };
  return { tab, q, counts, rows, page, pages, shown: rows.length, matching: filtered.length, kpis,
    currency: (result.orders[0] && result.orders[0].currency) || 'USD' };
}

module.exports = { ordersList, bucket, initials, shortDay, PAGE_SIZE };
