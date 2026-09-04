'use strict';

/**
 * Is the rule you set last spring still the right rule?
 *
 * A reorder point is a decision frozen at a moment: this much demand, this
 * supplier, this fast. All three drift. The number does not, and nothing in an
 * ordinary inventory system ever asks whether it should have. Six months later
 * the rule is firing at 60 for a product now selling half as fast again, from a
 * supplier now taking three days longer, and every individual number in the
 * system is correct.
 *
 * So this module recomputes what the rule would be if it were set today, from
 * measured demand and measured lead time, and compares. It does not change
 * anything. A recommendation with two buttons on it is the default and the
 * owner's answer is the decision; only an explicit grant of authority lets
 * Foundry move a target on its own, and even then only inside stated bounds.
 *
 * The arithmetic is the standard one, and it is standard on purpose — an owner
 * can check it against any inventory textbook, or their accountant can:
 *
 *   reorder point = demand over the lead time and the review gap
 *                   + safety stock
 *   safety stock  = z · √( L·σ_demand² + demand²·σ_leadtime² )
 *
 * That safety formula earns its square root. Two different things go wrong —
 * demand jumps, or the delivery is late — and adding them arithmetically
 * double-counts the odds of both happening at once. It also makes explicit
 * something owners find genuinely surprising: an unreliable supplier costs more
 * safety stock than a volatile product does, usually by a lot, and the cheapest
 * way to hold less stock is often to fix the supplier rather than the forecast.
 *
 * `z` comes from what the owner said they care about, not from a default that
 * pretends to be neutral. There is no correct service level; there is only the
 * trade the owner wants to make.
 */

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Service levels, in the owner's terms rather than a statistician's.
 *
 * The z values are the standard normal quantiles. The labels are what the
 * settings page shows; nobody should have to know what a z is to run a shop.
 */
const SERVICE_LEVELS = {
  lean: { z: 1.04, label: 'Keep stock lean', serviceRate: '85%',
    blurb: 'Accept the occasional stockout to hold less stock.' },
  balanced: { z: 1.28, label: 'Balanced', serviceRate: '90%',
    blurb: 'The usual trade between availability and money tied up.' },
  protective: { z: 1.65, label: 'Avoid stockouts', serviceRate: '95%',
    blurb: 'Carry more so customers are rarely turned away.' },
};

const DEFAULT_SERVICE = 'balanced';

/** How long until somebody looks at this line again. Usage in the gap counts. */
const DEFAULT_REVIEW_DAYS = 7;

/** Days of cover bought above the reorder point when nothing else says. */
const DEFAULT_COVER_DAYS = 30;

/*
 * How far out a current setting has to be before Foundry raises it. Rules that
 * are nearly right are left alone: an assistant that suggests 62 instead of 60
 * has taught the owner to ignore it by the third time.
 */
const MATERIAL = {
  fraction: 0.2,      // a fifth out, or
  units: 5,           // at least this many units out — whichever is larger
};

const step = (name, detail, value = null) => ({ step: name, detail, value });

function serviceLevel(goals = {}) {
  const key = goals.serviceLevel && SERVICE_LEVELS[goals.serviceLevel] ? goals.serviceLevel : DEFAULT_SERVICE;
  return { key, ...SERVICE_LEVELS[key] };
}

function isMaterial(current, recommended) {
  if (current === null || current === undefined) return true;
  const gap = Math.abs(recommended - current);
  return gap >= Math.max(MATERIAL.units, current * MATERIAL.fraction);
}

/**
 * Works out what the rules would be if they were being set today.
 *
 * @param input.forecast   from forecast.js — a null dailyRate means no advice
 * @param input.leadTime   from lead-time.js
 * @param input.policy     the current reorder policy, as configured
 * @param input.goals      structured operating preferences
 */
function advise(input) {
  const { forecast, leadTime, policy = {}, goals = {} } = input;
  const service = serviceLevel(goals);
  const reviewDays = Number(goals.reviewDays || DEFAULT_REVIEW_DAYS);
  const displayName = input.displayName || 'This product';

  // --- can anything be said at all? -----------------------------------------

  if (!forecast || forecast.dailyRate === null) {
    return {
      advisable: false,
      reason: 'no_demand_evidence',
      headline: 'Not enough trading history to judge these settings',
      explanation: `${displayName} does not yet have enough demand history for Foundry to say whether `
        + 'its reorder settings are right. Your configured rule is being followed exactly as set.',
      service,
      recommendations: [],
      calculation: [],
    };
  }

  const dailyRate = Number(forecast.dailyRate);

  /*
   * A rate of zero is not a rate. It is the absence of one, and the arithmetic
   * below cannot tell the difference: nothing sold per day, times any lead time
   * at all, is a reorder point of zero and a target of zero — which is Foundry
   * advising an owner to switch replenishment off entirely.
   *
   * This is the stockout trap wearing a different hat. A product that sold seven
   * a day for four months and nothing this week has almost certainly been
   * unavailable rather than abandoned; recommending zero would guarantee it
   * stayed that way, and the recommendation would look perfectly reasoned on the
   * way past.
   *
   * So Foundry declines, says which of the two cases it thinks it is looking at,
   * and leaves the configured rule exactly as the owner set it.
   */
  if (!(dailyRate > 0)) {
    const evidence = forecast.evidence || {};
    const sold = Number(evidence.netDemand || 0);
    const emptyDays = Number(evidence.censoredDays || 0);
    const stoppedSelling = sold > 0;
    return {
      advisable: false,
      reason: stoppedSelling ? 'demand_stopped' : 'no_demand_evidence',
      headline: stoppedSelling
        ? 'This has stopped selling, so its settings are not being second-guessed'
        : 'Nothing has sold, so there is nothing to size these settings against',
      explanation: stoppedSelling
        ? displayName + ' has sold ' + sold + ' in the period Foundry looked at, but nothing '
          + 'recently'
          + (emptyDays > 0
            ? ', and it was out of stock on ' + emptyDays + ' of those days, which is the most '
              + 'likely reason. '
            : '. ')
          + 'Foundry will not recommend a reorder level of zero on the strength of a quiet week. '
          + 'Your rule is being followed exactly as set.'
        : displayName + ' has no recorded sales, so Foundry has nothing to size a reorder level '
          + 'against. Your configured rule is being followed exactly as set.',
      service,
      recommendations: [],
      calculation: [],
    };
  }

  const leadDays = leadTime && leadTime.planningDays !== null ? Number(leadTime.planningDays) : null;

  if (leadDays === null) {
    return {
      advisable: false,
      reason: 'no_lead_time',
      headline: 'No lead time to plan against',
      explanation: `${displayName} sells about ${dailyRate} a day, but Foundry does not know how long `
        + 'its supplier takes, so it cannot say when to reorder. Set a lead time on the supplier and this becomes answerable.',
      service,
      recommendations: [],
      calculation: [],
    };
  }

  const calculation = [];

  // --- the two things that go wrong -----------------------------------------

  // Daily demand variability, straight from the forecast's own evidence.
  const demandSigma = forecast.evidence && forecast.evidence.variation !== null
    ? round(dailyRate * Number(forecast.evidence.variation)) : round(dailyRate * 0.5);
  const leadSigma = leadTime && leadTime.measured ? Number(leadTime.measured.variabilityDays) : 0;

  calculation.push(step('demand',
    `Selling about ${dailyRate} a day, varying by about ${demandSigma} a day.`, dailyRate));
  calculation.push(step('lead_time',
    leadTime.source === 'measured'
      ? `${leadTime.supplierName || 'The supplier'} has actually been taking about ${leadDays} days`
        + (leadSigma > 0 ? `, varying by about ${round(leadSigma, 1)} days.` : '.')
      : `Lead time of ${leadDays} days, as configured.`,
    leadDays));

  // --- safety stock ---------------------------------------------------------

  const demandTerm = leadDays * demandSigma ** 2;
  const leadTerm = (dailyRate ** 2) * (leadSigma ** 2);
  const safetyStock = Math.ceil(service.z * Math.sqrt(demandTerm + leadTerm));

  calculation.push(step('safety',
    `To be right about ${service.serviceRate} of the time, safety stock is `
    + `${service.z} × √(${round(demandTerm)} from demand swings + ${round(leadTerm)} from delivery swings) `
    + `= ${safetyStock}.`, safetyStock));

  // Which of the two is actually driving the buffer — the useful half of this.
  const driver = leadTerm > demandTerm ? 'supplier' : 'demand';

  // --- reorder point --------------------------------------------------------

  const duringLead = Math.ceil(dailyRate * (leadDays + reviewDays));
  const reorderPoint = duringLead + safetyStock;
  calculation.push(step('reorder_point',
    `Usage while waiting: ${dailyRate}/day × (${leadDays} days lead time + ${reviewDays} days until `
    + `the next look) = ${duringLead}, plus ${safetyStock} safety = ${reorderPoint}.`, reorderPoint));

  // --- target ---------------------------------------------------------------

  let coverDays = Number(goals.coverDays || DEFAULT_COVER_DAYS);
  const maxDays = goals.maxDaysOfSupply === undefined || goals.maxDaysOfSupply === null
    ? null : Number(goals.maxDaysOfSupply);
  let coverCapped = false;
  if (maxDays !== null) {
    // The owner's ceiling on days of supply binds the target, not the reorder
    // point: refusing to hold cover is a choice, refusing to reorder in time is
    // just running out.
    const maxTargetUnits = Math.ceil(dailyRate * maxDays);
    if (reorderPoint + Math.ceil(dailyRate * coverDays) > maxTargetUnits) {
      coverDays = Math.max(0, round((maxTargetUnits - reorderPoint) / (dailyRate || 1), 1));
      coverCapped = true;
    }
  }
  const target = reorderPoint + Math.ceil(dailyRate * coverDays);
  calculation.push(step('target',
    coverCapped
      ? `Order up to the reorder point plus cover, held down to ${target} by your instruction not to `
        + `keep more than about ${maxDays} days of supply.`
      : `Order up to the reorder point plus ${coverDays} days of cover = ${target}.`, target));

  const daysOfCoverAtTarget = dailyRate > 0 ? round(target / dailyRate, 1) : null;

  // --- compare with what is configured --------------------------------------

  const recommendations = [];

  if (policy.reorderPoint !== null && policy.reorderPoint !== undefined) {
    if (isMaterial(policy.reorderPoint, reorderPoint)) {
      recommendations.push(reorderPointAdvice({
        displayName, current: policy.reorderPoint, recommended: reorderPoint,
        dailyRate, leadDays, leadTime, forecast, safetyStock, driver, service,
      }));
    }
  } else {
    recommendations.push({
      kind: 'reorder_point', current: null, recommended: reorderPoint, direction: 'set',
      headline: `Set a reorder point of ${reorderPoint} for ${displayName}`,
      why: `At ${dailyRate} a day and ${leadDays} days to get more, stock needs to be reordered at `
        + `${reorderPoint} to avoid running out while waiting.`,
      actionLabel: `Use ${reorderPoint}`, keepLabel: 'Leave it unset',
    });
  }

  if (policy.targetStock !== null && policy.targetStock !== undefined) {
    if (isMaterial(policy.targetStock, target)) {
      recommendations.push(targetAdvice({
        displayName, current: policy.targetStock, recommended: target,
        dailyRate, daysOfCoverAtTarget, maxDays, coverCapped,
      }));
    }
  }

  if (policy.safetyStock !== null && policy.safetyStock !== undefined
    && isMaterial(policy.safetyStock, safetyStock)) {
    recommendations.push({
      kind: 'safety_stock', current: policy.safetyStock, recommended: safetyStock,
      direction: safetyStock > policy.safetyStock ? 'increase' : 'decrease',
      headline: `Safety stock of ${safetyStock} rather than ${policy.safetyStock} for ${displayName}`,
      why: driver === 'supplier'
        ? `Most of the buffer this product needs is for late deliveries rather than busy days — `
          + `${leadTime.supplierName || 'the supplier'}'s timing varies by about `
          + `${round(leadSigma, 1)} days. ${safetyStock} covers that ${service.serviceRate} of the time.`
        : `Demand swings by about ${demandSigma} a day, and ${safetyStock} covers that `
          + `${service.serviceRate} of the time.`,
      actionLabel: `Use ${safetyStock}`, keepLabel: `Keep ${policy.safetyStock}`,
    });
  }

  return {
    advisable: true,
    service,
    recommended: { reorderPoint, target, safetyStock, coverDays, daysOfCoverAtTarget },
    current: {
      reorderPoint: policy.reorderPoint ?? null,
      targetStock: policy.targetStock ?? null,
      safetyStock: policy.safetyStock ?? null,
    },
    driver,
    demandSigma,
    leadSigma: round(leadSigma, 2),
    recommendations,
    calculation,
  };
}

/**
 * The explanation an elite inventory manager would actually give.
 *
 * Names the two things that changed and what happens if nothing is done. A
 * recommendation that says only "84 instead of 60" is a number swap; one that
 * says why is an argument the owner can disagree with, which is the point.
 */
function reorderPointAdvice({ displayName, current, recommended, dailyRate, leadDays, leadTime, forecast, safetyStock, driver, service }) {
  const direction = recommended > current ? 'increase' : 'decrease';
  const causes = [];

  if (forecast.evidence && forecast.evidence.netDemand > 0) {
    causes.push(`${displayName} is selling about ${dailyRate} a day`);
  }
  if (leadTime.source === 'measured' && leadTime.material && leadTime.configuredDays !== null) {
    causes.push(`${leadTime.supplierName || 'the supplier'} has recently been taking about `
      + `${leadTime.planningDays} days rather than the ${leadTime.configuredDays} configured`);
  } else {
    causes.push(`deliveries take about ${leadDays} days`);
  }

  const consequence = direction === 'increase'
    ? `At ${current}, there is a real risk of running out before the replacement arrives.`
    : `At ${current}, more stock is being held than the current pace needs.`;

  return {
    kind: 'reorder_point',
    current,
    recommended,
    direction,
    headline: `Reorder ${displayName} at ${recommended} instead of ${current}`,
    why: `${causes.join(', and ')}. Covering that plus a ${safetyStock}-unit buffer for the days that go `
      + `wrong comes to ${recommended}. ${consequence}`,
    consequence,
    actionLabel: `Use ${recommended}`,
    keepLabel: `Keep ${current}`,
    driver,
    serviceRate: service.serviceRate,
  };
}

function targetAdvice({ displayName, current, recommended, dailyRate, daysOfCoverAtTarget, maxDays, coverCapped }) {
  const direction = recommended > current ? 'increase' : 'decrease';
  if (direction === 'decrease') {
    const currentDays = dailyRate > 0 ? round(current / dailyRate, 0) : null;
    return {
      kind: 'target_stock',
      current,
      recommended,
      direction,
      headline: `Order ${displayName} up to ${recommended} rather than ${current}`,
      why: `A target of ${current} is about ${currentDays} days of supply at the current pace of `
        + `${dailyRate} a day, which is tying money up in stock that will sit. Dropping the target to `
        + `${recommended} still leaves about ${daysOfCoverAtTarget} days of cover`
        + (coverCapped ? `, inside the ${maxDays} days you asked Foundry to stay under.` : '.'),
      actionLabel: `Use ${recommended}`,
      keepLabel: `Keep ${current}`,
    };
  }
  return {
    kind: 'target_stock',
    current,
    recommended,
    direction,
    headline: `Order ${displayName} up to ${recommended} rather than ${current}`,
    why: `At ${dailyRate} a day, a target of ${current} is only about `
      + `${dailyRate > 0 ? round(current / dailyRate, 0) : '?'} days of supply, so this line would be `
      + `reordered again almost immediately. ${recommended} gives about ${daysOfCoverAtTarget} days.`,
    actionLabel: `Use ${recommended}`,
    keepLabel: `Keep ${current}`,
  };
}

module.exports = { advise, serviceLevel, SERVICE_LEVELS, DEFAULT_SERVICE, MATERIAL, isMaterial };
