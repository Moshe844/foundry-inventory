'use strict';

/**
 * Was Foundry right?
 *
 * A forecasting system that never checks itself is not a forecasting system,
 * it is a random number generator with a good vocabulary. Every stored
 * prediction names a horizon; once that horizon closes the real demand is
 * knowable, and this scores one against the other.
 *
 * The scoring is deliberately unflattering in two specific ways, because both
 * of the usual kindnesses are lies:
 *
 *   sign is kept    under-forecasting causes stockouts and over-forecasting
 *                   causes dead stock. A system that reports only absolute
 *                   error cannot tell an owner which of those it does to them,
 *                   and every forecaster leans one way.
 *
 *   stockouts are   a horizon spent out of stock cannot be marked. Demand had
 *   excluded        nowhere to happen, so the actual is not the truth — and
 *                   scoring against it would teach the forecaster that its
 *                   under-supply was accurate, which is the exact feedback loop
 *                   that turns one stockout into a permanent one.
 *
 * That second point is the whole reason this file exists rather than a query.
 * Marking a forecast against censored demand makes the model better at
 * predicting its own failures.
 */

const { newId, nowIso } = require('../lib/util');
const demandHistory = require('./demand-history');

const round = (value, places = 3) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** A horizon more than this share out of stock cannot be fairly marked. */
const MAX_CENSORED_SHARE = 0.4;

/**
 * Scores every stored forecast whose horizon has closed and which has not been
 * scored yet.
 *
 * Safe to run repeatedly; the unique key on (workspace, forecast) makes a
 * second pass a no-op rather than a second opinion.
 */
function scoreDue(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  const due = db.prepare(`SELECT f.* FROM demand_forecasts f
    WHERE f.workspace_id = ? AND f.horizon_end <= ?
      AND NOT EXISTS (SELECT 1 FROM forecast_outcomes o WHERE o.forecast_id = f.id)
    ORDER BY f.horizon_end LIMIT ?`).all(workspaceId, today, Number(options.limit || 200));

  const scored = [];
  for (const forecast of due) {
    const outcome = scoreOne(db, workspaceId, forecast, { now });
    if (outcome) scored.push(outcome);
  }
  return scored;
}

function scoreOne(db, workspaceId, forecast, { now = Date.now() } = {}) {
  const from = demandHistory.addDays(forecast.as_of, 1);
  const to = forecast.horizon_end;

  // The real series over exactly the days the forecast claimed to cover.
  const history = demandHistory.series(db, workspaceId, forecast.sku_id, {
    now, asOf: to, locationId: forecast.location_id || null,
    windowDays: Math.max(1, daysBetween(from, to) + 1),
  });
  const window = history.days.filter((day) => day.date >= from && day.date <= to);
  if (!window.length) return null;

  const censoredDays = window.filter((day) => day.censored).length;
  const comparable = censoredDays / window.length <= MAX_CENSORED_SHARE;

  const actual = window.reduce((sum, day) => sum + day.demand, 0);
  const predicted = forecast.horizon_units === null ? null : Number(forecast.horizon_units);
  const error = predicted === null ? null : round(predicted - actual);

  const id = newId('fo');
  db.prepare(`INSERT INTO forecast_outcomes
      (id, workspace_id, forecast_id, sku_id, scored_at, predicted_units, actual_units,
       error_units, absolute_error, censored_days, comparable, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, forecast.id, forecast.sku_id, nowIso(),
      predicted, actual, error, error === null ? null : Math.abs(error),
      censoredDays, comparable ? 1 : 0,
      comparable ? null
        : `Out of stock on ${censoredDays} of ${window.length} days, so the actual demand is not known.`,
      nowIso());

  return {
    forecastId: forecast.id, skuId: forecast.sku_id, from, to,
    predicted, actual, error, censoredDays, comparable,
  };
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`))
    / (24 * 60 * 60 * 1000));
}

/**
 * How Foundry's predictions have actually been doing.
 *
 * Reported as an accuracy record rather than a score out of ten. The lean is
 * the part worth reading: a forecaster that is consistently ten percent under
 * is not "90% accurate", it is quietly running the business short.
 */
function accuracy(db, workspaceId, { skuId = null, sinceDays = 180, now = Date.now() } = {}) {
  const since = new Date(now - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const clause = skuId ? ' AND o.sku_id = ?' : '';
  const params = skuId ? [workspaceId, since, skuId] : [workspaceId, since];

  const rows = db.prepare(`SELECT o.*, f.confidence, f.model_id, f.model_version
    FROM forecast_outcomes o
    JOIN demand_forecasts f ON f.id = o.forecast_id
    WHERE o.workspace_id = ? AND o.scored_at >= ? AND o.comparable = 1${clause}`).all(...params);

  if (!rows.length) {
    return { scored: 0, comparable: 0, summary: 'No forecast has reached the end of its horizon yet.' };
  }

  const withPrediction = rows.filter((row) => row.predicted_units !== null);
  const absolute = withPrediction.reduce((sum, row) => sum + Number(row.absolute_error), 0);
  const signed = withPrediction.reduce((sum, row) => sum + Number(row.error_units), 0);
  const actual = withPrediction.reduce((sum, row) => sum + Number(row.actual_units), 0);

  const meanAbsolute = withPrediction.length ? round(absolute / withPrediction.length, 2) : null;
  const bias = withPrediction.length ? round(signed / withPrediction.length, 2) : null;
  const relative = actual > 0 ? round(absolute / actual, 3) : null;

  const byConfidence = {};
  for (const row of withPrediction) {
    const bucket = byConfidence[row.confidence] || (byConfidence[row.confidence] = { n: 0, absolute: 0, actual: 0 });
    bucket.n += 1;
    bucket.absolute += Number(row.absolute_error);
    bucket.actual += Number(row.actual_units);
  }

  return {
    scored: rows.length,
    comparable: withPrediction.length,
    meanAbsoluteError: meanAbsolute,
    bias,
    relativeError: relative,
    byConfidence: Object.fromEntries(Object.entries(byConfidence).map(([key, value]) => [key, {
      forecasts: value.n,
      meanAbsoluteError: round(value.absolute / value.n, 2),
      relativeError: value.actual > 0 ? round(value.absolute / value.actual, 3) : null,
    }])),
    summary: summarise({ n: withPrediction.length, relative, bias }),
  };
}

function summarise({ n, relative, bias }) {
  if (!n) return 'No comparable forecast has closed yet.';
  const accuracyWords = relative === null ? 'not measurable'
    : `out by about ${Math.round(relative * 100)}% of the units that actually sold`;
  if (bias === null) return `Across ${n} closed forecasts, Foundry has been ${accuracyWords}.`;
  const lean = Math.abs(bias) < 0.5 ? 'with no consistent lean either way'
    : bias > 0 ? `and leaning high by about ${bias} units a forecast`
      : `and leaning low by about ${Math.abs(bias)} units a forecast, which is the direction that causes stockouts`;
  return `Across ${n} closed forecasts, Foundry has been ${accuracyWords}, ${lean}.`;
}

module.exports = { scoreDue, scoreOne, accuracy, MAX_CENSORED_SHARE };
