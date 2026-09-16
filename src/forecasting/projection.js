'use strict';

/**
 * When does this run out, and does anything arrive before it does?
 *
 * The question the whole mission exists to answer, and the reason it needs its
 * own module is that "days of cover" is not it. Dividing stock by a daily rate
 * gives a number that ignores the order landing on Thursday and the customer
 * commitment due on Friday, and those are precisely the two facts that decide
 * whether today is a problem.
 *
 * So this walks the calendar instead. One day at a time, from today to the
 * horizon: take out what is expected to sell, take out what has been promised
 * to a customer on the day it was promised, put in what is expected to arrive
 * on the day it is expected. The first day the running balance goes below zero
 * is the answer, and because it was reached by walking, the explanation is just
 * the walk.
 *
 * Two kinds of demand are subtracted and they are not the same kind of thing:
 *
 *   committed   a customer has ordered it; a shortfall here is a broken promise
 *   forecast    inferred from history; a shortfall here is a probably-lost sale
 *
 * They are tracked separately all the way through, because running out of stock
 * you had promised somebody is a different conversation from running out of
 * stock you merely expected to sell.
 */

const demandHistory = require('./demand-history');
const position = require('../purchasing/position');

const DAY_MS = 24 * 60 * 60 * 1000;

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const dayOf = (value) => String(value).slice(0, 10);

/**
 * Incoming stock, placed on the day it is actually expected.
 *
 * A purchase order with no expected date is not ignored — it is placed using
 * the supplier's planning lead time from when it was sent, and flagged as an
 * estimate. Dropping it would predict a stockout that the order in flight is
 * about to prevent; pretending it arrives today would predict safety that does
 * not exist.
 */
function incomingFor(db, workspaceId, skuId, { now = Date.now(), leadTimeDays = null } = {}) {
  const entry = position.onOrderForSku(db, workspaceId, skuId, { now });
  const today = dayOf(new Date(now).toISOString());

  const arrivals = [];
  for (const line of entry.lines || []) {
    let date = line.expectedDate ? dayOf(line.expectedDate) : null;
    let estimated = false;
    if (!date) {
      // No promised date. Use the supplier's own measured pace from today,
      // which is late but honest; the alternative is a date nobody stated.
      const days = leadTimeDays === null ? 14 : Math.max(0, Math.round(leadTimeDays));
      date = demandHistory.addDays(today, days);
      estimated = true;
    }
    // An order whose date has passed has not arrived. It arrives when it
    // arrives; putting it in the past would credit stock that is not here.
    if (date < today) { date = today; estimated = true; }
    arrivals.push({
      date, units: line.outstanding, poNumber: line.poNumber, poId: line.poId,
      supplierName: line.supplierName, estimated,
      overdue: Boolean(line.expectedDate && dayOf(line.expectedDate) < today),
    });
  }
  // Internal stock does not disappear while it is travelling. It is not
  // destination on-hand yet, but it is real future supply and must prevent a
  // forecast from ordering the same units again.
  let transferUnits = 0;
  const transferOrders = [];
  try {
    for (const transfer of require('../transfers/transfer-service').incomingForSku(db, workspaceId, skuId)) {
      let date = transfer.expectedDate ? dayOf(transfer.expectedDate) : today;
      let estimated = !transfer.expectedDate;
      if (date < today) { date = today; estimated = true; }
      transferUnits += Number(transfer.units);
      transferOrders.push(transfer);
      arrivals.push({ date, units: Number(transfer.units), transferNumber: transfer.transferNumber,
        transferId: transfer.transferId, supplierName: transfer.sourceName,
        source: 'INTERNAL_TRANSFER', estimated,
        overdue: Boolean(transfer.expectedDate && dayOf(transfer.expectedDate) < today) });
    }
  } catch (error) {
    // A database opened against a pre-Mission-6 schema during a migration
    // remains readable; ordinary runtime databases always have this table.
    if (!String(error.message || '').includes('no such table')) throw error;
  }
  arrivals.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { onOrder: Number(entry.onOrder || 0) + transferUnits, arrivals,
    orders: [...(entry.lines || []), ...transferOrders] };
}

/**
 * Customer promises, placed on the day they were promised for.
 *
 * A commitment with no date is treated as due immediately. That is the
 * conservative reading and the right one: somebody is waiting.
 */
function commitmentsFor(db, workspaceId, skuId, { now = Date.now(), locationId = null, horizonDays = 60 } = {}) {
  const today = dayOf(new Date(now).toISOString());
  const committed = demandHistory.committedDemand(db, workspaceId, skuId, { locationId });
  return committed.orders.map((order) => ({
    date: order.neededBy ? dayOf(order.neededBy) : today,
    units: order.units,
    orderNumber: order.orderNumber,
    dated: Boolean(order.neededBy),
  })).map((order) => (order.date < today ? { ...order, date: today, overdue: true } : order));
}

/**
 * Walks the calendar and reports the first day it breaks.
 *
 * @param options.forecast  a forecast from forecast.js; its dailyRateFor shape
 *        is not required, only `dailyRate` — a null rate means the walk runs on
 *        commitments alone, which is exactly right for a product with no
 *        history and a customer order against it.
 */
function project(db, workspaceId, skuId, options = {}) {
  const now = options.now || Date.now();
  const today = dayOf(new Date(now).toISOString());
  const horizonDays = Math.max(1, Math.round(Number(options.horizonDays || 60)));
  const locationId = options.locationId || null;

  const onHand = options.onHand !== undefined ? Number(options.onHand)
    : currentOnHand(db, workspaceId, skuId, locationId);
  const forecast = options.forecast || null;
  const dailyRate = forecast && forecast.dailyRate !== null ? Number(forecast.dailyRate) : null;

  const incoming = options.incoming
    || incomingFor(db, workspaceId, skuId, { now, leadTimeDays: options.leadTimeDays });
  const commitments = options.commitments
    || commitmentsFor(db, workspaceId, skuId, { now, locationId, horizonDays });

  const arrivalsByDate = new Map();
  for (const arrival of incoming.arrivals) {
    arrivalsByDate.set(arrival.date, (arrivalsByDate.get(arrival.date) || 0) + arrival.units);
  }
  const commitmentsByDate = new Map();
  for (const commitment of commitments) {
    commitmentsByDate.set(commitment.date, (commitmentsByDate.get(commitment.date) || 0) + commitment.units);
  }

  const dates = demandHistory.calendar(today, demandHistory.addDays(today, horizonDays));
  const days = [];
  let balance = onHand;
  let stockoutDate = null;
  let promiseMissedDate = null;
  let firstShortfallUnits = 0;

  for (const date of dates) {
    const arriving = arrivalsByDate.get(date) || 0;
    const promised = commitmentsByDate.get(date) || 0;
    // Forecast demand does not apply to today, which is already partly spent.
    const expected = date === today || dailyRate === null ? 0 : dailyRate;

    const opening = balance;
    balance = opening + arriving - promised - expected;

    if (promised > 0 && opening + arriving < promised && promiseMissedDate === null) {
      promiseMissedDate = date;
    }
    if (balance < 0 && stockoutDate === null) {
      stockoutDate = date;
      firstShortfallUnits = Math.ceil(Math.abs(balance));
    }

    days.push({
      date,
      opening: round(opening),
      arriving,
      promised,
      expected: round(expected),
      closing: round(balance),
    });
  }

  const daysUntilStockout = stockoutDate
    ? Math.round((Date.parse(`${stockoutDate}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / DAY_MS)
    : null;

  const nextArrival = incoming.arrivals.length ? incoming.arrivals[0] : null;
  const coveredByIncoming = Boolean(stockoutDate && nextArrival && nextArrival.date <= stockoutDate);
  const missedCommitment = promiseMissedDate
    ? commitments.find((row) => row.date === promiseMissedDate) || null
    : null;

  // A customer with no requested date is conservatively due now, so an order
  // arriving next week cannot make today's calendar projection non-negative.
  // It can still fully cover the waiting quantity. Keep that fact distinct
  // from `coveredByIncoming`: the customer is waiting, but the owner does not
  // need to buy the same stock a second time.
  const incomingCoversMissedCommitment = Boolean(
    missedCommitment && incoming.onOrder >= firstShortfallUnits
  );

  return {
    skuId,
    locationId,
    asOf: today,
    horizonDays,
    onHand,
    onOrder: incoming.onOrder,
    committedUnits: commitments.reduce((sum, row) => sum + row.units, 0),
    dailyRate,
    confidence: forecast ? forecast.confidence : null,

    stockoutDate,
    daysUntilStockout,
    shortfallUnits: firstShortfallUnits,
    promiseMissedDate,
    missedCommitment,
    nextArrival,
    coveredByIncoming,
    incomingCoversMissedCommitment,

    days,
    arrivals: incoming.arrivals,
    commitments,
    explanation: explain({
      today, onHand, dailyRate, stockoutDate, daysUntilStockout, nextArrival,
      promiseMissedDate, forecast, committed: commitments,
    }),
  };
}

function currentOnHand(db, workspaceId, skuId, locationId) {
  const row = locationId
    ? db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
      .get(workspaceId, skuId, locationId)
    : db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?')
      .get(workspaceId, skuId);
  return Number(row.n || 0);
}

/**
 * The sentence. Written to be read by somebody who is busy.
 */
function explain({ onHand, dailyRate, stockoutDate, daysUntilStockout, nextArrival, promiseMissedDate, forecast, committed }) {
  if (promiseMissedDate) {
    const order = committed.find((row) => row.date === promiseMissedDate);
    return `There is not enough stock to cover ${order ? order.orderNumber : 'a customer order'} on `
      + `${promiseMissedDate}. That is a promise already made, not a forecast.`;
  }
  if (!stockoutDate) {
    if (dailyRate === null) {
      return `${onHand} in stock. StockChief cannot say how fast this sells yet, so it is not predicting a run-out date.`;
    }
    return `${onHand} in stock, selling about ${dailyRate} a day. Nothing runs out inside the period looked at.`;
  }
  const hedge = forecast && forecast.confidence === 'moderate' ? 'roughly ' : '';
  const base = `${onHand} available and selling ${hedge}${dailyRate} a day, so this is likely to run out `
    + `in about ${daysUntilStockout} day${daysUntilStockout === 1 ? '' : 's'}, around ${stockoutDate}`;
  if (!nextArrival) return `${base}, and nothing is on order.`;
  if (nextArrival.date <= stockoutDate) {
    return `${base} — but ${nextArrival.units} arrive on ${nextArrival.date} from `
      + `${nextArrival.supplierName || 'the supplier'}, which covers it.`;
  }
  return `${base}, and the next delivery (${nextArrival.units} on ${nextArrival.date}) is too late.`;
}

module.exports = { project, incomingFor, commitmentsFor, currentOnHand };
