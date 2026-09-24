'use strict';

/**
 * The candidate ways of turning yesterday into tomorrow.
 *
 * Four of them, all arithmetic, all small enough to print in the explanation
 * that goes to the owner. There is no machine learning here and that is a
 * decision rather than an omission: a purchase order is somebody's money, and
 * "the model said 183.2" is not a reason anyone can argue with. Every model
 * below can be written on the back of the recommendation it produces.
 *
 * The moving average is the baseline, and it is the one to beat. Most demand
 * in most small businesses is close to flat plus noise, and the great majority
 * of forecasting disappointments come from fitting the noise — a trend model
 * shown three good weeks will happily promise a fourth. So the elaborate models
 * are permitted to win only by measurement, never by sophistication, and the
 * comparison lives in backtest.js.
 *
 * Each model is `{ id, label, needs, fit(days) -> { dailyRateFor(date), rate } }`.
 * A model that cannot be supported by the days it is given returns null from
 * fit, which takes it out of the running without any special case elsewhere.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const round = (value, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const usable = (days) => days.filter((day) => !day.censored);
const valueOf = (day) => Number(day.baselineDemand ?? day.demand ?? 0);

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, n) => sum + (n - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** A flat rate, wrapped so every model answers the same question. */
const flat = (rate) => ({ rate: round(rate), dailyRateFor: () => Math.max(0, round(rate)) });

/**
 * Mean of the last `window` days that could actually sell.
 *
 * The baseline, and deliberately the dullest thing in the file.
 */
function movingAverage(window) {
  return {
    id: `moving_average_${window}`,
    label: `Average of the last ${window} trading days`,
    needs: Math.min(7, window),
    fit(days) {
      const rows = usable(days).slice(-window);
      if (rows.length < this.needs) return null;
      return { ...flat(mean(rows.map(valueOf))), window: rows.length };
    },
  };
}

/**
 * A straight line through recent demand, damped so it cannot run away.
 *
 * Damping is the whole safety argument. An undamped trend extrapolated over a
 * three-week lead time turns a mild uptick into an order nobody would sign; the
 * factor pulls each successive day back toward the current level, so the model
 * can say "rising" without saying "rising forever".
 */
function dampedTrend({ damping = 0.85, window = 56 } = {}) {
  return {
    id: 'damped_trend',
    label: 'Recent level plus a damped trend',
    needs: 21,
    fit(days) {
      const rows = usable(days).slice(-window);
      if (rows.length < this.needs) return null;
      const values = rows.map(valueOf);
      const n = values.length;
      const xs = values.map((_, index) => index);
      const xBar = mean(xs);
      const yBar = mean(values);
      const denominator = xs.reduce((sum, x) => sum + (x - xBar) ** 2, 0);
      if (denominator === 0) return null;
      const slope = xs.reduce((sum, x, i) => sum + (x - xBar) * (values[i] - yBar), 0) / denominator;
      const level = yBar + slope * (n - 1 - xBar);      // the line at "today"
      const lastDate = rows[rows.length - 1].date;
      const lastMs = Date.parse(`${lastDate}T00:00:00.000Z`);
      return {
        rate: round(Math.max(0, level)),
        slope: round(slope),
        dailyRateFor(date) {
          const ahead = Math.max(0, Math.round((Date.parse(`${date}T00:00:00.000Z`) - lastMs) / DAY_MS));
          // Geometric damping: each day ahead contributes less of the slope
          // than the one before, so the sum converges instead of diverging.
          const damped = ahead === 0 ? 0
            : slope * damping * (1 - damping ** ahead) / (1 - damping);
          return Math.max(0, round(level + damped));
        },
      };
    },
  };
}

/**
 * Day-of-week shape, and only when the data insists on it.
 *
 * Nearly every retail series looks seasonal to the eye, and most of that is
 * noise. The gate is a variance-ratio test in plain arithmetic: the spread
 * between weekday averages has to be large relative to the spread within each
 * weekday before StockChief will believe Saturdays are different from Tuesdays.
 * Without the gate this model wins the backtest occasionally and by luck, and
 * then confidently orders for a Saturday that never comes.
 */
function weekdaySeasonal({ minimumPerWeekday = 3, minimumRatio = 1.6 } = {}) {
  return {
    id: 'weekday_seasonal',
    label: 'Day-of-week pattern',
    needs: 28,
    fit(days) {
      const rows = usable(days);
      if (rows.length < this.needs) return null;

      const buckets = Array.from({ length: 7 }, () => []);
      for (const day of rows) buckets[new Date(`${day.date}T00:00:00.000Z`).getUTCDay()].push(valueOf(day));
      if (buckets.some((bucket) => bucket.length < minimumPerWeekday)) return null;

      const overall = mean(rows.map(valueOf));
      if (overall <= 0) return null;

      const weekdayMeans = buckets.map(mean);
      const between = stdev(weekdayMeans);
      const within = mean(buckets.map((bucket) => stdev(bucket)));
      // Not a real F-test, and not presented as one. It is a ratio with a
      // threshold, which is all the evidence a series this short can carry.
      if (!(between > 0) || (within > 0 && between / within < minimumRatio)) return null;

      const factors = weekdayMeans.map((value) => (overall > 0 ? value / overall : 1));
      return {
        rate: round(overall),
        factors: factors.map((f) => round(f, 3)),
        dailyRateFor(date) {
          const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
          return Math.max(0, round(overall * factors[weekday]));
        },
      };
    },
  };
}

/** The baseline every other model has to beat, named once so nothing drifts. */
const BASELINE_ID = 'moving_average_28';

const ALL = [
  movingAverage(28),
  movingAverage(7),
  dampedTrend(),
  weekdaySeasonal(),
];

const byId = (id) => ALL.find((model) => model.id === id) || null;

module.exports = { ALL, BASELINE_ID, byId, movingAverage, dampedTrend, weekdaySeasonal, mean, stdev, usable, valueOf };
