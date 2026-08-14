'use strict';

/**
 * Purchasing facts, in the shape the Mission 3 detectors already speak.
 *
 * The attention layer was built to reason only about measured facts and clearly
 * labelled estimates. Purchasing does not get an exception: what is on order,
 * which orders are overdue and how prices have moved are all counted here from
 * real records, and the detectors do nothing but compare them with thresholds.
 *
 * This is also where "do not accuse the supplier" is enforced. An order is only
 * eligible to be called late when its expected date came from a stated lead
 * time or a date a person typed. An order whose date Foundry had to invent has
 * no date worth measuring against, so it is never reported as late.
 */

const position = require('./position');
const poService = require('./po-service');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * On-order quantity per SKU, as a map the sku detectors can look into.
 */
function incomingSignals(db, workspaceId, { skuIds = null, now = Date.now() } = {}) {
  return position.onOrderBySku(db, workspaceId, { skuIds, now });
}

/** Open orders whose expected date has passed with stock still outstanding. */
function lateOrderSignals(db, workspaceId, { now = Date.now() } = {}) {
  return position.lateOrders(db, workspaceId, { now }).map((po) => {
    const lines = db
      .prepare(
        `SELECT l.sku_id, l.quantity_units, l.quantity_received_units,
                i.name AS item_name, sk.variant_label
           FROM purchase_order_lines l
           JOIN skus sk ON sk.id = l.sku_id
           JOIN items i ON i.id = sk.item_id
          WHERE l.purchase_order_id = ?
          ORDER BY l.line_number`
      )
      .all(po.id)
      .map((line) => ({
        skuId: line.sku_id,
        displayName: line.variant_label ? `${line.item_name} / ${line.variant_label}` : line.item_name,
        outstanding: Math.max(0, line.quantity_units - line.quantity_received_units),
      }))
      .filter((line) => line.outstanding > 0);

    return {
      poId: po.id,
      poNumber: po.po_number,
      supplierId: po.supplier_id,
      supplierName: po.supplier_name,
      expectedDate: po.expected_date,
      expectedDateSource: po.expected_date_source,
      daysLate: po.daysLate,
      outstandingUnits: po.outstanding_units,
      status: po.status,
      partiallyReceived: po.status === 'PARTIALLY_RECEIVED',
      lines,
    };
  });
}

/**
 * Price movements between the last two committed orders for a product.
 *
 * Both figures are prices actually agreed on real orders. Nothing is inferred
 * from quotes, list prices or anything Foundry has not seen committed.
 */
function priceChangeSignals(db, workspaceId, { skuIds = null, sinceDays = 365, now = Date.now() } = {}) {
  const filter = skuIds && skuIds.length ? ` AND l.sku_id IN (${skuIds.map(() => '?').join(',')})` : '';
  const params = skuIds && skuIds.length ? [workspaceId, ...skuIds] : [workspaceId];

  const skus = db
    .prepare(
      `SELECT DISTINCT l.sku_id AS skuId, i.name AS itemName, sk.variant_label AS variantLabel, i.unit_label AS unitLabel
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.purchase_order_id
         JOIN skus sk ON sk.id = l.sku_id
         JOIN items i ON i.id = sk.item_id
        WHERE l.workspace_id = ? AND l.unit_cost IS NOT NULL
          AND po.status NOT IN ('DRAFT', 'AWAITING_APPROVAL', 'CANCELLED')${filter}`
    )
    .all(...params);

  const cutoff = new Date(now - sinceDays * DAY_MS).toISOString();
  const out = [];
  for (const sku of skus) {
    const change = poService.lastPriceChange(db, workspaceId, sku.skuId);
    if (!change) continue;
    const at = change.current.approvedAt || change.current.orderDate;
    if (at && at < cutoff) continue;
    out.push({
      ...change,
      displayName: sku.variantLabel ? `${sku.itemName} / ${sku.variantLabel}` : sku.itemName,
      unitLabel: sku.unitLabel,
    });
  }
  return out;
}

/** Everything the purchasing detectors need, collected once. */
function collect(db, workspaceId, { skuIds = null, now = Date.now() } = {}) {
  return {
    incoming: incomingSignals(db, workspaceId, { skuIds, now }),
    lateOrders: lateOrderSignals(db, workspaceId, { now }),
    priceChanges: priceChangeSignals(db, workspaceId, { skuIds, now }),
    arrivingSoon: position.arrivingSoon(db, workspaceId, { days: 7, now }),
  };
}

module.exports = {
  incomingSignals,
  lateOrderSignals,
  priceChangeSignals,
  collect,
};
