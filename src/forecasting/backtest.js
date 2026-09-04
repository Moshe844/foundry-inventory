'use strict';

/**
 * Would this have worked, on days we already know the answer to?
 *
 * A forecast that has never been wrong in public is not trustworthy, it is
 * untested. So before any model is allowed to influence an order, it is shown
 * only the history up to some earlier point, asked what happens next, and
 * marked against what actually did. Hold out the last thirty days, predict
 * them, compare.
 *
 * Two rules make this honest rather than decorative:
 *
 *   the model never sees the held-out days     not to fit, not to choose a
 *                                              window, not to normalise
 *   the baseline is scored the same way        a moving average sat the same
 *                                              exam, and beating it is the only
 *                                              definition of "better" here
 *
 * The second rule is the one with teeth. Elaborate models routinely lose to a
 * plain average on short, noisy, small-business series, and a system that
 * prefers the elaborate one because it is elaborate will order confidently and
 * wrongly. When nothing beats the baseline, the baseline wins and Foundry says
 * so — that is a successful backtest, not a failed one.
 *
 * Errors are reported in units per day, because that is the language of the
 * decision. Percentage errors are also carried, but never used for selection:
 * a percentage of a day that sold nothing is undefined or enormous, and a
 * model can win on percentages by being wrong in the right direction.
 */

const models = require('./models');

const round = (value, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** How much better than the baseline a model has to be before it is worth it. */
const IMPROVEMENT_MARGIN = 0.05;         // 5% lower error, or it is noise

/** Days held out by default. Enough to see a mistake, short enough to have. */
const DEFAULT_HOLDOUT = 30;

/**
 * Scores one model against held-out days.
 *
 * `train` and `test` are already split by the caller so that no model can
 * reach past the divide, whatever it does inside fit().
 */
function score(model, train, test) {
  const fitted = model.fit(train);
  if (!fitted) return { id: model.id, label: model.label, fitted: false, reason: 'not enough evidence' };

  const scored = test.filter((day) => !day.censored);
  if (!scored.length) return { id: model.id, label: model.label, fitted: false, reason: 'no comparable days' };

  let absolute = 0;
  let signed = 0;
  let actualTotal = 0;
  const points = [];
  for (const day of scored) {
    const actual = models.valueOf(day);
    const predicted = fitted.dailyRateFor(day.date);
    absolute += Math.abs(predicted - actual);
    signed += predicted - actual;
    actualTotal += actual;
    points.push({ date: day.date, actual, predicted: round(predicted, 2) });
  }

  const n = scored.length;
  return {
    id: model.id,
    label: model.label,
    fitted: true,
    days: n,
    // Mean absolute error, in units per day. The number that decides.
    mae: round(absolute / n),
    // Which way it leans. Persistent under-forecasting is what causes stockouts,
    // so the direction matters to a reader even though it never selects.
    bias: round(signed / n),
    actualPerDay: round(actualTotal / n),
    // Relative error, reported and never used for ranking. See the note above.
    relative: actualTotal > 0 ? round(absolute / actualTotal) : null,
    points,
  };
}

/**
 * Runs the whole comparison and names a winner.
 *
 * Returns the baseline's own score too, always, so the recommendation can say
 * what was given up by not using it.
 */
function evaluate(days, options = {}) {
  const holdout = Number(options.holdoutDays || DEFAULT_HOLDOUT);
  const candidates = options.models || models.ALL;
  const baselineId = options.baselineId || models.BASELINE_ID;

  const usable = days.filter((day) => !day.censored);
  const trainSize = days.length - holdout;

  /*
   * Not enough history to hold anything out. Say so rather than testing on the
   * days the model was fitted to, which always looks excellent and means
   * nothing.
   */
  if (trainSize < 14 || usable.length < 14) {
    return {
      ran: false,
      reason: 'not enough history to hold days back',
      holdoutDays: holdout,
      chosenId: baselineId,
      baselineId,
      results: [],
    };
  }

  const train = days.slice(0, trainSize);
  const test = days.slice(trainSize);
  const results = candidates.map((model) => score(model, train, test));

  const baseline = results.find((result) => result.id === baselineId);
  const ranked = results.filter((result) => result.fitted).sort((a, b) => a.mae - b.mae);

  if (!ranked.length) {
    return { ran: false, reason: 'no model could be fitted', holdoutDays: holdout,
      chosenId: baselineId, baselineId, results };
  }

  const best = ranked[0];
  /*
   * The fallback rule, stated once. If there is no baseline score to compare
   * against, or the winner is not clearly better than it, the baseline is used.
   * "Clearly" is the margin: a model that wins by one percent won by luck.
   */
  let chosenId = baselineId;
  let reason;
  if (!baseline || !baseline.fitted) {
    chosenId = best.id;
    reason = `The usual average could not be fitted on this history, so ${best.label.toLowerCase()} was used.`;
  } else if (best.id === baselineId) {
    reason = 'Nothing beat a plain average of recent trading days, so that is what is being used.';
  } else if (best.mae <= baseline.mae * (1 - IMPROVEMENT_MARGIN)) {
    chosenId = best.id;
    reason = `${best.label} was wrong by ${best.mae} a day against the average's ${baseline.mae}, `
      + 'tested on days it had never seen.';
  } else {
    reason = `${best.label} was not enough better than a plain average `
      + `(${best.mae} against ${baseline.mae} a day) to be worth the extra assumption.`;
  }

  return {
    ran: true,
    holdoutDays: test.length,
    trainDays: train.length,
    chosenId,
    baselineId,
    reason,
    best: best.id,
    baseline: baseline && baseline.fitted
      ? { id: baseline.id, mae: baseline.mae, bias: baseline.bias } : null,
    results: results.map(({ points, ...rest }) => rest),
    detail: results.find((result) => result.id === chosenId) || null,
  };
}

module.exports = { evaluate, score, IMPROVEMENT_MARGIN, DEFAULT_HOLDOUT };
