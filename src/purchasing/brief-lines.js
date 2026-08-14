'use strict';

/**
 * The purchasing sentences in the daily brief.
 *
 * The brief's job is to be read in ten seconds, so purchasing gets at most a
 * few lines and only when there is something to act on. Everything here is
 * counted from real records: how many lines the replenishment engine would
 * recommend buying, what is due to arrive, and what has not turned up.
 *
 * Deliberately not included: anything about money, suppliers' behaviour, or
 * what "should" have happened. The brief points at work, it does not editorialise.
 */

const replenishment = require('./replenishment');
const position = require('./position');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

/**
 * @returns {{lines: string[], counts, recommendations}} lines already ordered by
 *          how much they matter, so a caller can take the first two.
 */
function purchasingBrief(db, workspaceId, { now = Date.now(), maxLines = 3 } = {}) {
  let plan = { recommendations: [], bySupplier: [] };
  let late = [];
  let arriving = [];
  try {
    plan = replenishment.evaluateWorkspace(db, workspaceId, { now });
    late = position.lateOrders(db, workspaceId, { now });
    arriving = position.arrivingSoon(db, workspaceId, { days: 3, now });
  } catch {
    // A brief that fails because purchasing failed would take the whole morning
    // summary down with it. Purchasing is additive here, never load-bearing.
    return { lines: [], counts: { recommended: 0, late: 0, arriving: 0 }, recommendations: [] };
  }

  const today = new Date(now).toISOString().slice(0, 10);
  const dueToday = arriving.filter((po) => po.expected_date === today);

  const lines = [];

  if (plan.recommendations.length) {
    const suppliers = plan.bySupplier.length;
    lines.push(
      `${plural(plan.recommendations.length, 'item')} ${plan.recommendations.length === 1 ? 'needs' : 'need'} replenishment` +
        (suppliers > 1 ? ` across ${plural(suppliers, 'supplier')}.` : '.')
    );
  }

  if (late.length) {
    const worst = late.slice().sort((a, b) => b.daysLate - a.daysLate)[0];
    lines.push(
      late.length === 1
        ? `${worst.po_number} is ${plural(worst.daysLate, 'day')} past its expected arrival.`
        : `${plural(late.length, 'purchase order')} are past their expected arrival, the longest ${worst.po_number} by ${plural(worst.daysLate, 'day')}.`
    );
  }

  if (dueToday.length) {
    lines.push(
      dueToday.length === 1
        ? `${dueToday[0].po_number} from ${dueToday[0].supplier_name} is expected today.`
        : `${plural(dueToday.length, 'purchase order')} are expected today.`
    );
  }

  return {
    lines: lines.slice(0, maxLines),
    counts: {
      recommended: plan.recommendations.length,
      late: late.length,
      arriving: arriving.length,
      dueToday: dueToday.length,
    },
    recommendations: plan.recommendations,
    bySupplier: plan.bySupplier,
  };
}

module.exports = { purchasingBrief, plural };
