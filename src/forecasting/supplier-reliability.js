'use strict';

/**
 * Which supplier actually delivers, measured rather than felt.
 *
 * Everyone has an opinion about their suppliers and most of those opinions are
 * formed by the two worst deliveries of the last three years. The record knows
 * better, and the record is already here: orders sent, goods received, dates,
 * quantities, prices.
 *
 * The point is not a scorecard. It is that "cheapest" is the wrong question
 * when a customer is waiting — four percent off a line is worth nothing against
 * an order that misses the date it was promised for, and that trade is only
 * arguable if somebody has counted. So the output is built to be put in a
 * sentence: cheaper by this much, late this often, and here is what that means
 * for the commitment in front of you.
 *
 * StockChief recommends. It does not switch suppliers on its own, however
 * convincing the numbers, because who you buy from is a relationship and not an
 * optimisation — there are terms, histories and favours that are not in any
 * table here.
 */

const leadTime = require('./lead-time');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Below this, a rate is a story about two orders. Reported, never relied on. */
const MINIMUM_ORDERS = 3;

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const pct = (part, whole) => (whole > 0 ? round((part / whole) * 100, 1) : null);

/**
 * Everything measurable about one supplier's behaviour.
 */
function forSupplier(db, workspaceId, supplierId, options = {}) {
  const now = options.now || Date.now();
  const supplier = db.prepare(`SELECT id, name, default_lead_time_days, currency
    FROM suppliers WHERE workspace_id = ? AND id = ?`).get(workspaceId, supplierId);
  if (!supplier) return null;

  const lookbackDays = options.lookbackDays || 365;
  const orders = performanceOrders(db,workspaceId,supplierId,{now,lookbackDays,period:options.period});
  const sampleSize = Number(options.sampleSize);
  const recent = Number.isInteger(sampleSize) && sampleSize > 0 ? orders.slice(-sampleSize) : orders;

  const rated = recent.filter((row) => row.onTime !== null);
  const onTimeCount = rated.filter((row) => row.onTime).length;
  const lateOrders = rated.filter((row) => !row.onTime);
  const orderedUnits = recent.reduce((sum, row) => sum + row.orderedUnits, 0);
  const receivedUnits = recent.reduce((sum, row) => sum + row.receivedUnits, 0);
  const shortOrders = recent.filter((row) => row.shortUnits > 0);
  const partialOrders = recent.filter((row) => row.partial);

  const timing = leadTime.forSupplier(db, workspaceId, supplierId, { now });
  const prices = priceMovement(db, workspaceId, supplierId, { now, withinDays: options.priceWindowDays || 180 });

  const enough = rated.length >= MINIMUM_ORDERS;

  return {
    supplierId,
    supplierName: supplier.name,
    currency: supplier.currency || 'USD',
    orderCount: recent.length,
    deliveredOrderCount: recent.filter((row) => row.receivedUnits > 0).length,
    completedOrderCount: recent.filter((row) => row.complete).length,
    overdueOrderCount: recent.filter((row) => row.overdue).length,
    undeliveredOrderCount: recent.filter((row) => row.receivedUnits === 0).length,
    lookbackDays,
    periodLabel:options.period ? options.period.label : `the last ${lookbackDays} days`,
    enoughEvidence: enough,

    // Did it turn up when they said it would?
    onTimeRate: pct(onTimeCount, rated.length),
    onTimeCount,
    ratedOrders: rated.length,
    lateOrders: lateOrders.map((row) => ({ poNumber: row.poNumber, lateByDays: row.lateByDays })),

    // Did all of it turn up?
    fillRate: pct(receivedUnits, orderedUnits),
    orderedUnits,
    receivedUnits,
    shortOrderCount: shortOrders.length,
    shortOrders: shortOrders.map((row) => ({ poNumber: row.poNumber, shortUnits: row.shortUnits })),

    // Did it turn up all at once? A split delivery is not a failure, but a
    // supplier who always splits is one whose first receipt covers half a plan.
    partialRate: pct(partialOrders.length, recent.length),
    partialOrderCount: partialOrders.length,

    timing,
    prices,
    summary: summarise({ supplier, recent, rated, onTimeCount, timing, prices, enough }),
  };
}

function performanceOrders(db,workspaceId,supplierId,{now,lookbackDays,period}) {
  const from = period ? `${period.from}T00:00:00.000Z` : new Date(now - lookbackDays * DAY_MS).toISOString();
  const to = period ? new Date(Math.min(now,Date.parse(`${period.to}T23:59:59.999Z`))).toISOString() : new Date(now).toISOString();
  return db.prepare(`SELECT po.po_number, po.expected_date,
      COALESCE(po.ordered_at,po.approved_at,po.order_date) AS sent_at,
      (SELECT MAX(r.received_at) FROM purchase_order_receipts r WHERE r.purchase_order_id=po.id) AS last_receipt_at,
      (SELECT COUNT(*) FROM purchase_order_receipts r WHERE r.purchase_order_id=po.id) AS receipt_count,
      (SELECT COALESCE(SUM(pol.quantity_units),0) FROM purchase_order_lines pol WHERE pol.purchase_order_id=po.id) AS ordered_units,
      (SELECT COALESCE(SUM(pol.quantity_received_units),0) FROM purchase_order_lines pol WHERE pol.purchase_order_id=po.id) AS received_units
    FROM purchase_orders po WHERE po.workspace_id=? AND po.supplier_id=?
      AND po.status NOT IN ('DRAFT','CANCELLED')
      AND COALESCE(po.ordered_at,po.approved_at,po.order_date) >= ?
      AND COALESCE(po.ordered_at,po.approved_at,po.order_date) <= ?
    ORDER BY sent_at,po.id`).all(workspaceId,supplierId,from,to).map((row) => {
      const orderedUnits = Number(row.ordered_units);
      const receivedUnits = Number(row.received_units);
      const complete = orderedUnits > 0 && receivedUnits >= orderedUnits;
      const due = row.expected_date ? Date.parse(`${row.expected_date}T23:59:59.999Z`) : NaN;
      const completionAt = complete && row.last_receipt_at ? Date.parse(row.last_receipt_at) : NaN;
      const overdue = Number.isFinite(due) && !complete && now > due;
      const onTime = Number.isFinite(due) && Number.isFinite(completionAt) ? completionAt <= due : overdue ? false : null;
      return {poNumber:row.po_number,orderedUnits,receivedUnits,complete,overdue,onTime,
        partial:Number(row.receipt_count)>1 || (receivedUnits>0 && !complete),
        shortUnits:Math.max(0,orderedUnits-receivedUnits),
        lateByDays:onTime === false ? round(((complete ? completionAt : now)-due)/DAY_MS,1) : null};
    });
}

/**
 * Recent price movement, from the prices read off the supplier's own documents.
 */
function priceMovement(db, workspaceId, supplierId, { now = Date.now(), withinDays = 180 } = {}) {
  const since = new Date(now - withinDays * DAY_MS).toISOString();
  const rows = db.prepare(`SELECT h.sku_id, h.unit_cost, h.observed_at, h.currency,
      i.name AS item_name, s.variant_label
    FROM supplier_price_history h
    JOIN skus s ON s.id = h.sku_id
    JOIN items i ON i.id = s.item_id
    WHERE h.workspace_id = ? AND h.supplier_id = ? AND h.observed_at >= ?
    ORDER BY h.sku_id, h.observed_at`).all(workspaceId, supplierId, since);

  const bySku = new Map();
  for (const row of rows) {
    if (!bySku.has(row.sku_id)) bySku.set(row.sku_id, []);
    bySku.get(row.sku_id).push(row);
  }

  const changes = [];
  for (const [skuId, history] of bySku) {
    if (history.length < 2) continue;
    const first = history[0];
    const last = history[history.length - 1];
    if (Number(first.unit_cost) === Number(last.unit_cost)) continue;
    const changePct = Number(first.unit_cost) > 0
      ? round(((Number(last.unit_cost) - Number(first.unit_cost)) / Number(first.unit_cost)) * 100, 1) : null;
    changes.push({
      skuId,
      displayName: last.variant_label ? `${last.item_name} / ${last.variant_label}` : last.item_name,
      fromCost: Number(first.unit_cost),
      toCost: Number(last.unit_cost),
      changePct,
      currency: last.currency,
      observedAt: last.observed_at,
      observations: history.length,
    });
  }

  changes.sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0));
  return { changes, observedSkus: bySku.size, windowDays: withinDays };
}

function summarise({ supplier, recent, rated, onTimeCount, timing, prices, enough }) {
  if (!recent.length) return `No committed orders are recorded for ${supplier.name} in this review window.`;
  if (!enough) {
    return `${supplier.name} has ${recent.length} committed order${recent.length === 1 ? '' : 's'} in this review window, `
      + `${rated.length} with measurable completion timing${recent.some((row) => row.overdue) ? ', including overdue unfinished orders' : ''}. Not enough timing evidence to describe a reliable pattern.`;
  }
  const parts = [];
  if (rated.length) {
    const late = rated.length - onTimeCount;
    parts.push(late === 0
      ? `${supplier.name} completed all ${rated.length} rated orders by the promised date`
      : `${supplier.name} missed full completion by the promised date on ${late} of ${rated.length} rated orders`);
  }
  if (timing.measured) parts.push(`taking about ${timing.measured.meanDays} days`);
  const bigMove = prices.changes[0];
  if (bigMove && Math.abs(bigMove.changePct || 0) >= 5) {
    parts.push(`and their price on ${bigMove.displayName} has moved ${bigMove.changePct > 0 ? 'up' : 'down'} `
      + `${Math.abs(bigMove.changePct)}%`);
  }
  return `${parts.join(', ')}.`;
}

/**
 * Compares the suppliers who can actually supply one product.
 *
 * Deliberately returns the comparison rather than a winner. The recommendation
 * that comes out of this belongs to whoever is looking at the commitment, and
 * it changes depending on whether there is a customer date attached.
 */
function compareForSku(db, workspaceId, skuId, options = {}) {
  const rows = db.prepare(`SELECT si.id, si.supplier_id, si.last_unit_cost, si.lead_time_days,
      si.minimum_order_quantity, si.order_multiple, si.is_preferred, s.name AS supplier_name
    FROM supplier_items si
    JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.workspace_id = ? AND si.sku_id = ? AND si.is_active = 1 AND s.status = 'active'`)
    .all(workspaceId, skuId);

  const candidates = rows.map((row) => {
    const reliability = forSupplier(db, workspaceId, row.supplier_id, options);
    return {
      supplierItemId: row.id,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      unitCost: row.last_unit_cost === null ? null : Number(row.last_unit_cost),
      configuredLeadTimeDays: row.lead_time_days === null ? null : Number(row.lead_time_days),
      minimumOrderQuantity: row.minimum_order_quantity,
      orderMultiple: row.order_multiple,
      preferred: Boolean(row.is_preferred),
      reliability,
      planningLeadTimeDays: reliability ? reliability.timing.planningDays : null,
    };
  });

  const priced = candidates.filter((row) => row.unitCost !== null);
  const cheapest = priced.length
    ? priced.reduce((best, row) => (row.unitCost < best.unitCost ? row : best)) : null;
  const rated = candidates.filter((row) => row.reliability && row.reliability.enoughEvidence
    && row.reliability.onTimeRate !== null);
  const mostReliable = rated.length
    ? rated.reduce((best, row) => (row.reliability.onTimeRate > best.reliability.onTimeRate ? row : best)) : null;

  return { candidates, cheapest, mostReliable };
}

/**
 * The sentence a buyer actually needs when cheapest and most reliable differ.
 *
 * `quantity` and a customer commitment are what make the trade concrete: money
 * saved is a number, and a missed customer date is a number too.
 */
function explainChoice({ cheapest, mostReliable }, { quantity = 1, hasCommitment = false, currency = 'USD' } = {}) {
  if (!cheapest || !mostReliable || cheapest.supplierId === mostReliable.supplierId) return null;
  if (mostReliable.unitCost === null) return null;

  const extra = round((mostReliable.unitCost - cheapest.unitCost) * quantity, 2);
  if (!(extra > 0)) return null;

  const cheapRate = cheapest.reliability && cheapest.reliability.onTimeRate;
  const cheapLate = cheapest.reliability
    ? cheapest.reliability.ratedOrders - cheapest.reliability.onTimeCount : null;
  const money = `${currency === 'USD' ? '$' : `${currency} `}${extra.toFixed(2)}`;
  const savingPct = cheapest.unitCost > 0
    ? round(((mostReliable.unitCost - cheapest.unitCost) / mostReliable.unitCost) * 100, 1) : null;

  const late = cheapLate !== null && cheapest.reliability.ratedOrders
    ? `has delivered late on ${cheapLate} of the last ${cheapest.reliability.ratedOrders} orders`
    : `has no delivery record to stand on`;

  return {
    cheaperSupplier: cheapest.supplierName,
    reliableSupplier: mostReliable.supplierName,
    extraCost: extra,
    savingPct,
    onTimeRate: cheapRate,
    text: `${cheapest.supplierName} is ${savingPct === null ? 'cheaper' : `${savingPct}% cheaper`}, but ${late}. `
      + `${mostReliable.supplierName} costs ${money} more on this order`
      + (hasCommitment ? ' and is the one likely to meet the customer commitment.' : '.'),
  };
}

module.exports = { forSupplier, compareForSku, explainChoice, priceMovement, MINIMUM_ORDERS };
