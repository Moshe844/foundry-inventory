'use strict';

/**
 * How long this supplier actually takes, as opposed to how long they said.
 *
 * A configured lead time is a promise somebody typed in once, usually at setup,
 * usually from the supplier's own sales material. It is the single most common
 * reason a well-run reorder point still runs out: the rule is arithmetically
 * perfect and the input is three days optimistic, every time, for a year.
 *
 * So once there is real evidence, Foundry plans on the evidence. What it must
 * never do is edit the owner's configured value. That number is theirs; it may
 * be a negotiated term, it may be what the contract says, and silently
 * replacing it would mean the supplier page shows a figure nobody chose. The
 * configured value stays exactly as typed, the measured value sits beside it,
 * and the planning figure says which of the two it used and why.
 *
 * Three different things, kept apart because they disagree in useful ways:
 *
 *   configured   what the owner set up
 *   promised     what the supplier said about a specific order
 *   actual       ordered_at to goods-on-the-shelf, measured
 *
 * Actual is measured to first receipt, not last. The question a reorder point
 * asks is "when does stock start arriving", and a delivery that trickles in
 * over a fortnight has already saved you on the first day.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * Below this many completed orders, measured lead time is an anecdote. Three is
 * deliberately low — waiting for a statistically comfortable sample means a
 * year of ordering to the wrong number — but it is reported alongside, so a
 * recommendation resting on three orders says it rests on three orders.
 */
const MINIMUM_SAMPLES = 3;

/*
 * How far measured has to be from configured before Foundry mentions it at all.
 * Half a day of drift is not news, and an assistant that reports it every week
 * gets ignored about the things that matter.
 */
const MATERIAL_DIFFERENCE_DAYS = 1.5;

/** Orders older than this stop describing the supplier's current behaviour. */
const LOOKBACK_DAYS = 365;

const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const daysBetween = (fromIso, toIso) => {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / DAY_MS;
};

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, n) => sum + (n - average) ** 2, 0) / (values.length - 1));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Completed orders for a supplier, each reduced to the facts about its timing.
 *
 * Only orders that were actually sent and actually arrived. A draft has no
 * lead time, and a cancelled order's silence is not lateness.
 */
function deliveries(db, workspaceId, supplierId, { now = Date.now(), lookbackDays = LOOKBACK_DAYS, skuId = null } = {}) {
  const since = new Date(now - lookbackDays * DAY_MS).toISOString();
  const skuJoin = skuId
    ? `AND EXISTS (SELECT 1 FROM purchase_order_lines pol
         WHERE pol.purchase_order_id = po.id AND pol.sku_id = ?)` : '';
  const params = skuId ? [workspaceId, supplierId, since, skuId] : [workspaceId, supplierId, since];

  return db.prepare(`SELECT po.id, po.po_number, po.expected_date, po.expected_date_source,
      COALESCE(po.ordered_at, po.approved_at, po.order_date) AS sent_at,
      (SELECT MIN(r.received_at) FROM purchase_order_receipts r
        WHERE r.purchase_order_id = po.id) AS first_receipt_at,
      (SELECT MAX(r.received_at) FROM purchase_order_receipts r
        WHERE r.purchase_order_id = po.id) AS last_receipt_at,
      (SELECT COUNT(*) FROM purchase_order_receipts r
        WHERE r.purchase_order_id = po.id) AS receipt_count,
      (SELECT COALESCE(SUM(pol.quantity_units), 0) FROM purchase_order_lines pol
        WHERE pol.purchase_order_id = po.id) AS ordered_units,
      (SELECT COALESCE(SUM(pol.quantity_received_units), 0) FROM purchase_order_lines pol
        WHERE pol.purchase_order_id = po.id) AS received_units
    FROM purchase_orders po
    WHERE po.workspace_id = ? AND po.supplier_id = ?
      AND po.status NOT IN ('DRAFT', 'CANCELLED')
      AND COALESCE(po.ordered_at, po.approved_at, po.order_date) >= ?
      ${skuJoin}
    ORDER BY COALESCE(po.ordered_at, po.approved_at, po.order_date)`).all(...params)
    .filter((row) => row.sent_at && row.first_receipt_at)
    .map((row) => {
      const actualDays = daysBetween(row.sent_at, row.first_receipt_at);
      const promisedDays = row.expected_date ? daysBetween(row.sent_at, `${row.expected_date}T00:00:00.000Z`) : null;
      return {
        purchaseOrderId: row.id,
        poNumber: row.po_number,
        sentAt: row.sent_at,
        firstReceiptAt: row.first_receipt_at,
        lastReceiptAt: row.last_receipt_at,
        expectedDate: row.expected_date,
        expectedDateSource: row.expected_date_source,
        actualDays: actualDays === null ? null : round(actualDays),
        promisedDays: promisedDays === null ? null : round(promisedDays),
        // Late against what they promised, not against what we hoped.
        lateByDays: promisedDays === null || actualDays === null ? null : round(actualDays - promisedDays),
        onTime: promisedDays === null || actualDays === null ? null : actualDays <= promisedDays + 0.5,
        partial: Number(row.receipt_count) > 1,
        orderedUnits: Number(row.ordered_units),
        receivedUnits: Number(row.received_units),
        shortUnits: Math.max(0, Number(row.ordered_units) - Number(row.received_units)),
      };
    })
    .filter((row) => row.actualDays !== null && row.actualDays >= 0);
}

/**
 * The figure to plan with, and the argument for it.
 *
 * @param options.supplierItem the per-product supplier record, when there is
 *        one; its lead time beats the supplier's general figure because it was
 *        set about this product.
 */
function forSupplier(db, workspaceId, supplierId, options = {}) {
  const supplier = db.prepare('SELECT id, name, default_lead_time_days FROM suppliers WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, supplierId);
  const supplierItem = options.supplierItem || null;

  const configured = supplierItem && supplierItem.leadTimeDays != null
    ? Number(supplierItem.leadTimeDays)
    : (supplier && supplier.default_lead_time_days != null ? Number(supplier.default_lead_time_days) : null);
  const configuredFrom = supplierItem && supplierItem.leadTimeDays != null
    ? 'this product with this supplier'
    : (configured !== null ? 'the supplier record' : null);

  const history = deliveries(db, workspaceId, supplierId, {
    now: options.now, lookbackDays: options.lookbackDays, skuId: options.skuId || null,
  });
  const recent = history.slice(-12);
  const actualDays = recent.map((row) => row.actualDays);

  const measured = actualDays.length ? {
    samples: actualDays.length,
    meanDays: round(mean(actualDays)),
    medianDays: round(median(actualDays)),
    // The spread is what safety stock is actually for. A supplier who is
    // reliably slow needs a bigger reorder point; one who is erratic needs a
    // buffer, and the two are different problems with different answers.
    variabilityDays: round(stdev(actualDays)),
    slowestDays: round(Math.max(...actualDays)),
    fastestDays: round(Math.min(...actualDays)),
    onTimeCount: recent.filter((row) => row.onTime === true).length,
    ratedCount: recent.filter((row) => row.onTime !== null).length,
    lateOrders: recent.filter((row) => row.onTime === false)
      .map((row) => ({ poNumber: row.poNumber, lateByDays: row.lateByDays })),
  } : null;

  const enough = Boolean(measured && measured.samples >= MINIMUM_SAMPLES);
  const difference = enough && configured !== null ? round(measured.meanDays - configured) : null;
  const material = difference !== null && Math.abs(difference) >= MATERIAL_DIFFERENCE_DAYS;

  /*
   * The decision, in one place. Measured evidence wins when there is enough of
   * it; otherwise the configured value stands. Either way the configured value
   * is untouched — this function returns a plan, it does not write anything.
   */
  let planningDays;
  let source;
  let explanation;

  if (enough) {
    planningDays = measured.meanDays;
    source = 'measured';
    if (configured === null) {
      explanation = `${supplier ? supplier.name : 'This supplier'} has taken about `
        + `${measured.meanDays} days across the last ${measured.samples} orders. No lead time is configured, `
        + 'so that is what Foundry is planning on.';
    } else if (material) {
      explanation = `${supplier ? supplier.name : 'This supplier'} is configured at ${configured} days but has `
        + `recently been taking about ${measured.meanDays} across the last ${measured.samples} orders. `
        + 'Foundry is planning on the longer figure and leaving your setting alone.';
    } else {
      explanation = `${supplier ? supplier.name : 'This supplier'} takes about ${measured.meanDays} days, `
        + `close to the ${configured} configured.`;
    }
  } else if (configured !== null) {
    planningDays = configured;
    source = 'configured';
    const seen = measured ? `Only ${measured.samples} delivered order${measured.samples === 1 ? '' : 's'} so far, ` : 'No delivered orders yet, ';
    explanation = `${seen}so Foundry is using the ${configured} days set on ${configuredFrom}.`;
  } else {
    planningDays = null;
    source = 'unknown';
    explanation = 'No lead time is configured and no delivery has been recorded, so Foundry cannot say how long this takes.';
  }

  return {
    supplierId,
    supplierName: supplier ? supplier.name : null,
    configuredDays: configured,
    configuredFrom,
    measured,
    planningDays,
    source,
    material,
    differenceDays: difference,
    explanation,
    deliveries: recent,
    minimumSamples: MINIMUM_SAMPLES,
  };
}

module.exports = {
  forSupplier, deliveries, MINIMUM_SAMPLES, MATERIAL_DIFFERENCE_DAYS, LOOKBACK_DAYS,
  mean, stdev, median,
};
