'use strict';

/**
 * How much of this will be wanted, how sure StockChief is, and why.
 *
 * The confidence is not decoration. A forecast without one is a number that
 * looks the same after five days of history as after five years, and an owner
 * reading it has no way to tell which they are holding. So every forecast that
 * leaves this module carries the evidence it was built from, and the three
 * honest answers are:
 *
 *   Still learning      there is not enough here; use commitments and rules
 *   Moderate confidence a usable estimate with real uncertainty around it
 *   High confidence     steady demand, plenty of days, tested against reality
 *
 * "Still learning" is a first-class result rather than a failure. A new product
 * has no demand history, and the correct thing to say about next month is that
 * nobody knows — the wrong thing is a number with two decimal places. StockChief
 * falls back to what it does know: what customers have actually committed to,
 * and what the owner configured.
 *
 * The separation the mission rests on is kept in the shape of the answer:
 *
 *   known      customers have ordered it; this is a fact, not a prediction
 *   forecast   inferred from history; this is a guess, and labelled one
 *
 * Nothing here writes anything. A forecast is an opinion about the future and
 * must never be able to damage the record of the past.
 */

const demandHistory = require('./demand-history');
const models = require('./models');
const backtest = require('./backtest');

/*
 * Stamped onto every stored forecast. When a recommendation is questioned six
 * months later, the version says which arithmetic produced it — otherwise the
 * only way to explain an old decision is to re-run today's code and hope.
 */
const FORECAST_VERSION = 'forecast-v2';

const CONFIDENCE = {
  LEARNING: 'learning',
  MODERATE: 'moderate',
  HIGH: 'high',
};

const CONFIDENCE_LABEL = {
  [CONFIDENCE.LEARNING]: 'Still learning',
  [CONFIDENCE.MODERATE]: 'Moderate confidence',
  [CONFIDENCE.HIGH]: 'High confidence',
};

/** What each level requires. Named so a customer can be shown the bar. */
const THRESHOLDS = {
  // Below this there is no forecast at all, only what has been committed.
  minimumSellableDays: 10,
  minimumDemandDays: 3,
  // Above these, the estimate stops being a shrug.
  confidentSellableDays: 42,
  confidentDemandDays: 12,
  // Demand that swings this much day to day cannot be called well understood,
  // however long it has been swinging.
  steadyVariation: 0.9,
  // Stock-outs hide demand. Past this share of the window, what is left is too
  // thin a slice of the truth to be confident about.
  toleratedCensoredShare: 0.35,
};

const round = (value, places = 3) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const step = (name, detail, value = null) => ({ step: name, detail, value });

/**
 * Chooses a confidence level and says, in words, what decided it.
 */
function judgeConfidence({ learn, history, variation, test }) {
  const reasons = [];

  if (learn.dayCount < THRESHOLDS.minimumSellableDays || history.totals.demandDays < THRESHOLDS.minimumDemandDays) {
    reasons.push(`only ${learn.dayCount} trading day${learn.dayCount === 1 ? '' : 's'} of history `
      + `with ${history.totals.demandDays} on which anything sold`);
    return { level: CONFIDENCE.LEARNING, reasons };
  }

  let level = CONFIDENCE.HIGH;
  if (learn.dayCount < THRESHOLDS.confidentSellableDays) {
    level = CONFIDENCE.MODERATE;
    reasons.push(`${learn.dayCount} trading days of history, which is a short record`);
  }
  if (history.totals.demandDays < THRESHOLDS.confidentDemandDays) {
    level = CONFIDENCE.MODERATE;
    reasons.push(`${history.totals.demandDays} days on which anything actually sold`);
  }
  if (variation !== null && variation > THRESHOLDS.steadyVariation) {
    level = CONFIDENCE.MODERATE;
    reasons.push('demand varies a lot from day to day');
  }
  if (history.totals.censoredShare > THRESHOLDS.toleratedCensoredShare) {
    level = CONFIDENCE.MODERATE;
    reasons.push(`out of stock on ${history.totals.censoredDays} of the days looked at, `
      + 'so some demand was never recorded');
  }
  /*
   * A model that could not be tested has not earned high confidence, whatever
   * the history looks like. Untested and correct is a coincidence until proven.
   */
  if (!test.ran) {
    level = level === CONFIDENCE.HIGH ? CONFIDENCE.MODERATE : level;
    reasons.push('not enough history to hold days back and check the method');
  }

  if (!reasons.length) reasons.push('a long, steady record that the method was tested against');
  return { level, reasons };
}

/**
 * The forecast for one product, optionally at one location.
 *
 * @param options.horizonDays how far ahead the caller needs to know about —
 *        normally a lead time, because that is the window a shortage hides in.
 * @param options.asOf       pretend today is this date; used by backtesting and
 *        by outcome scoring, and by nothing else.
 */
function forSku(db, workspaceId, skuId, options = {}) {
  const now = options.now || Date.now();
  const asOf = options.asOf || new Date(now).toISOString().slice(0, 10);
  const horizonDays = Math.max(1, Math.round(Number(options.horizonDays || 30)));
  const locationId = options.locationId || null;

  const history = options.history
    || demandHistory.series(db, workspaceId, skuId, { asOf, now, locationId, windowDays: options.windowDays || 180 });
  const learn = demandHistory.learnable(history);
  const committed = demandHistory.committedDemand(db, workspaceId, skuId, {
    locationId, throughDate: demandHistory.addDays(asOf, horizonDays),
  });

  const calculation = [];
  calculation.push(step('history',
    `${history.totals.observedDays} days looked at, from ${history.from} to ${history.to}.`,
    history.totals.observedDays));

  if (history.totals.censoredDays > 0) {
    calculation.push(step('stockouts',
      `${history.totals.censoredDays} of those days had nothing in stock, so they are not `
      + 'counted as days nobody wanted it.', history.totals.censoredDays));
  }
  if (history.totals.exceptionalUnits > 0) {
    calculation.push(step('one_offs',
      `${history.totals.exceptionalUnits} units came from unusually large single orders and are `
      + 'left out of the ongoing rate.', history.totals.exceptionalUnits));
  }
  if (history.totals.returned > 0) {
    calculation.push(step('returns',
      `${history.totals.returned} units came back and have been taken off demand.`,
      history.totals.returned));
  }

  // --- too little to work with -----------------------------------------------

  const values = learn.days.map(models.valueOf);
  const average = models.mean(values);
  const spread = models.stdev(values);
  const variation = average > 0 ? round(spread / average) : null;

  const test = backtest.evaluate(history.days, { holdoutDays: options.holdoutDays });
  const confidence = judgeConfidence({ learn, history, variation, test });

  if (confidence.level === CONFIDENCE.LEARNING) {
    calculation.push(step('verdict',
      'Not enough trading history to estimate a rate, so none is claimed.', null));
    return present({
      skuId, locationId, asOf, horizonDays, history, learn, committed, test,
      confidence, calculation, variation,
      model: null, dailyRate: null, horizonUnits: null,
    });
  }

  // --- pick the method, then use it ------------------------------------------

  const chosen = models.byId(test.chosenId) || models.byId(models.BASELINE_ID);
  const fitted = chosen.fit(history.days) || models.byId(models.BASELINE_ID).fit(history.days);

  if (!fitted) {
    calculation.push(step('verdict', 'No method could be fitted to this history.', null));
    return present({
      skuId, locationId, asOf, horizonDays, history, learn, committed, test,
      confidence: { level: CONFIDENCE.LEARNING, reasons: ['no method could be fitted'] },
      calculation, variation, model: null, dailyRate: null, horizonUnits: null,
    });
  }

  calculation.push(step('method', test.reason || `Using ${chosen.label.toLowerCase()}.`, null));

  /*
   * Sum the horizon day by day rather than multiplying a rate by a number of
   * days. For a flat model the two agree exactly; for a model with a shape —
   * a trend, a weekday pattern — only the sum is right, and having one code
   * path means the explanation always matches the arithmetic.
   */
  const horizonDates = demandHistory.calendar(
    demandHistory.addDays(asOf, 1), demandHistory.addDays(asOf, horizonDays));
  const horizonUnits = round(horizonDates.reduce((sum, date) => sum + fitted.dailyRateFor(date), 0), 2);
  const dailyRate = round(horizonUnits / horizonDays);

  calculation.push(step('rate',
    `About ${dailyRate} a day, which over the next ${horizonDays} days comes to `
    + `roughly ${Math.round(horizonUnits)}.`, dailyRate));

  if (committed.units > 0) {
    calculation.push(step('committed',
      `Separately, customers have already ordered ${committed.units} that have not shipped `
      + `(${committed.orders.map((order) => order.orderNumber).join(', ')}). That is known demand, not a forecast.`,
      committed.units));
  }

  return present({
    skuId, locationId, asOf, horizonDays, history, learn, committed, test,
    confidence, calculation, variation,
    model: { id: chosen.id, label: chosen.label, detail: fitted },
    dailyRate, horizonUnits,
  });
}

function present(input) {
  const { confidence, model, history, learn, committed, test } = input;
  return {
    version: FORECAST_VERSION,
    skuId: input.skuId,
    locationId: input.locationId,
    asOf: input.asOf,
    horizonDays: input.horizonDays,

    // The prediction. Null is a real answer and callers must handle it.
    dailyRate: input.dailyRate,
    horizonUnits: input.horizonUnits,

    // Known demand, kept apart from the prediction on purpose.
    committedUnits: committed.units,
    committedOrders: committed.orders,

    confidence: confidence.level,
    confidenceLabel: CONFIDENCE_LABEL[confidence.level],
    confidenceReasons: confidence.reasons,

    model: model ? { id: model.id, label: model.label } : null,
    modelDetail: model ? model.detail : null,

    evidence: {
      observedDays: history.totals.observedDays,
      sellableDays: learn.dayCount,
      demandDays: history.totals.demandDays,
      censoredDays: history.totals.censoredDays,
      censoredShare: history.totals.censoredShare,
      exceptionalUnits: history.totals.exceptionalUnits,
      returnedUnits: history.totals.returned,
      netDemand: history.totals.netDemand,
      baselineDemand: history.totals.baselineDemand,
      variation: input.variation,
      from: history.from,
      to: history.to,
    },

    backtest: test,
    calculation: input.calculation,
  };
}

/**
 * One line of plain English, for the places that have room for a sentence and
 * not a table. Deliberately refuses to state a rate it does not have.
 */
function summarise(forecast, displayName) {
  const name = displayName || 'This product';
  if (forecast.confidence === CONFIDENCE.LEARNING) {
    const known = forecast.committedUnits > 0
      ? ` Customers have ordered ${forecast.committedUnits} that have not shipped, and that is what StockChief is going on.`
      : '';
    return `${name} does not have enough trading history for StockChief to estimate demand yet.${known}`;
  }
  const hedge = forecast.confidence === CONFIDENCE.MODERATE ? 'roughly ' : 'about ';
  return `${name} is selling ${hedge}${forecast.dailyRate} a day, `
    + `so ${Math.round(forecast.horizonUnits)} over the next ${forecast.horizonDays} days.`;
}

module.exports = {
  forSku, summarise, FORECAST_VERSION, CONFIDENCE, CONFIDENCE_LABEL, THRESHOLDS,
};
