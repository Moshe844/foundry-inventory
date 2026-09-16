'use strict';

/**
 * What you hold, as a business position rather than a database table.
 *
 * Sixty-one products that are fine do not need sixty-one rows; they need one
 * line saying they are fine. So the page leads with groups ordered by how much
 * thought each one needs, and every group carries what StockChief has already
 * done about it — because the question somebody opens this page with is "is
 * this handled", not only "what is true".
 *
 * The table has not been deleted. It is one link, at the bottom, where the
 * person who genuinely wants a table will look for it.
 *
 * Two honesty rules, both from the doctrine:
 *
 *   A product with no outbound history produces "StockChief cannot tell yet",
 *   never a judgement. That group is shown rather than hidden, because it is
 *   the reason the other groups can be believed.
 *
 *   Above a size where reading every position would make this page slow, it
 *   says so and sends you to the table, rather than grouping a sample and
 *   presenting it as the whole.
 */

const signalEngine = require('../signals/signal-engine');
const purchasingPosition = require('../purchasing/position');

/** Beyond this, per-position analysis is the wrong thing to do on page load. */
const READABLE_LIMIT = 600;

const LOW_DAYS = 14;
const OVER_DAYS = 120;

function plural(n, one, many) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

/**
 * @returns {{ groups: Array, totals: object, tooLarge: boolean }}
 */
function build(db, workspaceId, { now = Date.now() } = {}) {
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ? AND is_active = 1'
  ).get(workspaceId).n;

  if (count > READABLE_LIMIT) {
    return { groups: [], totals: { skus: count }, tooLarge: true };
  }

  const signals = signalEngine.skuSignals(db, workspaceId, { now })
    .filter((sku) => sku.isActive);

  const onOrder = purchasingPosition.onOrderBySku(db, workspaceId, {
    skuIds: signals.map((sku) => sku.skuId),
  });
  const onOrderFor = (skuId) => {
    const entry = onOrder.get ? onOrder.get(skuId) : null;
    return Number(entry && entry.onOrder) || 0;
  };

  const low = [];
  const over = [];
  const healthy = [];
  const unknown = [];
  const arriving = [];
  const committed = [];

  for (const sku of signals) {
    const measured = sku.measured;
    const estimated = sku.estimated;
    if (onOrderFor(sku.skuId) > 0) arriving.push(sku);
    if (measured.committed > 0) committed.push(sku);

    if (!estimated.hasUsageEvidence) {
      unknown.push(sku);
      continue;
    }
    const days = estimated.daysOfStockRemaining;
    if (measured.available <= 0 || (days !== null && days <= LOW_DAYS)) low.push(sku);
    else if (days !== null && days >= OVER_DAYS) over.push(sku);
    else healthy.push(sku);
  }

  /*
   * What StockChief did about the ones that are short. Counted from real purchase
   * orders rather than asserted, so "I've ordered three of them" is a fact
   * about the records and not a reassurance.
   */
  const orderedAlready = low.filter((sku) => onOrderFor(sku.skuId) > 0).length;
  const stillOpen = low.length - orderedAlready;

  const incomingUnits = signals.reduce((sum, sku) => sum + onOrderFor(sku.skuId), 0);
  const nextArrivals = db.prepare(`SELECT po.expected_date, s.name AS supplier
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.workspace_id = ? AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')
      AND po.expected_date IS NOT NULL
    ORDER BY po.expected_date LIMIT 2`).all(workspaceId);

  const committedUnits = committed.reduce((sum, sku) => sum + sku.measured.committed, 0);
  const openOrders = db.prepare(`SELECT COUNT(DISTINCT so.id) AS n FROM sales_orders so
    WHERE so.workspace_id = ? AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`)
    .get(workspaceId).n;

  const groups = [];

  if (low.length) {
    groups.push({
      key: 'low', icon: 'alert', tone: 'hot', count: low.length,
      name: `${low.length} running low`,
      detail: orderedAlready
        ? `${low.slice(0, 2).map((s) => s.displayName).join(', ')}${low.length > 2 ? ' and others' : ''} — I have ${plural(orderedAlready, 'of them on order', 'of them on order')}${stillOpen ? `, ${stillOpen} still waiting on a decision` : ''}`
        : `${low.slice(0, 2).map((s) => s.displayName).join(', ')}${low.length > 2 ? ' and others' : ''} — nothing is on order to cover them`,
      href: '/inventory/table?group=low',
    });
  }

  if (arriving.length) {
    groups.push({
      key: 'arriving', icon: 'arrive', count: arriving.length,
      name: `${arriving.length} arriving`,
      detail: nextArrivals.length
        ? `${plural(incomingUnits, 'unit', 'units')} — next from ${nextArrivals[0].supplier} on ${nextArrivals[0].expected_date}`
        : `${plural(incomingUnits, 'unit', 'units')} on order, and nobody has given a date`,
      href: '/purchasing/orders',
    });
  }

  if (committed.length) {
    groups.push({
      key: 'committed', icon: 'lot', count: committed.length,
      name: `${committed.length} committed`,
      detail: `${plural(committedUnits, 'unit is', 'units are')} held for ${plural(openOrders, 'customer order', 'customer orders')}, and not available to anybody else`,
      href: '/orders',
    });
  }

  if (over.length) {
    groups.push({
      key: 'over', icon: 'layers', count: over.length,
      name: `${over.length} overstocked`,
      detail: `${over[0].displayName} has ${Math.round(over[0].estimated.daysOfStockRemaining)} days of cover — worth a decision, not urgent`,
      href: '/inventory/table?group=over',
    });
  }

  if (healthy.length) {
    groups.push({
      key: 'healthy', icon: 'check', tone: 'ok', count: healthy.length,
      name: `${healthy.length} healthy`,
      detail: 'Covered past their lead times. Nothing to do.',
      href: '/inventory/table?group=healthy',
    });
  }

  if (unknown.length) {
    groups.push({
      key: 'unknown', icon: 'question', count: unknown.length,
      name: `${unknown.length} I can't judge yet`,
      detail: 'No outbound history, so there is nothing to work demand out from. I will not guess it.',
      href: '/inventory/table?group=unknown',
    });
  }

  return {
    groups,
    tooLarge: false,
    totals: {
      skus: signals.length,
      onHand: signals.reduce((sum, sku) => sum + sku.measured.onHand, 0),
      committed: committedUnits,
      incoming: incomingUnits,
      locations: db.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND is_active = 1')
        .get(workspaceId).n,
    },
  };
}

module.exports = { build, READABLE_LIMIT };
