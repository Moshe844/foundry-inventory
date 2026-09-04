'use strict';

/**
 * What was actually wanted, day by day — which is not the same as what sold.
 *
 * Every forecast in Foundry reads its history from here, and the whole point of
 * this module is the difference between those two sentences. A movement log
 * says what left the building. Demand is what customers asked for, and the two
 * come apart in four ways that quietly ruin a forecast if nobody separates them:
 *
 *   the shelf was empty        zero sales on a day with no stock is not zero
 *                              demand, it is a lost sale wearing a disguise
 *   one enormous order         a single 500-unit contract is not evidence that
 *                              next Tuesday looks different
 *   goods came back            a return is a sale that unhappened
 *   stock moved, not sold      a transfer between our own locations depletes a
 *                              shelf without anybody wanting anything
 *
 * Only the first is subtle enough to be worth a warning. A product that ran out
 * on the 3rd and was restocked on the 11th will, to a naive average, look like
 * it stopped selling — so Foundry will forecast less, order less, and run out
 * sooner. Each round is worse than the last, and every number involved is
 * correct. This is the failure that makes forecasting systems untrustworthy,
 * and it is invisible unless the availability of the product is reconstructed
 * alongside its sales.
 *
 * So the series produced here carries, for every day: what was wanted, whether
 * it could have been bought, and whether anything about that day was
 * exceptional. What a model may learn from is a strict subset of what happened,
 * and the days that were excluded stay in the output so the exclusion can be
 * argued with rather than trusted.
 *
 * Deterministic throughout. No model is consulted here and none may be: this is
 * the evidence, and evidence that was itself inferred is not evidence.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Issues that represent somebody wanting the product. */
const DEMAND_REASONS = new Set(['sold', 'used']);

/*
 * A day's demand is called exceptional when one order accounts for a
 * disproportionate share of it. Two conditions, both required, because either
 * on its own is wrong: a multiple alone flags an ordinary day in a low-volume
 * product, and a floor alone flags steady demand in a high-volume one.
 */
const EXCEPTIONAL = {
  // How many times the typical day one order has to be before it stops being
  // evidence about typical days.
  multipleOfTypicalDay: 5,
  // And never fewer than this many units, so a product that normally sells one
  // a day does not call a delivery of six an anomaly.
  minimumUnits: 12,
};

const iso = (ms) => new Date(ms).toISOString();
const dayOf = (isoString) => String(isoString).slice(0, 10);
const dayStartMs = (date) => Date.parse(`${date}T00:00:00.000Z`);
const round = (value, places = 3) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function addDays(date, count) {
  return new Date(dayStartMs(date) + count * DAY_MS).toISOString().slice(0, 10);
}

/** Every date from `from` to `to` inclusive, so gaps in the log become zeroes. */
function calendar(from, to) {
  const out = [];
  for (let ms = dayStartMs(from); ms <= dayStartMs(to); ms += DAY_MS) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Raw movements for one product, oldest first.
 *
 * `balance_after` is read rather than recomputed. The engine wrote it at the
 * time from the state it actually had, and a replay that disagrees with it
 * would be a second opinion about the past.
 */
function movementsFor(db, workspaceId, skuId, { locationId = null, throughIso = null } = {}) {
  const clauses = ['workspace_id = ?', 'sku_id = ?'];
  const params = [workspaceId, skuId];
  if (locationId) { clauses.push('location_id = ?'); params.push(locationId); }
  if (throughIso) { clauses.push('occurred_at <= ?'); params.push(throughIso); }
  return db.prepare(`SELECT seq, operation, leg, reason_code, notes, reference,
      location_id, quantity_delta, balance_after, occurred_at
    FROM movements WHERE ${clauses.join(' AND ')} ORDER BY seq`).all(...params);
}

/**
 * Builds the daily series.
 *
 * `asOf` exists for backtesting: ask for the series as it stood a month ago and
 * nothing below this line can see a day that had not happened yet. A backtest
 * that can see the future is a demonstration, not a test.
 */
function series(db, workspaceId, skuId, options = {}) {
  const now = options.now || Date.now();
  const asOf = options.asOf || dayOf(iso(now));
  const windowDays = Number(options.windowDays || 180);
  const locationId = options.locationId || null;
  const throughIso = `${asOf}T23:59:59.999Z`;

  const rows = movementsFor(db, workspaceId, skuId, { locationId, throughIso });
  if (!rows.length) {
    return {
      skuId, locationId, asOf, from: asOf, to: asOf, days: [],
      totals: emptyTotals(), evidence: { firstMovementAt: null, movementCount: 0 },
    };
  }

  const firstDay = dayOf(rows[0].occurred_at);
  const earliestWanted = addDays(asOf, -(windowDays - 1));
  const from = firstDay > earliestWanted ? firstDay : earliestWanted;

  /*
   * Walk the whole log, not just the window. Availability on the first day of
   * the window is decided by movements that happened before it, and a product
   * that was already out of stock when the window opened must not be read as
   * having been available.
   */
  const balances = new Map();               // locationId -> on hand
  const perDay = new Map();                 // date -> accumulating record
  const openingBalance = new Map();         // date -> on hand at the start

  const blank = (date) => ({
    date,
    demand: 0,               // units customers took, net of returns
    grossDemand: 0,          // before returns
    returned: 0,             // units that came back
    returnsByReference: new Map(),
    netted: 0,               // returns taken off this day's demand
    exceptional: 0,          // units on this day judged one-off
    received: 0,             // units that arrived
    orders: new Map(),       // reference -> units, for tracing a spike to an order
    onHandStart: 0,
    onHandEnd: 0,
    censored: false,
  });

  for (const row of rows) {
    const date = dayOf(row.occurred_at);
    if (!perDay.has(date)) {
      // Snapshot the position before anything on this day is applied.
      const opening = [...balances.values()].reduce((sum, n) => sum + n, 0);
      openingBalance.set(date, opening);
      const record = blank(date);
      record.onHandStart = opening;
      perDay.set(date, record);
    }
    const day = perDay.get(date);
    const delta = Number(row.quantity_delta);

    balances.set(row.location_id, Number(row.balance_after));

    if (row.operation === 'issue' && DEMAND_REASONS.has(row.reason_code || '')) {
      const units = Math.abs(delta);
      day.grossDemand += units;
      const reference = row.reference || `movement:${row.seq}`;
      day.orders.set(reference, (day.orders.get(reference) || 0) + units);
    } else if (row.operation === 'receive') {
      day.received += delta;
      /*
       * Stock arriving back against a sales order is a return, not a purchase.
       * It has to reduce the demand it originally created, or a product that
       * was bought and sent back reads as twice as popular as one that was
       * simply bought.
       */
      if (isSalesReference(db, workspaceId, row.reference)) {
        day.returned += delta;
        day.returnsByReference.set(row.reference, (day.returnsByReference.get(row.reference) || 0) + delta);
      }
    }
    // Transfers and adjustments deliberately fall through: neither is demand.

    day.onHandEnd = [...balances.values()].reduce((sum, n) => sum + n, 0);
  }

  /*
   * Fill the calendar. A day with no movements is a real day with zero demand,
   * and it inherits the position left by the last day that had any.
   */
  const dates = calendar(from, asOf);
  const days = [];
  let carried = startingPosition(rows, from);

  for (const date of dates) {
    const record = perDay.get(date) || blank(date);
    if (!perDay.has(date)) { record.onHandStart = carried; record.onHandEnd = carried; }
    carried = record.onHandEnd;
    record.demand = record.grossDemand;
    /*
     * Could this day have sold anything? Nothing on the shelf at the start and
     * nothing delivered during it means the answer is no, and the zero on this
     * day says nothing whatever about demand.
     */
    record.censored = record.onHandStart <= 0 && record.received <= 0 && record.grossDemand <= 0;
    days.push(record);
  }

  applyReturns(days);
  markExceptional(days);

  return {
    skuId, locationId, asOf, from, to: asOf,
    days: days.map(present),
    totals: totalsFor(days),
    evidence: {
      firstMovementAt: rows[0].occurred_at,
      lastMovementAt: rows[rows.length - 1].occurred_at,
      movementCount: rows.length,
    },
  };
}

/** On-hand immediately before the window opens. */
function startingPosition(rows, from) {
  const balances = new Map();
  for (const row of rows) {
    if (dayOf(row.occurred_at) >= from) break;
    balances.set(row.location_id, Number(row.balance_after));
  }
  return [...balances.values()].reduce((sum, n) => sum + n, 0);
}

/*
 * Sales-order references look like "SO-1001". Checked against the table rather
 * than the shape of the string, because a supplier reference that happens to
 * look like one would otherwise silently become a customer return.
 */
const salesReferenceCache = new WeakMap();
function isSalesReference(db, workspaceId, reference) {
  if (!reference) return false;
  let byWorkspace = salesReferenceCache.get(db);
  if (!byWorkspace) { byWorkspace = new Map(); salesReferenceCache.set(db, byWorkspace); }
  const key = `${workspaceId}:${reference}`;
  if (byWorkspace.has(key)) return byWorkspace.get(key);
  const found = Boolean(db.prepare(`SELECT 1 FROM sales_orders
    WHERE workspace_id = ? AND order_number = ? LIMIT 1`).get(workspaceId, reference));
  byWorkspace.set(key, found);
  return found;
}

/**
 * Takes returned goods off the demand they reverse.
 *
 * A return arrives days or weeks after the sale, and the naive thing — subtract
 * it from the day it arrived — quietly destroys information: forty units coming
 * back on a day that sold five leaves thirty-five units of returned stock
 * unaccounted for, and the product reads as more popular than it is.
 *
 * So a return is walked backwards to the sale it undoes. The order reference is
 * the strong link and is tried first; anything left over comes off the most
 * recent days that sold anything, because that is where it most likely came
 * from. Returns that cannot be attributed at all are left visible in the
 * totals rather than silently dropped.
 */
function applyReturns(days) {
  const takeFrom = (day, units) => {
    const available = Math.max(0, day.demand);
    const taken = Math.min(available, units);
    day.demand -= taken;
    day.netted += taken;
    return taken;
  };

  for (let index = 0; index < days.length; index += 1) {
    const returnDay = days[index];
    if (returnDay.returned <= 0) continue;

    for (const [reference, units] of returnDay.returnsByReference) {
      let remaining = units;

      // The sale this return actually reverses.
      for (let back = index; back >= 0 && remaining > 0; back -= 1) {
        if (!days[back].orders.has(reference)) continue;
        remaining -= takeFrom(days[back], remaining);
      }

      // Whatever is left: the nearest days that sold anything.
      for (let back = index; back >= 0 && remaining > 0; back -= 1) {
        remaining -= takeFrom(days[back], remaining);
      }
    }
  }
}

/**
 * Flags the days one order made unrepresentative.
 *
 * The typical day is measured from days that sold something, so a product that
 * sells in bursts is not compared against the silence between bursts.
 */
function markExceptional(days) {
  const selling = days.filter((day) => day.demand > 0).map((day) => day.demand);
  if (selling.length < 4) return;              // too few days to call anything odd
  const typical = median(selling);
  if (typical <= 0) return;
  const threshold = Math.max(typical * EXCEPTIONAL.multipleOfTypicalDay, EXCEPTIONAL.minimumUnits);

  for (const day of days) {
    for (const [, units] of day.orders) {
      // One order, on its own, bigger than the bar. Not the day's total: two
      // ordinary orders landing together is a busy day, not an exceptional one.
      if (units >= threshold) day.exceptional += units;
    }
    if (day.exceptional > day.demand) day.exceptional = day.demand;
  }
}

function present(day) {
  return {
    date: day.date,
    demand: day.demand,
    grossDemand: day.grossDemand,
    returned: day.returned,
    exceptional: day.exceptional,
    // What a model is allowed to learn from: real demand, minus the one-offs.
    baselineDemand: Math.max(0, day.demand - day.exceptional),
    received: day.received,
    onHandStart: day.onHandStart,
    censored: day.censored,
    orders: [...day.orders].map(([reference, units]) => ({ reference, units })),
  };
}

function emptyTotals() {
  return {
    observedDays: 0, sellableDays: 0, censoredDays: 0, demandDays: 0,
    grossDemand: 0, returned: 0, netDemand: 0, exceptionalUnits: 0, baselineDemand: 0,
    censoredShare: 0,
  };
}

function totalsFor(days) {
  const sellable = days.filter((day) => !day.censored);
  const totals = {
    observedDays: days.length,
    sellableDays: sellable.length,
    censoredDays: days.length - sellable.length,
    demandDays: days.filter((day) => day.demand > 0).length,
    grossDemand: days.reduce((sum, day) => sum + day.grossDemand, 0),
    returned: days.reduce((sum, day) => sum + day.returned, 0),
    netDemand: days.reduce((sum, day) => sum + day.demand, 0),
    nettedOff: days.reduce((sum, day) => sum + day.netted, 0),
    exceptionalUnits: days.reduce((sum, day) => sum + day.exceptional, 0),
  };
  totals.baselineDemand = totals.netDemand - totals.exceptionalUnits;
  totals.censoredShare = days.length ? round(totals.censoredDays / days.length) : 0;
  return totals;
}

/**
 * The days a model may learn from, and the rate they imply.
 *
 * Censored days are dropped rather than zeroed. Dividing by the days a product
 * could actually be bought is the entire correction: eight days out of stock in
 * a thirty-day month means the rate is the month's sales over twenty-two days,
 * not over thirty.
 */
function learnable(history) {
  const days = history.days.filter((day) => !day.censored);
  const units = days.reduce((sum, day) => sum + day.baselineDemand, 0);
  return {
    days,
    dayCount: days.length,
    units,
    dailyRate: days.length ? round(units / days.length) : null,
    droppedForStockout: history.totals.censoredDays,
    droppedAsExceptional: history.totals.exceptionalUnits,
  };
}

/**
 * Demand nobody has to predict: what customers have already committed to.
 *
 * Cancelled orders are excluded at the query, and fulfilled quantities are
 * netted off — a line that has already shipped is in the movement history and
 * counting it here as well would demand the same units twice.
 */
function committedDemand(db, workspaceId, skuId, { locationId = null, throughDate = null } = {}) {
  const clauses = [`so.workspace_id = ?`, `sol.sku_id = ?`,
    `so.status NOT IN ('CANCELLED', 'DRAFT', 'COMPLETED')`];
  const params = [workspaceId, skuId];
  if (locationId) { clauses.push('so.fulfillment_location_id = ?'); params.push(locationId); }
  if (throughDate) { clauses.push('(so.needed_by IS NULL OR so.needed_by <= ?)'); params.push(throughDate); }

  const rows = db.prepare(`SELECT so.order_number, so.needed_by, so.status,
      sol.quantity_ordered - sol.quantity_fulfilled AS outstanding
    FROM sales_order_lines sol
    JOIN sales_orders so ON so.id = sol.sales_order_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY COALESCE(so.needed_by, '9999-12-31'), so.order_number`).all(...params)
    .filter((row) => Number(row.outstanding) > 0);

  return {
    units: rows.reduce((sum, row) => sum + Number(row.outstanding), 0),
    orders: rows.map((row) => ({
      orderNumber: row.order_number, neededBy: row.needed_by,
      status: row.status, units: Number(row.outstanding),
    })),
  };
}

module.exports = {
  series, learnable, committedDemand, calendar, addDays, median,
  DEMAND_REASONS, EXCEPTIONAL,
};
