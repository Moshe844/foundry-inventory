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

const weekdayOf = (date) => new Date(`${date}T00:00:00.000Z`).getUTCDay();
const monthOf = (date) => Number(String(date).slice(5, 7)) - 1;

/**
 * Every fitted model also carries a plain `shape`: the few numbers it needs to
 * answer any later date. Stored once, the same shape gives the same forecast
 * again, which is what lets a saved forecast drive planning reproducibly.
 */
function rateFor(shape, date) {
  if (!shape) return 0;
  switch (shape.kind) {
    case 'flat': return Math.max(0, round(shape.rate));
    case 'trend': {
      const ahead = Math.max(0, Math.round((Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${shape.last}T00:00:00.000Z`)) / DAY_MS));
      const damped = ahead === 0 ? 0 : shape.slope * shape.damping * (1 - shape.damping ** ahead) / (1 - shape.damping);
      return Math.max(0, round(shape.level + damped));
    }
    case 'weekday': return Math.max(0, round(shape.rate * shape.factors[weekdayOf(date)]));
    case 'seasonal': return Math.max(0, round(shape.level * shape.month[monthOf(date)] * shape.weekday[weekdayOf(date)]));
    // Another item's shape at a different level: a new product forecast from
    // a similar item, or a recent trend, keeps that item's seasons.
    case 'scaled': return Math.max(0, round(shape.factor * rateFor(shape.shape, date)));
    default: throw new TypeError(`Unknown forecast shape: ${shape.kind}`);
  }
}

/** A flat rate, wrapped so every model answers the same question. */
const flat = (rate) => {
  const shape = { kind: 'flat', rate: round(rate) };
  return { rate: round(rate), shape, dailyRateFor: (date) => rateFor(shape, date) };
};

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
      // Geometric damping: each day ahead contributes less of the slope
      // than the one before, so the sum converges instead of diverging.
      const shape = { kind: 'trend', level, slope, damping, last: lastDate };
      return {
        rate: round(Math.max(0, level)),
        slope: round(slope),
        shape,
        dailyRateFor: (date) => rateFor(shape, date),
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
      const shape = { kind: 'weekday', rate: overall, factors };
      return {
        rate: round(overall),
        factors: factors.map((f) => round(f, 3)),
        shape,
        dailyRateFor: (date) => rateFor(shape, date),
      };
    },
  };
}

/**
 * The year's shape, from at least one full year of history.
 *
 * Each calendar month gets an index: its average day against the average of
 * all twelve months, so a year with more days of one month cannot tilt it.
 * Each weekday gets one too, but only when the same gate as the weekday model
 * says the difference is real; otherwise every weekday counts the same. The
 * level is the last four weeks with both patterns taken out, so the forecast
 * starts from where sales are now and follows last year's months from there.
 * It is only one more candidate: the held-out comparison still decides.
 */
function yearlySeasonal({ minimumDays = 365, minimumPerMonth = 28, recent = 28, minimumRatio = 1.6 } = {}) {
  return {
    id: 'yearly_seasonal',
    label: 'Yearly and weekday pattern',
    needs: minimumDays,
    fit(days) {
      const rows = usable(days);
      if (rows.length < this.needs) return null;
      const months = Array.from({ length: 12 }, () => []);
      for (const day of rows) months[monthOf(day.date)].push(valueOf(day));
      if (months.some((bucket) => bucket.length < minimumPerMonth)) return null;
      const monthMeans = months.map(mean);
      const overall = mean(monthMeans);
      if (!(overall > 0)) return null;
      const month = monthMeans.map((value) => value / overall);

      // Weekdays are compared after the months are taken out. A month with
      // no sales says nothing about weekdays, so it is left out here.
      const buckets = Array.from({ length: 7 }, () => []);
      for (const day of rows) {
        const factor = month[monthOf(day.date)];
        if (factor > 0) buckets[weekdayOf(day.date)].push(valueOf(day) / factor);
      }
      let weekday = Array(7).fill(1);
      if (buckets.every((bucket) => bucket.length >= 3)) {
        const means = buckets.map(mean), all = mean(means);
        const between = stdev(means), within = mean(buckets.map((bucket) => stdev(bucket)));
        if (all > 0 && between > 0 && (within === 0 || between / within >= minimumRatio)) weekday = means.map((value) => value / all);
      }

      const tail = rows.slice(-recent);
      const expected = tail.reduce((sum, day) => sum + month[monthOf(day.date)] * weekday[weekdayOf(day.date)], 0);
      if (!(expected > 0)) return null;
      const level = tail.reduce((sum, day) => sum + valueOf(day), 0) / expected;
      const shape = { kind: 'seasonal', level, month, weekday };
      return {
        rate: round(level),
        factors: month.map((f) => round(f, 3)),
        shape,
        dailyRateFor: (date) => rateFor(shape, date),
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

module.exports = { ALL, BASELINE_ID, byId, movingAverage, dampedTrend, weekdaySeasonal, yearlySeasonal, rateFor, mean, stdev, usable, valueOf };
