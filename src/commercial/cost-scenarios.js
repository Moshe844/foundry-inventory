'use strict';

// Offline sensitivity analysis, deliberately separate from the production cost
// ledger. A forecast, equal-share allocation or public price is not an invoice.
const { ValidationError } = require('../domain/errors');

function amount(value, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new ValidationError(`${label} must be an explicit non-negative ${integer ? 'integer' : 'number'}.`);
  }
  return value;
}
function reconcileInvoice(invoice) {
  if (invoice?.statusObserved !== 'paid' || !Array.isArray(invoice.lineItems) || !invoice.lineItems.length) {
    throw new ValidationError('A paid Render invoice with explicit line amounts is required.');
  }
  const total = invoice.lineItems.reduce((sum, row) => sum + amount(row.amountCents, 'Invoice line', true), 0);
  if (total !== amount(invoice.totalCents, 'Invoice total', true)) throw new ValidationError('Render invoice does not reconcile.');
  return total;
}
function emailScenario(evidence, demand, candidate = false) {
  amount(demand.monthlyEmails, 'Monthly email demand', true);
  amount(demand.peakDailyEmails, 'Peak daily email demand', true);
  if (evidence?.actualPlanPriceVerified !== true || !evidence.verifiedPlan) {
    return { known: false, monthlyUsd: null, blocked: ['EMAIL_PLAN_UNVERIFIED'] };
  }
  const plan = candidate ? evidence.candidatePaidPlanScenario : evidence.verifiedPlan;
  if (!plan) return { known: false, monthlyUsd: null, blocked: ['EMAIL_CANDIDATE_UNVERIFIED'] };
  const base = amount(plan.monthlySubscriptionUsd, 'Email subscription');
  const included = amount(candidate ? plan.includedEmails : plan.monthlyEmailLimit, 'Included emails', true);
  const daily = plan.dailyEmailLimit === null ? null : amount(plan.dailyEmailLimit, 'Daily email cap', true);
  const blocked = [];
  if (daily !== null && demand.peakDailyEmails > daily) blocked.push('EMAIL_DAILY_LIMIT_EXCEEDED');
  const excess = Math.max(0, demand.monthlyEmails - included);
  // The candidate includes hypothetical explicit overage opt-in, never a setting change.
  const overages = candidate && plan.overagesRequireOptIn === true;
  if (excess && !overages) blocked.push('EMAIL_MONTHLY_LIMIT_EXCEEDED');
  let buckets = 0;
  if (excess && overages) {
    const size = amount(plan.overageBucketEmails, 'Overage bucket size', true);
    if (size === 0) throw new ValidationError('Overage bucket size must be positive.');
    buckets = Math.ceil(excess / size);
  }
  const overage = buckets ? buckets * amount(plan.overageBucketUsd, 'Overage bucket price') : 0;
  return { known: true, plan: plan.name, activePlan: !candidate, hypothetical: candidate,
    assumesExplicitOverageOptIn: candidate, monthlyUsd: blocked.length ? null : base + overage,
    monthlySubscriptionUsd: base, overageBuckets: buckets, overageUsd: overage, blocked,
    limitsSatisfied: blocked.length === 0, demand };
}

const DEFAULT_PORTFOLIOS = [
  { name: 'One Starter customer', mix: { starter: 1 } },
  { name: 'Ten customers', mix: { starter: 7, growth: 2, pro: 1 } },
  { name: 'Fifty customers', mix: { starter: 35, growth: 10, pro: 5 } },
  { name: 'One hundred customers', mix: { starter: 70, growth: 20, pro: 10 } },
];
// Explicit workload hypotheses, not promises, observed demand or purchased limits.
const EMAIL_DEMAND = {
  starter: { monthlyEmails: 30, peakDailyEmails: 10 },
  growth: { monthlyEmails: 150, peakDailyEmails: 30 },
  pro: { monthlyEmails: 600, peakDailyEmails: 100 },
  enterprise: { monthlyEmails: 2000, peakDailyEmails: 400 },
};

function build({ modelEvidence, renderEvidence, emailEvidence, portfolios = DEFAULT_PORTFOLIOS }) {
  if (modelEvidence?.evidence !== 'REAL_MODEL_USAGE_WITH_MODELED_MONTHLY_PROFILES' || modelEvidence.checkoutEnabled !== false) {
    throw new ValidationError('Use preserved real-model sample evidence with closed checkout.');
  }
  if (renderEvidence?.currency !== 'USD') throw new ValidationError('Only verified USD Render evidence is supported.');
  const paidInvoiceCents = reconcileInvoice(renderEvidence.septemberInvoice);
  const hosting = amount(renderEvidence.octoberMonthToDate?.providerProjectedMonthTotalCents, 'Render forecast', true) / 100;
  const profiles = modelEvidence.profiles.map(profile => {
    if (!EMAIL_DEMAND[profile.plan]) throw new ValidationError('Unknown plan in model evidence.');
    let modelUsd = 0; let missing = false;
    for (const [operation, volume] of Object.entries(profile.monthly)) {
      amount(volume, 'Model workload', true);
      const measurement = profile.measured?.[operation];
      if (!measurement || measurement.missingCostRates !== 0 || measurement.costUsdPerAttempt === null || measurement.sampleCount < 1) {
        missing = true; continue;
      }
      modelUsd += amount(measurement.costUsdPerAttempt, 'Measured model cost') * volume;
    }
    return { plan: profile.plan, workload: profile.monthly, connectedOperations: amount(profile.connectedOperations, 'Connected workload', true),
      modelSampleCount: profile.samples.length, monthlyModelUsd: missing ? null : modelUsd,
      modeledEmailDemand: EMAIL_DEMAND[profile.plan], costPerConnectedOperationUsd: null,
      actualStripeRevenueUsd: null, totalMonthlyCostUsd: null, marginPercent: null,
      recommendedFinalAllowances: null, recommendedFinalPackPrices: null };
  });
  const scenarios = portfolios.flatMap(portfolio => {
    const customers = Object.values(portfolio.mix).reduce((sum, count) => sum + amount(count, 'Customer count', true), 0);
    if (!customers) throw new ValidationError('A portfolio requires at least one customer.');
    for (const plan of Object.keys(portfolio.mix)) if (!profiles.some(profile => profile.plan === plan)) throw new ValidationError('Portfolio plan has no measured evidence.');
    return [0.5, 1, 2].flatMap(loadMultiplier => [1, 2, 4].map(hostingMultiplier => {
      let modelUsd = 0; let missingModel = false; let monthlyEmails = 0; let peakDailyEmails = 0; let connectedOperations = 0;
      for (const profile of profiles) {
        const count = portfolio.mix[profile.plan] || 0;
        if (!count) continue;
        if (profile.monthlyModelUsd === null) missingModel = true; else modelUsd += profile.monthlyModelUsd * count * loadMultiplier;
        monthlyEmails += Math.ceil(profile.modeledEmailDemand.monthlyEmails * count * loadMultiplier);
        peakDailyEmails += Math.ceil(profile.modeledEmailDemand.peakDailyEmails * count * loadMultiplier);
        connectedOperations += Math.ceil(profile.connectedOperations * count * loadMultiplier);
      }
      const demand = { monthlyEmails, peakDailyEmails };
      const currentEmail = emailScenario(emailEvidence, demand);
      const candidateEmail = emailScenario(emailEvidence, demand, true);
      const renderForecastUsd = hosting * hostingMultiplier;
      return { name: portfolio.name, mix: portfolio.mix, customers, loadMultiplier, hostingMultiplier,
        capacityValidated: false, measuredTenantAllocation: false, projectedRenderUsd: renderForecastUsd,
        equalShareHostingSensitivityUsd: renderForecastUsd / customers, connectedOperations,
        modelExtrapolationUsd: missingModel ? null : modelUsd, currentEmail, candidateEmail,
        knownComponentSubtotalCurrentUsd: missingModel || currentEmail.monthlyUsd === null ? null : renderForecastUsd + modelUsd + currentEmail.monthlyUsd,
        knownComponentSubtotalCandidateUsd: missingModel || candidateEmail.monthlyUsd === null ? null : renderForecastUsd + modelUsd + candidateEmail.monthlyUsd,
        actualStripeRevenueUsd: null, totalCostUsd: null, certifiedMarginPercent: null,
        unresolved: ['CONNECTED_OPERATION_COST_UNKNOWN', 'TENANT_RESOURCE_ALLOCATION_UNMEASURED',
          'PRODUCTION_CAPACITY_UNVALIDATED', 'MODEL_SAMPLE_NOT_P95', 'ACTUAL_COMMERCIAL_REVENUE_UNAVAILABLE'] };
    }));
  });
  return { evidence: 'REAL_MODEL_SAMPLES_AND_VERIFIED_PROVIDER_EVIDENCE_WITH_MODELED_SENSITIVITIES',
    currency: 'USD', checkoutEnabled: false, allowancesApproved: false, packPricesApproved: false,
    historicalPaidRenderInvoiceUsd: paidInvoiceCents / 100, projectedRenderMonthlyUsd: hosting,
    emailPlanVerified: emailEvidence?.actualPlanPriceVerified === true, profiles, scenarios,
    limitations: [
      'Render forecast is shared qualification infrastructure, not paid October cost or certified production capacity.',
      'Customer mix, equal-share hosting, email demand and 0.5x/1x/2x loads are explicit scenario assumptions.',
      'Daily email demand assumes coincident customer peaks; it is a stress case, not an observed distribution.',
      '1x/2x/4x hosting is cost sensitivity only; throughput does not necessarily scale linearly.',
      'Candidate email plan and overage opt-in are hypothetical and unapproved; no plan was changed.',
      'Known-component subtotals omit unverified provider, network, storage, retry and other operating costs.',
      'No unknown cost is substituted with zero, no final pricing is recommended, and no margin is certified.',
    ] };
}

module.exports = { build, emailScenario, reconcileInvoice };
