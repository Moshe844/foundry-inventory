'use strict';

/**
 * Inventory position: what exists, and what is already coming.
 *
 * This is the distinction Mission 6 turns on. Before it, "11 left and using 27
 * a month" meant order something. After it, that same line might have 48 units
 * arriving on Friday, and telling someone to order more would be telling them
 * to buy stock twice.
 *
 * Two figures, kept separate and never blended:
 *
 *   onHand   — counted from Mission 1 balances. Stock that physically exists.
 *   onOrder  — ordered and not yet received, from purchase orders a person has
 *              actually committed to.
 *
 * A draft order is not incoming stock. Only APPROVED, ORDERED and
 * PARTIALLY_RECEIVED count, because those are the ones a supplier has been (or
 * is about to be) told about. Counting drafts would let an unapproved idea
 * suppress a real shortage.
 *
 * There is deliberately no "available" figure that nets off customer demand:
 * Foundry has no sales orders and no reservations, so any such number would be
 * invented.
 */

const OPEN_STATUSES = ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'];
const { localDateKey, addLocalDays, daysBetween } = require('../lib/calendar');

const openStatusList = OPEN_STATUSES.map(() => '?').join(',');

/**
 * On-order quantities per SKU, with what they are waiting on.
 *
 * @returns {Map<string, {onOrder, lines, nextExpectedDate, orders}>}
 */
function onOrderBySku(db, workspaceId, { skuIds = null, now = Date.now() } = {}) {
  const filter = skuIds && skuIds.length ? ` AND l.sku_id IN (${skuIds.map(() => '?').join(',')})` : '';
  const params = skuIds && skuIds.length
    ? [workspaceId, ...OPEN_STATUSES, ...skuIds]
    : [workspaceId, ...OPEN_STATUSES];

  const rows = db
    .prepare(
      `SELECT l.sku_id, l.id AS line_id, l.quantity_units, l.quantity_received_units,
              l.purchase_unit, l.units_per_purchase_unit,
              po.id AS po_id, po.po_number, po.status, po.expected_date, po.expected_date_source,
              po.supplier_id, s.name AS supplier_name
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.purchase_order_id
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE l.workspace_id = ? AND po.status IN (${openStatusList})${filter}`
    )
    .all(...params);

  const bySku = new Map();
  for (const row of rows) {
    const outstanding = Math.max(0, row.quantity_units - row.quantity_received_units);
    if (outstanding === 0) continue;

    if (!bySku.has(row.sku_id)) {
      bySku.set(row.sku_id, { onOrder: 0, lines: [], orders: new Map(), nextExpectedDate: null, overdueUnits: 0 });
    }
    const entry = bySku.get(row.sku_id);
    entry.onOrder += outstanding;
    entry.lines.push({
      lineId: row.line_id,
      poId: row.po_id,
      poNumber: row.po_number,
      status: row.status,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      outstanding,
      expectedDate: row.expected_date,
      expectedDateSource: row.expected_date_source,
    });
    entry.orders.set(row.po_id, row.po_number);

    if (row.expected_date) {
      if (!entry.nextExpectedDate || row.expected_date < entry.nextExpectedDate) {
        entry.nextExpectedDate = row.expected_date;
      }
      if (row.expected_date < localDateKey(now)) entry.overdueUnits += outstanding;
    }
  }

  for (const entry of bySku.values()) {
    entry.orders = [...entry.orders.entries()].map(([id, number]) => ({ poId: id, poNumber: number }));
  }
  return bySku;
}

/** The same figure for one SKU, or zero. */
function onOrderForSku(db, workspaceId, skuId) {
  const map = onOrderBySku(db, workspaceId, { skuIds: [skuId] });
  return map.get(skuId) || { onOrder: 0, lines: [], orders: [], nextExpectedDate: null, overdueUnits: 0 };
}

/**
 * On hand and on order together, for one SKU.
 *
 * `position` is the sum: what the business will have once everything committed
 * has arrived, assuming none of it is used in the meantime. It is a planning
 * figure, never a stock figure, and nothing displays it as stock.
 */
function positionForSku(db, workspaceId, skuId) {
  const onHand = db
    .prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?')
    .get(workspaceId, skuId).n;
  const incoming = onOrderForSku(db, workspaceId, skuId);
  const committed = require('../sales/sales-order-service').committedByPosition(db, workspaceId, { skuIds: [skuId] })
    .reduce((total, row) => total + Number(row.committed || 0), 0);
  const available = onHand - committed;
  return {
    skuId,
    onHand,
    committed,
    available,
    onOrder: incoming.onOrder,
    position: available + incoming.onOrder,
    physicalPosition: onHand + incoming.onOrder,
    nextExpectedDate: incoming.nextExpectedDate,
    overdueUnits: incoming.overdueUnits,
    orders: incoming.orders,
    lines: incoming.lines,
  };
}

/** Purchase orders with something still outstanding. */
/**
 * Units for a SKU sitting in orders that are prepared but not yet placed.
 *
 * Deliberately separate from on-order. A draft is not stock coming: nobody has
 * told the supplier anything, and counting it as inbound would overstate what
 * the business actually has claim to. But it is a decision already taken and
 * waiting on a signature, and a recommendation that ignores it will keep
 * telling you to order what is already prepared — and will happily prepare it
 * a second time when you agree.
 */
function draftedForSku(db, workspaceId, skuId) {
  const rows = db
    .prepare(
      `SELECT l.quantity_units, l.quantity_received_units, po.id AS poId, po.po_number AS poNumber
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.purchase_order_id
        WHERE l.workspace_id = ? AND l.sku_id = ?
          AND po.status IN ('DRAFT', 'AWAITING_APPROVAL')`
    )
    .all(workspaceId, skuId);

  let units = 0;
  const orders = [];
  for (const row of rows) {
    const outstanding = Math.max(0, row.quantity_units - row.quantity_received_units);
    if (outstanding === 0) continue;
    units += outstanding;
    if (!orders.some((o) => o.poId === row.poId)) {
      orders.push({ poId: row.poId, poNumber: row.poNumber });
    }
  }
  return { units, orders };
}

function openOrders(db, workspaceId, { supplierId = null } = {}) {
  const clause = supplierId ? ' AND po.supplier_id = ?' : '';
  const params = supplierId ? [workspaceId, ...OPEN_STATUSES, supplierId] : [workspaceId, ...OPEN_STATUSES];
  return db
    .prepare(
      `SELECT po.*, s.name AS supplier_name,
              (SELECT COALESCE(SUM(l.quantity_units - l.quantity_received_units), 0)
                 FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS outstanding_units
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.workspace_id = ? AND po.status IN (${openStatusList})${clause}
        ORDER BY po.expected_date IS NULL, po.expected_date, po.created_at`
    )
    .all(...params);
}

/**
 * Orders whose expected date has passed with stock still outstanding.
 *
 * Only orders whose date came from something real — a supplier's stated lead
 * time, or a date a person typed — are eligible. Calling a supplier late
 * against a date Foundry invented would be an accusation it cannot support.
 */
function lateOrders(db, workspaceId, { now = Date.now(), graceDays = 0 } = {}) {
  const cutoff = addLocalDays(now, -graceDays);
  return openOrders(db, workspaceId)
    .filter((po) => po.expected_date && po.expected_date < cutoff && po.outstanding_units > 0)
    .filter((po) => po.expected_date_source && po.expected_date_source !== 'unknown')
    .map((po) => ({
      ...po,
      daysLate: daysBetween(po.expected_date, localDateKey(now)),
    }));
}

/** Orders expected to arrive between today and `days` from now. */
function arrivingSoon(db, workspaceId, { days = 7, now = Date.now() } = {}) {
  const today = localDateKey(now);
  const until = addLocalDays(now, days);
  return openOrders(db, workspaceId).filter(
    (po) => po.expected_date && po.expected_date >= today && po.expected_date <= until && po.outstanding_units > 0
  );
}

module.exports = {
  draftedForSku,
  OPEN_STATUSES,
  onOrderBySku,
  onOrderForSku,
  positionForSku,
  openOrders,
  lateOrders,
  arrivingSoon,
};
