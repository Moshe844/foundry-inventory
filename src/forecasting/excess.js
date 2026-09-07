'use strict';

/**
 * Money asleep on a shelf.
 *
 * Overstock is the quiet failure. A stockout announces itself — a customer asks
 * and the answer is no. Excess never does: the stock is there, the books are
 * right, the shelf looks healthy, and the only symptom is that the bank balance
 * is lower than the trading justifies. Nobody notices a product that has 400
 * days of supply because nothing ever goes wrong with it.
 *
 * The measure used here is days of supply rather than units or value, because
 * days is the only one that means the same thing across products. Four hundred
 * of something that sells forty a day is a fortnight's cover; four hundred of
 * something that sells one a day is more than a year of it, and the second is a
 * problem while the first is a Tuesday.
 *
 * Three distinct conditions, because the answer to each is different:
 *
 *   overstock   sells, but there is far too much of it → stop buying, move it
 *   slow        sells rarely; the stock may be right → check it is still wanted
 *   dead        has not sold at all in a long time    → decide what it is for
 *
 * And a rule about tone. This module reports and recommends operational
 * responses — stop ordering, move it, lower the target. It does not tell people
 * to discount, run a promotion, or reprice. That is a merchandising decision
 * involving brand, margin and customers, and a system that starts suggesting
 * markdowns from a days-of-supply number has wandered far outside what it can
 * see.
 */

const forecastEngine = require('./forecast');

const DAY_MS = 24 * 60 * 60 * 1000;

const THRESHOLDS = {
  // Above this many days of supply, the stock is beyond any ordinary reason.
  overstockDays: 120,
  // Nothing has left in this long, but it has moved at some point.
  slowDays: 90,
  // Nothing has ever left, or nothing in this long. A different conversation.
  deadDays: 180,
  // Ignore trivia. A rounding error's worth of excess is not worth a sentence.
  minimumValueMinor: 5_000,
  minimumUnits: 2,
};

const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const money = (minor, currency = 'USD') =>
  `${currency === 'USD' ? '$' : `${currency} `}${(Number(minor || 0) / 100).toFixed(2)}`;

/**
 * Every product holding stock, with what it is worth and how fast it moves.
 *
 * Cost comes from the accounting cost balances, so the value quoted is what the
 * business actually paid — never a selling price, which would make every
 * overstock report flatter than the truth.
 */
function positions(db, workspaceId, { now = Date.now() } = {}) {
  /*
   * Three correlated subqueries became three grouped passes.
   *
   * Written per row, "what did this cost", "when did it last sell" and "when
   * did we first see it" each re-scan the ledger for every SKU in the
   * catalogue. At six hundred lines that is eighteen hundred scans and 186ms;
   * at fifty thousand it is a hundred and fifty thousand, and this runs behind
   * the decision inbox on every page in the product.
   *
   * Asked once each and joined on, it is a single pass over each table. Same
   * columns, same rows, same order.
   */
  return db.prepare(`WITH cost AS (
      SELECT sku_id, SUM(total_cost_minor) AS cost_minor
        FROM accounting_inventory_cost_balances
       WHERE workspace_id = ? GROUP BY sku_id
    ), sold AS (
      SELECT sku_id, MAX(occurred_at) AS last_sold_at
        FROM movements
       WHERE workspace_id = ? AND operation = 'issue'
         AND reason_code IN ('sold', 'used')
       GROUP BY sku_id
    ), seen AS (
      SELECT sku_id, MIN(occurred_at) AS first_seen_at
        FROM movements WHERE workspace_id = ? GROUP BY sku_id
    )
    SELECT s.id AS sku_id, s.code, s.variant_label, i.name AS item_name, i.unit_label,
      COALESCE(SUM(b.on_hand), 0) AS on_hand,
      COALESCE(cost.cost_minor, 0) AS cost_minor,
      sold.last_sold_at AS last_sold_at,
      seen.first_seen_at AS first_seen_at
    FROM skus s
    JOIN items i ON i.id = s.item_id
    LEFT JOIN balances b ON b.sku_id = s.id AND b.workspace_id = s.workspace_id
    LEFT JOIN cost ON cost.sku_id = s.id
    LEFT JOIN sold ON sold.sku_id = s.id
    LEFT JOIN seen ON seen.sku_id = s.id
    WHERE s.workspace_id = ? AND s.is_active = 1
    GROUP BY s.id
    HAVING on_hand > 0`).all(workspaceId, workspaceId, workspaceId, workspaceId).map((row) => ({
    skuId: row.sku_id,
    code: row.code,
    displayName: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
    unitLabel: row.unit_label,
    onHand: Number(row.on_hand),
    costMinor: Number(row.cost_minor),
    lastSoldAt: row.last_sold_at,
    firstSeenAt: row.first_seen_at,
    daysSinceSold: row.last_sold_at ? round((now - Date.parse(row.last_sold_at)) / DAY_MS) : null,
    daysHeld: row.first_seen_at ? round((now - Date.parse(row.first_seen_at)) / DAY_MS) : null,
  }));
}

/**
 * Classifies everything held and totals the money involved.
 *
 * @param options.forecastFor  injectable so a caller that has already produced
 *        forecasts does not pay for them twice. Defaults to producing its own.
 */
function review(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const currency = options.currency || 'USD';
  const thresholds = { ...THRESHOLDS, ...(options.thresholds || {}) };
  const maxDaysGoal = options.goals && options.goals.maxDaysOfSupply
    ? Number(options.goals.maxDaysOfSupply) : null;
  // An owner's own ceiling beats the generic one. If they said sixty days,
  // reporting against a hundred and twenty is reporting against nobody's rule.
  const overstockDays = maxDaysGoal !== null ? maxDaysGoal : thresholds.overstockDays;

  const forecastFor = options.forecastFor
    || ((skuId) => forecastEngine.forSku(db, workspaceId, skuId, { now, horizonDays: 30 }));

  const rows = [];
  for (const item of positions(db, workspaceId, { now })) {
    if (item.onHand < thresholds.minimumUnits && item.costMinor < thresholds.minimumValueMinor) continue;

    const forecast = forecastFor(item.skuId);
    const dailyRate = forecast && forecast.dailyRate !== null ? Number(forecast.dailyRate) : null;
    const daysOfSupply = dailyRate && dailyRate > 0 ? round(item.onHand / dailyRate) : null;

    const classified = classify({ item, dailyRate, daysOfSupply, overstockDays, thresholds });
    if (!classified) continue;

    const excessUnits = classified.kind === 'overstock' && dailyRate > 0
      ? Math.max(0, Math.round(item.onHand - dailyRate * overstockDays)) : item.onHand;
    const unitCostMinor = item.onHand > 0 ? Math.round(item.costMinor / item.onHand) : 0;

    rows.push({
      ...item,
      ...classified,
      forecast: forecast ? {
        dailyRate, confidence: forecast.confidence, confidenceLabel: forecast.confidenceLabel,
      } : null,
      daysOfSupply,
      excessUnits,
      excessValueMinor: excessUnits * unitCostMinor,
      currency,
    });
  }

  rows.sort((a, b) => b.excessValueMinor - a.excessValueMinor);

  const totals = {
    overstockValueMinor: sum(rows, 'overstock', 'excessValueMinor'),
    slowValueMinor: sum(rows, 'slow', 'excessValueMinor'),
    deadValueMinor: sum(rows, 'dead', 'excessValueMinor'),
    overstockUnits: sum(rows, 'overstock', 'excessUnits'),
    slowUnits: sum(rows, 'slow', 'excessUnits'),
    deadUnits: sum(rows, 'dead', 'excessUnits'),
  };
  totals.tiedUpMinor = totals.overstockValueMinor + totals.slowValueMinor + totals.deadValueMinor;
  /*
   * Stock whose purchase cost was never recorded. The units are still excess
   * and still worth saying; quoting $0.00 for them would be worse than saying
   * nothing, because it reads as "this is costing you nothing".
   */
  totals.uncostedRows = rows.filter((row) => row.costMinor <= 0).length;

  return {
    rows,
    totals,
    currency,
    overstockDays,
    fromOwnerGoal: maxDaysGoal !== null,
    headline: headline(rows, totals, { currency, overstockDays, fromOwnerGoal: maxDaysGoal !== null }),
  };
}

function sum(rows, kind, field) {
  return rows.filter((row) => row.kind === kind).reduce((total, row) => total + Number(row[field] || 0), 0);
}

function classify({ item, dailyRate, daysOfSupply, overstockDays, thresholds }) {
  /*
   * Never sold, and held long enough that this is a fact rather than a new
   * arrival. Checked first: a product with no sales has no days-of-supply, and
   * calling it "slow" would understate a line that has never worked at all.
   */
  if (!item.lastSoldAt) {
    if ((item.daysHeld || 0) >= thresholds.deadDays) {
      return {
        kind: 'dead',
        label: 'Never sold',
        because: `Held for ${Math.round(item.daysHeld)} days and never sold a single unit.`,
        recommendation: 'Decide what this stock is for: return it, use it, or write it off. '
          + 'Nothing about it suggests customers want it.',
      };
    }
    return null;                       // too new to judge
  }

  if (item.daysSinceSold >= thresholds.deadDays) {
    return {
      kind: 'dead',
      label: 'Not sold in a long time',
      because: `Last sold ${Math.round(item.daysSinceSold)} days ago.`,
      recommendation: 'Stop reordering this and decide whether to keep carrying it at all.',
    };
  }

  if (daysOfSupply !== null && daysOfSupply > overstockDays) {
    return {
      kind: 'overstock',
      label: 'Far more than needed',
      because: `${item.onHand} in stock against about ${dailyRate} a day is roughly `
        + `${Math.round(daysOfSupply)} days of supply.`,
      recommendation: 'Stop ordering this line, lower its replenishment target, and move some of it '
        + 'to wherever it is actually selling.',
    };
  }

  if (item.daysSinceSold >= thresholds.slowDays) {
    return {
      kind: 'slow',
      label: 'Barely moving',
      because: `Nothing has sold in ${Math.round(item.daysSinceSold)} days.`,
      recommendation: 'Check whether this is still wanted before buying any more of it.',
    };
  }

  return null;
}

function headline(rows, totals, { currency, overstockDays, fromOwnerGoal }) {
  if (!rows.length) return 'No stock is sitting longer than it should.';

  /*
   * Money where the cost is known, units where it is not. An earlier version
   * only ever spoke in money, so a workspace whose purchase costs had not been
   * recorded got a headline reading "." — technically the sum of nothing, and
   * useless to somebody with three hundred surplus units on a shelf.
   */
  const describe = (kind, valueMinor, unitCount, tail) => {
    const count = rows.filter((row) => row.kind === kind).length;
    if (!count) return null;
    const noun = `${count} product${count === 1 ? '' : 's'}`;
    const amount = valueMinor > 0
      ? `${money(valueMinor, currency)} is tied up in ${noun}`
      : `${unitCount} units across ${noun} (their purchase cost is not recorded, so Foundry will not put a figure on it)`;
    return `${amount} ${tail}`;
  };

  const parts = [
    describe('overstock', totals.overstockValueMinor, totals.overstockUnits,
      `carrying more than ${overstockDays} days of supply`
      + (fromOwnerGoal ? ', the limit you asked Foundry to hold to' : '')),
    describe('dead', totals.deadValueMinor, totals.deadUnits, 'that has not sold at all'),
    describe('slow', totals.slowValueMinor, totals.slowUnits, 'barely moving'),
  ].filter(Boolean);

  return `${parts.join(', and ')}.`;
}

module.exports = { review, positions, classify, THRESHOLDS };
