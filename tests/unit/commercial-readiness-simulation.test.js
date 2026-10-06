'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const measurement=require('../../docs/commercial-model-cost-distribution-2026-10-05.json');
const render=require('../../data/commercial-render-cost-evidence-2026-10-05.json');
const {build,MAILBOX_POLLS_PER_MONTH}=require('../../src/commercial/readiness-simulation');
test('seven workflow profiles retain five-minute mailbox duty cycle and separate projections from actual cash',()=>{
 const result=build({measurement,renderEvidence:render});
 assert.equal(result.checkoutEnabled,false);assert.equal(result.pricesApproved,false);
 assert.equal(result.profiles.length,7);assert.equal(MAILBOX_POLLS_PER_MONTH,8640);
 const growth=result.profiles.find(row=>row.id==='growth-normal');
 assert.equal(growth.connectedOperations,15740);assert.equal(growth.withinIncludedAllowance,true);
 assert.equal(growth.actualStripeRevenueUsd,null);assert.equal(growth.certifiedMarginPercent,null);
 assert.equal(result.assumptions.confidence.connectedReserve,'LOW_OPERATOR_STRESS_ASSUMPTION');
 const extreme=result.profiles.find(row=>row.id==='extreme-abusive');
 assert.ok(extreme.additionalOperationsNeeded>0);assert.equal(extreme.monthlyListScenario,null);
 assert.ok(extreme.hypotheticalOptInBuyMoreScenario.revenueUsd>999);
 assert.equal(extreme.stressExecutableEvenWithPacks,false);
 assert.equal(extreme.hypotheticalOptInBuyMoreStressScenario,null);
});
test('higher connected reserve visibly reduces contribution and does not alter measured model evidence',()=>{
 const base=build({measurement,renderEvidence:render});
 const stress=build({measurement,renderEvidence:render,assumptions:{connectedReserveUsdPerOperation:.005}});
 const plan='pro-normal';const a=base.profiles.find(row=>row.id===plan);const b=stress.profiles.find(row=>row.id===plan);
 assert.equal(a.projectedModelCostAtMeasuredMedianUsd,b.projectedModelCostAtMeasuredMedianUsd);
 assert.ok(b.monthlyListScenario.projectedMarginPercent<a.monthlyListScenario.projectedMarginPercent);
 assert.throws(()=>build({measurement:{...measurement,operations:{...measurement.operations,
  instruction:{...measurement.operations.instruction,missingCostRates:1}}},renderEvidence:render}),/fully priced/);
});
test('Pro stress alternatives expose connected fees, model cap and customer-usage tradeoffs',()=>{
 const result=build({measurement,renderEvidence:render});
 const baseline=result.proStressAlternatives.find(row=>row.id==='baseline-with-dollar-cap');
 const combined=result.proStressAlternatives.find(row=>row.id==='E-combined');
 const premium=result.proStressAlternatives.find(row=>row.id==='F-premium-sticker');
 const buffered=result.proStressAlternatives.find(row=>row.id==='G-premium-buffer');
 assert.equal(baseline.firstGuardrailAtWorstPolicyMix,'AI_DOLLAR_PERIOD_CAP');
 assert.ok(baseline.stressBreakdownUsd.connectedProviderReserve>baseline.stressBreakdownUsd.modelAfterGuard);
 assert.ok(baseline.fullIncludedGuardedStress.projectedMarginPercent<result.assumptions.targetContributionMarginPercent);
 assert.ok(combined.fullIncludedGuardedStress.meetsTarget);
 assert.equal(combined.sensitivityAboveGuardedStress.connectedCostPlus20Percent.meetsTarget,false);
 assert.equal(combined.sensitivityAboveGuardedStress.normalModelCostDoubledWouldPause,true);
 assert.equal(combined.proNormalCoverage.aiFits,true);
 assert.equal(combined.proNormalCoverage.connectedFits,false);
 assert.ok(combined.proNormalCoverage.hypotheticalConnectedPacks.priceUsd>0);
 assert.equal(premium.proNormalCoverage.connectedFits,true);
 assert.equal(premium.sensitivityAboveGuardedStress.connectedCostPlus20Percent.meetsTarget,false);
 assert.equal(buffered.proNormalCoverage.connectedFits,true);
 assert.equal(buffered.sensitivityAboveGuardedStress.connectedCostPlus20Percent.meetsTarget,true);
 assert.ok(buffered.fullIncludedGuardedStress.revenueUsd>premium.fullIncludedGuardedStress.revenueUsd);
 assert.ok(result.packs.every(pack=>pack.sensitivity.meetsTarget),
  'Every provisional pack must exceed the configured target under conservative stress');
});
