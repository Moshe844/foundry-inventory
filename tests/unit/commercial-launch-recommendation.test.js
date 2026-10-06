'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const measurement=require('../../docs/commercial-model-cost-distribution-2026-10-05.json');
const render=require('../../data/commercial-render-cost-evidence-2026-10-05.json');
const {build,PLAN,PACKS,STRIPE_PUBLIC_US_STANDARD}=require('../../src/commercial/launch-recommendation-simulation');
const {entries,classified,CATEGORY}=require('../../src/commercial/provider-cost-responsibility');
const registry=require('../../src/connections/providers/registry');
const shipping=require('../../src/shipping/postgres-accounts');
test('every current connector and shipping adapter has a cost-payer classification and unknown fees have no number',()=>{
 const known=new Set(entries.map(row=>row.provider));
 for(const row of registry.catalog())assert.ok(known.has(row.type),`Missing ${row.type}`);
 for(const provider of shipping.PROVIDERS)assert.ok(known.has(provider),`Missing ${provider}`);
 for(const special of ['stripe_merchant','stripe_stockchief_billing','anthropic','resend','render'])assert.ok(known.has(special));
 const costs=classified();assert.ok(costs.some(row=>row.provider==='stripe_merchant'&&row.category===CATEGORY.MERCHANT));
 assert.ok(costs.some(row=>row.provider==='stripe_stockchief_billing'&&row.category===CATEGORY.VARIABLE));
 assert.ok(costs.some(row=>row.provider==='stripe_stockchief_billing'&&row.category===CATEGORY.NO_FEE));
 assert.ok(costs.some(row=>row.provider==='xero'&&row.category===CATEGORY.VARIABLE));
 assert.ok(costs.some(row=>row.provider==='render'&&row.category===CATEGORY.INFRA));
 for(const item of costs.filter(row=>row.category===CATEGORY.UNKNOWN))assert.equal(item.contractRateUsd,null);
});
test('shared Render launch allocation does not duplicate dedicated services for every workspace',()=>{
 const result=build(measurement,render);assert.equal(result.checkoutEnabled,false);assert.equal(result.pricingApproved,false);
 assert.equal(result.profiles.length,6);assert.equal(result.providerResponsibilityCount,entries.length);
 const start=result.profiles.find(row=>row.plan==='starter'&&row.kind==='normal');
 const growth=result.profiles.find(row=>row.plan==='growth'&&row.kind==='normal');
 const pro=result.profiles.find(row=>row.plan==='pro'&&row.kind==='normal');
 assert.ok(start.infrastructure.totalUsd<growth.infrastructure.totalUsd);
 assert.ok(growth.infrastructure.totalUsd<pro.infrastructure.totalUsd);
 assert.ok(pro.infrastructure.totalUsd<75,'Pro does not receive a fictitious dedicated web/worker/DB');
});

test('Stripe reserve uses the observed billing account plan, includes Radar and does not certify Tax or other methods',()=>{
 const result=build(measurement,render),fees=result.assumptions.stripePublicUsStandard;
 assert.deepEqual(fees,STRIPE_PUBLIC_US_STANDARD);
 assert.equal(Number((fees.domesticCardFraction+fees.billingVolumeFraction).toFixed(6)),.036);
 assert.equal(fees.domesticCardFixedUsd,.30);
 assert.equal(fees.disputeReceivedUsd,15);
 assert.equal(fees.originalProcessingFeesReturnedOnRefund,false);
 assert.equal(fees.taxApiUsedAtInitialLaunch,false);
 assert.equal(fees.connectPlatformFeeUsd,null);
 assert.equal(fees.accountSpecificPlanObserved,true);
 assert.equal(fees.accountId,'acct_1UBFTdIjKuQgOJD6');
 assert.equal(fees.radarStandardScreenedTransactionUsd,.05);
 assert.equal(fees.liveFeeRowsObserved,0);
 assert.equal(fees.otherPaymentMethodRatesCertified,false);
});
test('proposed $999 Pro normal fits, heavy needs opt-in Buy More, and full guarded stress meets target',()=>{
 const result=build(measurement,render);const pro=result.profiles.filter(row=>row.plan==='pro');
 assert.equal(PLAN.pro.priceUsd,999);assert.ok(PLAN.pro.connected<80000);
 assert.equal(pro[0].requiresOptInBuyMore,false);assert.equal(pro[1].requiresOptInBuyMore,true);
 assert.equal(pro[0].noPurchaseBehavior,'CONTINUE_WITHIN_INCLUDED');
 assert.equal(pro[1].noPurchaseBehavior,'PAUSE_AT_INCLUDED_EXHAUSTION');
 assert.ok(result.guarded.every(row=>row.fullAllowanceP95Stress.meets60PercentTarget));
 assert.ok(result.guarded.filter(row=>row.plan!=='pro').every(row=>row.plus50PercentProviderAndInfrastructure.meets60PercentTarget));
 assert.equal(result.guarded.find(row=>row.plan==='pro').plus50PercentProviderAndInfrastructure.meets60PercentTarget,false);
 assert.ok(result.occupancySensitivity.some(row=>row.activeWorkspaces===1&&row.plan==='starter'&&
  row.currentNormalEstimatedCost.contributionMarginPercent<60));
 assert.ok(result.packs.every(row=>row.plus50PercentCost.meets60PercentTarget));
 assert.ok(result.packs.every(row=>row.doubleExpensiveAiOrInfrastructure.meets60PercentTarget));
 assert.ok(PACKS.filter(row=>row.autoTopUp).every(row=>[500,10000].includes(row.units)));
 assert.throws(()=>build({...measurement,operations:{...measurement.operations,
  instruction:{...measurement.operations.instruction,missingCostRates:1}}},render),/Unpriced/);
});
