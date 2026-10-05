'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { build, emailScenario, reconcileInvoice } = require('../../src/commercial/cost-scenarios');
const modelEvidence = require('../../docs/commercial-cost-measurements-2026-10-05.json');
const emailEvidence = { actualPlanPriceVerified: true,
  verifiedPlan: { name: 'Free', monthlySubscriptionUsd: 0, monthlyEmailLimit: 3000, dailyEmailLimit: 100 },
  candidatePaidPlanScenario: { name: 'Pro', monthlySubscriptionUsd: 20, includedEmails: 50000,
    dailyEmailLimit: null, overageBucketEmails: 1000, overageBucketUsd: 0.9, overagesRequireOptIn: true } };
const renderEvidence = { currency: 'USD', septemberInvoice: { statusObserved: 'paid', totalCents: 1000, lineItems: [{ amountCents: 1000 }] },
  octoberMonthToDate: { providerProjectedMonthTotalCents: 7350 } };
test('free email cost is zero only with verified plan and within both limits', () => {
  assert.equal(emailScenario(emailEvidence, { monthlyEmails: 3000, peakDailyEmails: 100 }).monthlyUsd, 0);
  assert.equal(emailScenario(emailEvidence, { monthlyEmails: 3001, peakDailyEmails: 100 }).monthlyUsd, null);
  assert.equal(emailScenario(emailEvidence, { monthlyEmails: 101, peakDailyEmails: 101 }).monthlyUsd, null);
  assert.equal(emailScenario({}, { monthlyEmails: 1, peakDailyEmails: 1 }).monthlyUsd, null);
});
test('candidate email overages round up whole buckets and remain hypothetical', () => {
  const result = emailScenario(emailEvidence, { monthlyEmails: 51001, peakDailyEmails: 5000 }, true);
  assert.equal(result.overageBuckets, 2); assert.equal(result.monthlyUsd, 21.8);
  assert.equal(result.activePlan, false); assert.equal(result.hypothetical, true);
  assert.throws(() => emailScenario({ ...emailEvidence, verifiedPlan: { ...emailEvidence.verifiedPlan, monthlySubscriptionUsd: null } },
    { monthlyEmails: 1, peakDailyEmails: 1 }), /explicit/);
});
test('real sample sensitivity never treats projections or partial costs as actual cost, revenue or margin', () => {
  const result = build({ modelEvidence, renderEvidence, emailEvidence });
  assert.equal(result.scenarios.length, 36); assert.equal(result.historicalPaidRenderInvoiceUsd, 10);
  const ten = result.scenarios.find(row => row.customers === 10 && row.loadMultiplier === 1 && row.hostingMultiplier === 1);
  assert.equal(ten.projectedRenderUsd, 73.5); assert.equal(ten.equalShareHostingSensitivityUsd, 7.35);
  assert.equal(ten.currentEmail.monthlyUsd, null); assert.equal(ten.candidateEmail.monthlyUsd, 20);
  for (const row of result.scenarios) {
    assert.equal(row.totalCostUsd, null); assert.equal(row.certifiedMarginPercent, null);
    assert.equal(row.actualStripeRevenueUsd, null); assert.equal(row.capacityValidated, false);
    assert.equal(row.measuredTenantAllocation, false);
  }
  assert.equal(result.checkoutEnabled, false); assert.equal(result.allowancesApproved, false);
});
test('missing model rates propagate unknown instead of silently becoming a zero subtotal', () => {
  const models = structuredClone(modelEvidence); models.profiles[0].measured.ask.costUsdPerAttempt = null;
  const result = build({ modelEvidence: models, renderEvidence, emailEvidence });
  assert.equal(result.profiles[0].monthlyModelUsd, null);
  assert.equal(result.scenarios[0].knownComponentSubtotalCurrentUsd, null);
  assert.equal(result.scenarios[0].knownComponentSubtotalCandidateUsd, null);
});
test('invoice evidence must reconcile and all numerical costs/counts must be explicit', () => {
  assert.throws(() => reconcileInvoice({ statusObserved: 'paid', totalCents: 0, lineItems: [{ amountCents: null }] }), /explicit/);
  assert.throws(() => reconcileInvoice({ statusObserved: 'paid', totalCents: 2, lineItems: [{ amountCents: 1 }] }), /reconcile/);
  assert.throws(() => build({ modelEvidence, renderEvidence, emailEvidence, portfolios: [{ name: 'invalid', mix: { starter: 0 } }] }), /at least one/);
  assert.throws(() => build({ modelEvidence, renderEvidence, emailEvidence, portfolios: [{ name: 'invalid', mix: { invented: 1 } }] }), /no measured/);
});
