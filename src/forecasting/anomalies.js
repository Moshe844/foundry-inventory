'use strict';

/**
 * Something changed. Does it change what anyone should do?
 *
 * That second question is the whole module, and skipping it is how monitoring
 * systems die. Detecting unusual numbers is easy and almost worthless: in any
 * catalogue of a few hundred products, something is always three standard
 * deviations from its mean, and a system that reports all of them trains its
 * owner to close the notification without reading it. After a month of that,
 * the one alert that mattered is closed unread too.
 *
 * So every finding here is sorted into one of two piles:
 *
 *   decision       there is an action, and it is different from the action that
 *                  would have been taken without this
 *   informational  true, interesting, and changes nothing — kept where somebody
 *                  can go and look, never pushed at anybody
 *
 * A sales spike on a product with eleven months of stock is informational. The
 * same spike on a product with nine days of cover is a decision. The anomaly is
 * identical; the context is what makes one of them worth interrupting for.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const SEVERITY = { DECISION: 'decision', INFORMATIONAL: 'informational' };

const RULES = {
  // How much recent demand has to move against its own baseline.
  spikeMultiple: 2,
  collapseFraction: 0.4,
  // A single order this many times the typical day is worth a mention.
  largeOrderMultiple: 5,
  // Returns above this share of what went out is a quality or listing problem.
  returnRate: 0.15,
  // Price movement worth telling a buyer about.
  priceMovePct: 10,
  // Lead time drifting past its configured figure by this much.
  leadTimeDriftDays: 2,
  // Cover below which almost any demand change becomes a decision.
  urgentCoverDays: 21,
};

const finding = (input) => ({
  severity: SEVERITY.INFORMATIONAL, recommendation: null, ...input,
});

/**
 * Demand that has changed shape recently.
 *
 * Compares the last week against the weeks before it, using the same censored
 * and one-off-cleaned series the forecast uses — otherwise a restock after a
 * stockout reads as a spike, every single time.
 */
function demandShift({ history, displayName, skuId, daysOfCover }) {
  const days = history.days.filter((day) => !day.censored);
  if (days.length < 21) return null;

  const recent = days.slice(-7);
  const prior = days.slice(-28, -7);
  if (prior.length < 7) return null;

  const recentRate = recent.reduce((sum, day) => sum + day.baselineDemand, 0) / recent.length;
  const priorRate = prior.reduce((sum, day) => sum + day.baselineDemand, 0) / prior.length;
  if (priorRate <= 0) return null;

  const ratio = recentRate / priorRate;
  const urgent = daysOfCover !== null && daysOfCover <= RULES.urgentCoverDays;

  if (ratio >= RULES.spikeMultiple) {
    return finding({
      kind: 'demand_spike',
      skuId,
      headline: `${displayName} is selling ${round(ratio, 1)}× faster than it was`,
      detail: `About ${round(recentRate)} a day this week against ${round(priorRate)} a day over the `
        + 'three weeks before it, ignoring one-off orders and days it was out of stock.',
      // A spike only matters if the stock cannot absorb it.
      severity: urgent ? SEVERITY.DECISION : SEVERITY.INFORMATIONAL,
      recommendation: urgent
        ? `Only about ${Math.round(daysOfCover)} days of cover left at the new pace. Bring the next order forward.`
        : null,
      measurements: { recentRate: round(recentRate), priorRate: round(priorRate), ratio: round(ratio, 2) },
    });
  }

  if (ratio <= RULES.collapseFraction) {
    return finding({
      kind: 'demand_collapse',
      skuId,
      headline: `${displayName} has almost stopped selling`,
      detail: `About ${round(recentRate)} a day this week against ${round(priorRate)} a day before. `
        + 'It has been in stock throughout, so this is not a supply problem.',
      // Falling demand is rarely urgent, but it is urgent not to keep buying.
      severity: SEVERITY.DECISION,
      recommendation: 'Hold off on the next order for this line until it is clear whether this is a lull.',
      measurements: { recentRate: round(recentRate), priorRate: round(priorRate), ratio: round(ratio, 2) },
    });
  }

  return null;
}

/**
 * One order much larger than this product's normal day.
 *
 * Reported so the owner knows why the numbers look odd, and explicitly so they
 * know Foundry has *not* treated it as a new normal.
 */
function largeOrder({ history, displayName, skuId }) {
  if (!history.totals.exceptionalUnits) return null;
  const day = [...history.days].reverse().find((row) => row.exceptional > 0);
  if (!day) return null;
  const order = (day.orders || []).sort((a, b) => b.units - a.units)[0];
  return finding({
    kind: 'large_one_off_order',
    skuId,
    headline: `A single order of ${order ? order.units : day.exceptional} ${displayName} on ${day.date}`,
    detail: 'Much larger than this product\'s usual day, so Foundry has kept it out of the ongoing '
      + 'demand rate rather than letting it raise every future order.',
    severity: SEVERITY.INFORMATIONAL,
    measurements: { date: day.date, units: order ? order.units : day.exceptional, reference: order ? order.reference : null },
  });
}

/** Goods coming back at a rate that suggests something is wrong with them. */
function returns({ history, displayName, skuId }) {
  if (!history.totals.grossDemand) return null;
  const rate = history.totals.returned / history.totals.grossDemand;
  if (rate < RULES.returnRate) return null;
  return finding({
    kind: 'high_return_rate',
    skuId,
    headline: `${Math.round(rate * 100)}% of ${displayName} sold has come back`,
    detail: `${history.totals.returned} of ${history.totals.grossDemand} units returned. Foundry has `
      + 'taken them off demand, so forecasts are not counting sales that unhappened.',
    severity: SEVERITY.DECISION,
    recommendation: 'Worth checking the product or its description before ordering more.',
    measurements: { returned: history.totals.returned, sold: history.totals.grossDemand, rate: round(rate, 3) },
  });
}

/** Stock disappearing without a sale behind it. */
function shrinkage(db, workspaceId, { skuId, displayName, now = Date.now(), windowDays = 90 }) {
  const since = new Date(now - windowDays * DAY_MS).toISOString();
  const row = db.prepare(`SELECT COUNT(*) AS events, COALESCE(SUM(-m.quantity_delta), 0) AS units
    FROM movements m
    WHERE m.workspace_id = ? AND m.sku_id = ? AND m.operation = 'adjust'
      AND m.quantity_delta < 0 AND m.reason_code IN ('loss', 'damage')
      AND m.occurred_at >= ?`).get(workspaceId, skuId, since);
  if (!row || Number(row.events) < 3) return null;
  return finding({
    kind: 'shrinkage_pattern',
    skuId,
    headline: `${displayName} has been written off ${row.events} times in ${windowDays} days`,
    detail: `${row.units} units lost or damaged across ${row.events} separate adjustments. A repeated `
      + 'pattern is different from one bad day.',
    severity: SEVERITY.DECISION,
    recommendation: 'Worth finding out where these are going before replacing them again.',
    measurements: { events: Number(row.events), units: Number(row.units), windowDays },
  });
}

/** A supplier's price moving sharply. */
function priceMoves(reliability) {
  const out = [];
  for (const change of (reliability.prices && reliability.prices.changes) || []) {
    if (Math.abs(change.changePct || 0) < RULES.priceMovePct) continue;
    const up = change.changePct > 0;
    out.push(finding({
      kind: up ? 'supplier_price_increase' : 'supplier_price_decrease',
      supplierId: reliability.supplierId,
      skuId: change.skuId,
      headline: `${reliability.supplierName} has moved the price of ${change.displayName} `
        + `${up ? 'up' : 'down'} ${Math.abs(change.changePct)}%`,
      detail: `From ${change.fromCost} to ${change.toCost} across ${change.observations} documents.`,
      severity: up ? SEVERITY.DECISION : SEVERITY.INFORMATIONAL,
      recommendation: up ? 'Worth checking against other suppliers before the next order.' : null,
      measurements: change,
    }));
  }
  return out;
}

/** A supplier quietly getting slower than their configured figure. */
function leadTimeDrift(timing) {
  if (!timing || timing.source !== 'measured' || !timing.material) return null;
  if (timing.differenceDays === null || timing.differenceDays <= RULES.leadTimeDriftDays) return null;
  return finding({
    kind: 'lead_time_deterioration',
    supplierId: timing.supplierId,
    headline: `${timing.supplierName || 'A supplier'} is taking ${timing.differenceDays} days longer than configured`,
    detail: `Configured at ${timing.configuredDays} days; the last ${timing.measured.samples} orders `
      + `averaged ${timing.measured.meanDays}. Foundry is planning on the longer figure and has left `
      + 'your setting alone.',
    severity: SEVERITY.DECISION,
    recommendation: 'Either the reorder points for this supplier\'s products need to rise, or the '
      + 'supplier needs a conversation.',
    measurements: {
      configuredDays: timing.configuredDays, measuredDays: timing.measured.meanDays,
      samples: timing.measured.samples,
    },
  });
}

/**
 * An order much bigger than this business normally places.
 *
 * A decision, always: it is money about to leave, and a fat finger on a
 * quantity field is one of the few mistakes that is cheap to catch and
 * expensive to miss.
 */
function purchaseQuantity(db, workspaceId, { now = Date.now(), lookbackDays = 365 } = {}) {
  const since = new Date(now - lookbackDays * DAY_MS).toISOString();
  const rows = db.prepare(`SELECT pol.sku_id, pol.quantity_units, po.po_number, po.status, po.created_at,
      i.name AS item_name, s.variant_label
    FROM purchase_order_lines pol
    JOIN purchase_orders po ON po.id = pol.purchase_order_id
    JOIN skus s ON s.id = pol.sku_id
    JOIN items i ON i.id = s.item_id
    WHERE pol.workspace_id = ? AND po.created_at >= ? AND po.status NOT IN ('CANCELLED')
    ORDER BY pol.sku_id, po.created_at`).all(workspaceId, since);

  const bySku = new Map();
  for (const row of rows) {
    if (!bySku.has(row.sku_id)) bySku.set(row.sku_id, []);
    bySku.get(row.sku_id).push(row);
  }

  const out = [];
  for (const [skuId, history] of bySku) {
    if (history.length < 4) continue;                    // no normal to be unusual against
    const latest = history[history.length - 1];
    if (!['DRAFT', 'APPROVED'].includes(latest.status)) continue;   // only worth catching before it goes
    const prior = history.slice(0, -1).map((row) => Number(row.quantity_units));
    const typical = prior.reduce((sum, n) => sum + n, 0) / prior.length;
    if (typical <= 0) continue;
    const ratio = Number(latest.quantity_units) / typical;
    if (ratio < 3) continue;
    const displayName = latest.variant_label ? `${latest.item_name} / ${latest.variant_label}` : latest.item_name;
    out.push(finding({
      kind: 'unusual_purchase_quantity',
      skuId,
      headline: `${latest.po_number} orders ${latest.quantity_units} ${displayName} — `
        + `${round(ratio, 1)}× the usual`,
      detail: `Previous orders for this product averaged ${Math.round(typical)} units.`,
      severity: SEVERITY.DECISION,
      recommendation: 'Worth a second look at the quantity before this is sent.',
      measurements: { ordered: Number(latest.quantity_units), typical: Math.round(typical), ratio: round(ratio, 2) },
    }));
  }
  return out;
}

module.exports = {
  demandShift, largeOrder, returns, shrinkage, priceMoves, leadTimeDrift, purchaseQuantity,
  SEVERITY, RULES,
};
