'use strict';

// Offline recommendation only: these quantities never change commercial plans,
// Stripe prices, runtime cost rates, or the checkout release switch.
const {ValidationError}=require('../domain/errors');
const {PROFILES,connectedCount}=require('./readiness-simulation');
const {entries}=require('./provider-cost-responsibility');
const stripeLiveFeeEvidence=require('./stripe-live-fee-evidence');
const WEIGHTS=Object.freeze({ask:1,instruction:7,import_mapping:5});
const PLAN=Object.freeze({
 starter:{priceUsd:199,ai:650,connected:2000,modelCapUsd:25,structure:{workspaces:1,members:3,locations:3,connections:2}},
 growth:{priceUsd:499,ai:2500,connected:20000,modelCapUsd:75,structure:{workspaces:3,members:15,locations:10,connections:8}},
 pro:{priceUsd:999,ai:8500,connected:70000,modelCapUsd:100,structure:{workspaces:10,members:50,locations:50,connections:25}},
});
const PACKS=Object.freeze([
 {category:'ai',units:500,priceUsd:49,autoTopUp:true},
 {category:'ai',units:2500,priceUsd:239,autoTopUp:false},
 {category:'connected',units:10000,priceUsd:79,autoTopUp:true},
 {category:'connected',units:50000,priceUsd:349,autoTopUp:false},
]);
const STRIPE_PUBLIC_US_STANDARD=Object.freeze({
  evidence:'ACCOUNT_SPECIFIC_DASHBOARD_PLAN_WITHOUT_LIVE_FEE_ROWS',
  accountId:stripeLiveFeeEvidence.accountId,
  observedOn:stripeLiveFeeEvidence.observedOn,
  accountDashboard:stripeLiveFeeEvidence.source,
  sourcePayments:'https://stripe.com/pricing',
  sourceBilling:'https://stripe.com/billing/pricing',
  domesticCardFraction:stripeLiveFeeEvidence.payments.domesticCardFraction,
  domesticCardFixedUsd:stripeLiveFeeEvidence.payments.domesticCardFixedUsd,
  billingVolumeFraction:stripeLiveFeeEvidence.billing.volumeFraction,
  radarStandardScreenedTransactionUsd:stripeLiveFeeEvidence.radar.screenedTransactionUsd,
  disputeReceivedUsd:15,disputeCounteredUsd:15,
  standardCardRefundIncrementalUsd:0,
  originalProcessingFeesReturnedOnRefund:false,
  taxApiUsedAtInitialLaunch:false,
  connectPlatformFeeUsd:null,
  accountSpecificPlanObserved:true,
  liveFeeRowsObserved:stripeLiveFeeEvidence.observedLiveFeeRows,
  otherPaymentMethodRatesCertified:false,
});
const INFRA=Object.freeze({webUsd:25,workerUsd:25,postgresUsd:19,capacityReserveFactor:1.5,
 activeWorkspaces:5,mix:{starter:2,growth:2,pro:1},loadWeights:{starter:1,growth:3,pro:8},
 diskUsdPerGb:0.30,sharedIncludedEgressGb:5,egressUsdPerGb:0.15,
 marginalCapacityReserveUsdPerOperation:0.0005,systemEmailReserveUsdPerMessage:0.001,
 // Observed account plan: 2.9% Payments + 0.7% Billing volume + up to
 // $0.05 Radar Standard per screened transaction. Actual fee rows supersede.
 stripeBillingFeeFraction:Number((STRIPE_PUBLIC_US_STANDARD.domesticCardFraction+
  STRIPE_PUBLIC_US_STANDARD.billingVolumeFraction).toFixed(6)),
 stripeBillingFeeFixedUsd:STRIPE_PUBLIC_US_STANDARD.domesticCardFixedUsd+
  STRIPE_PUBLIC_US_STANDARD.radarStandardScreenedTransactionUsd});
const round=(v)=>Math.round(v*10000)/10000;
const modelValues=(measurement,field)=>{
 if(measurement?.evidence!=='REAL_MODEL_COST_DISTRIBUTION'||measurement.checkoutEnabled!==false)
  throw new ValidationError('Closed-checkout real model evidence is required.');
 return Object.fromEntries(Object.keys(WEIGHTS).map(op=>{
  const row=measurement.operations?.[op];
  if(!row||row.count<20||row.missingCostRates!==0||!Number.isFinite(row[field]))
   throw new ValidationError(`Unpriced or insufficient ${op} model evidence.`);
  return [op,row[field]];}));};
const profile=(id)=>{const row=PROFILES.find(item=>item.id===id);if(!row)throw new ValidationError(`Unknown profile ${id}.`);return row;};
const normalId={starter:'starter-light',growth:'growth-normal',pro:'pro-normal'};
const heavyId={starter:'starter-heavy',growth:'growth-heavy',pro:'pro-heavy'};
function infrastructure(row,settings=INFRA){
 const base=profile(normalId[row.plan]);const load=settings.loadWeights[row.plan]*(row.id.includes('heavy')?2:row.id.includes('extreme')?4:1);
 const denominator=Object.entries(settings.mix).reduce((sum,[plan,n])=>sum+n*settings.loadWeights[plan],0)-
  settings.loadWeights[row.plan]+load;
 const pool=(settings.webUsd+settings.workerUsd+settings.postgresUsd)*settings.capacityReserveFactor;
 const shared=pool*(0.5/settings.activeWorkspaces+0.5*load/denominator);
 const otherEgress=Object.entries(settings.mix).reduce((sum,[plan,n])=>sum+n*profile(normalId[plan]).egressGb,0)-base.egressGb;
 const totalEgress=otherEgress+row.egressGb;
 const billableEgress=Math.max(0,totalEgress-settings.sharedIncludedEgressGb)*settings.egressUsdPerGb;
 const egress=totalEgress?billableEgress*row.egressGb/totalEgress:0;
 return {sharedComputeAndDbUsd:round(shared),diskUsd:round(row.storageGb*settings.diskUsdPerGb),
  allocatedEgressUsd:round(egress),totalUsd:round(shared+row.storageGb*settings.diskUsdPerGb+egress),
  basis:`${settings.activeWorkspaces} active workspaces; 50% equal + 50% load weighted; shared 5GB egress credit`};
}
function packsFor(category,need){if(need<=0)return {units:0,revenueUsd:0,purchases:0};
 const [small,large]=PACKS.filter(row=>row.category===category);let best=null;
 for(let n=0;n<=Math.ceil(need/large.units);n++){
  const s=Math.ceil(Math.max(0,need-n*large.units)/small.units);const row={units:n*large.units+s*small.units,
   revenueUsd:n*large.priceUsd+s*small.priceUsd,purchases:n+s};
  if(!best||row.revenueUsd<best.revenueUsd||row.revenueUsd===best.revenueUsd&&row.purchases<best.purchases)best=row;}
 return best;}
function moneyResult(revenueUsd,modelUsd,connectedInfraUsd,infraUsd,emailUsd,extraFixedFees=0){
 const paymentUsd=revenueUsd*INFRA.stripeBillingFeeFraction+INFRA.stripeBillingFeeFixedUsd+extraFixedFees;
 const cost=modelUsd+connectedInfraUsd+infraUsd+emailUsd+paymentUsd;
 return {revenueUsd:round(revenueUsd),modelUsd:round(modelUsd),connectedInfrastructureUsd:round(connectedInfraUsd),
  sharedStorageEgressUsd:round(infraUsd),emailReserveUsd:round(emailUsd),stockchiefBillingFeeReserveUsd:round(paymentUsd),
  projectedCostUsd:round(cost),contributionUsd:round(revenueUsd-cost),contributionMarginPercent:round((revenueUsd-cost)/revenueUsd*100),
  certified:false,unknownContractFeeUsd:null};}
function build(measurement,renderEvidence){
 if(renderEvidence?.currency!=='USD'||!Number.isInteger(renderEvidence.octoberMonthToDate?.providerProjectedMonthTotalCents))
  throw new ValidationError('Dated Render bill and forecast evidence required.');
 const median=modelValues(measurement,'medianUsd');const p95=modelValues(measurement,'p95Usd');
 const maxP95PerCredit=Math.max(...Object.keys(WEIGHTS).map(op=>p95[op]/WEIGHTS[op]));
 const profiles=[];const guarded=[];
 for(const plan of Object.keys(PLAN)){
  const offer=PLAN[plan];
  for(const kind of ['normal','heavy']){
   const row=profile((kind==='normal'?normalId:heavyId)[plan]);const ops=connectedCount(row.connected);
   const credits=Object.keys(WEIGHTS).reduce((sum,op)=>sum+row.ai[op]*WEIGHTS[op],0);
   const aiPacks=packsFor('ai',Math.max(0,credits-offer.ai));
   const connectedPacks=packsFor('connected',Math.max(0,ops-offer.connected));
   const modelUsd=Object.keys(WEIGHTS).reduce((sum,op)=>sum+row.ai[op]*median[op],0)+
    row.ai.failedInstructionAttempts*median.instruction;
   const modelP95Usd=Object.keys(WEIGHTS).reduce((sum,op)=>sum+row.ai[op]*p95[op],0)+
    row.ai.failedInstructionAttempts*p95.instruction;
   const infra=infrastructure(row);const revenue=offer.priceUsd+aiPacks.revenueUsd+connectedPacks.revenueUsd;
   const current=moneyResult(revenue,modelUsd,ops*INFRA.marginalCapacityReserveUsdPerOperation,
    infra.totalUsd,row.systemEmails*INFRA.systemEmailReserveUsdPerMessage,
    (aiPacks.purchases+connectedPacks.purchases)*INFRA.stripeBillingFeeFixedUsd);
   profiles.push({plan,kind,workloadId:row.id,aiCredits:credits,connectedOperations:ops,
    included:{ai:offer.ai,connected:offer.connected},
    requiresOptInBuyMore:aiPacks.purchases+connectedPacks.purchases>0,aiPacks,connectedPacks,
    infrastructure:infra,currentEstimatedCostScenario:current,
    measuredP95ModelDemandUsd:round(modelP95Usd),modelP95WouldHitDollarCap:modelP95Usd>offer.modelCapUsd,
    noPurchaseBehavior:kind==='heavy'&&aiPacks.purchases+connectedPacks.purchases>0?'PAUSE_AT_INCLUDED_EXHAUSTION':'CONTINUE_WITHIN_INCLUDED'});
  }
  const heavy=profile(heavyId[plan]);const heavyInfra=infrastructure(heavy);
  const baseModel=offer.ai*maxP95PerCredit*2+heavy.ai.failedInstructionAttempts*p95.instruction*2;
  const compute=(providerFactor,infrastructureFactor)=>{
   const model=Math.min(offer.modelCapUsd,baseModel*providerFactor);
   const connected=offer.connected*INFRA.marginalCapacityReserveUsdPerOperation*2*infrastructureFactor;
   const fixed=heavyInfra.totalUsd*1.5*infrastructureFactor;
   const email=heavy.systemEmails*INFRA.systemEmailReserveUsdPerMessage*2*providerFactor;
   const scenario=moneyResult(offer.priceUsd,model,connected,fixed,email);
   const targetCost=offer.priceUsd*.4;
   return {...scenario,modelExecutionPausedAtDollarCap:baseModel*providerFactor>offer.modelCapUsd,
    maximumAdditionalUnknownStockChiefFeeUsdPerConnectedOperationAt60Percent:round(Math.max(0,targetCost-scenario.projectedCostUsd)/offer.connected),
    meets60PercentTarget:scenario.contributionMarginPercent>=60};};
  let low=1,high=2;while(compute(high,high).meets60PercentTarget&&high<128)high*=2;
  for(let i=0;i<40;i++){const middle=(low+high)/2;if(compute(middle,middle).meets60PercentTarget)low=middle;else high=middle;}
  guarded.push({plan,allowance:{ai:offer.ai,connected:offer.connected},modelPeriodCapUsd:offer.modelCapUsd,
   fullAllowanceP95Stress:compute(1,1),plus25PercentProviderAndInfrastructure:compute(1.25,1.25),
   plus50PercentProviderAndInfrastructure:compute(1.5,1.5),
   doubleExpensiveAiAndProvider:compute(2,1),
   firstJointProviderAndInfrastructureCostMultiplierBelow60Percent:round(high),
   costAt50PercentAllowance:moneyResult(offer.priceUsd,Math.min(offer.modelCapUsd,baseModel*.25),
    offer.connected*INFRA.marginalCapacityReserveUsdPerOperation*.5,
    infrastructure(profile(normalId[plan])).totalUsd,heavy.systemEmails*INFRA.systemEmailReserveUsdPerMessage*.5),
   costAt100PercentAllowance:moneyResult(offer.priceUsd,Math.min(offer.modelCapUsd,baseModel*.5),
    offer.connected*INFRA.marginalCapacityReserveUsdPerOperation,
    infrastructure(profile(normalId[plan])).totalUsd,heavy.systemEmails*INFRA.systemEmailReserveUsdPerMessage)});
 }
 const packs=PACKS.map(pack=>{
  const unit=pack.category==='ai'?maxP95PerCredit:INFRA.marginalCapacityReserveUsdPerOperation;
  const calculate=(factor)=>{
   const cost=pack.units*unit*2*factor+pack.priceUsd*INFRA.stripeBillingFeeFraction+INFRA.stripeBillingFeeFixedUsd;
   return {costUsd:round(cost),contributionMarginPercent:round((pack.priceUsd-cost)/pack.priceUsd*100),
    meets60PercentTarget:(pack.priceUsd-cost)/pack.priceUsd>=.6};};
  const targetUnit=(pack.priceUsd*.4-pack.priceUsd*INFRA.stripeBillingFeeFraction-
   INFRA.stripeBillingFeeFixedUsd)/pack.units;
  return {...pack,fullUseP95Stress:calculate(1),plus50PercentCost:calculate(1.5),doubleExpensiveAiOrInfrastructure:calculate(2),
   maximumUnknownStockChiefFeeUsdPerUnitAt60Percent:pack.category==='connected'?round(targetUnit-unit*2):null,
   unknownContractFeeUsd:null};});
 const occupancyMix={1:null,3:{starter:1,growth:1,pro:1},5:INFRA.mix,10:{starter:4,growth:4,pro:2}};
 const occupancySensitivity=Object.entries(occupancyMix).flatMap(([count,mix])=>Object.keys(PLAN).map(plan=>{
  const row=profile(normalId[plan]);const settings={...INFRA,activeWorkspaces:Number(count),mix:mix||{starter:Number(plan==='starter'),
   growth:Number(plan==='growth'),pro:Number(plan==='pro')}};
  const shared=infrastructure(row,settings);const model=Object.keys(WEIGHTS).reduce((sum,op)=>sum+row.ai[op]*median[op],0)+
   row.ai.failedInstructionAttempts*median.instruction;
  return {activeWorkspaces:Number(count),plan,profileId:row.id,infrastructureUsd:shared.totalUsd,
   currentNormalEstimatedCost:moneyResult(PLAN[plan].priceUsd,model,
    connectedCount(row.connected)*INFRA.marginalCapacityReserveUsdPerOperation,
    shared.totalUsd,row.systemEmails*INFRA.systemEmailReserveUsdPerMessage)};}));
 return {evidence:'OFFLINE_PROPOSED_COMMERCIAL_MODEL_NOT_LIVE',checkoutEnabled:false,pricingApproved:false,
  assumptions:{stripePublicUsStandard:STRIPE_PUBLIC_US_STANDARD,
   renderOfficialPriceUsd:{web:25,worker:25,postgres:19,diskPerGb:.30,egressPerGb:.15},
   renderObservedForecastUsd:renderEvidence.octoberMonthToDate.providerProjectedMonthTotalCents/100,
   infrastructure:INFRA,confidence:{renderUnitPrices:'HIGH_OFFICIAL_AND_INVOICE_CROSSCHECK',
    tenantAllocation:'LOW_UNVALIDATED_TENANT_MIX_AND_CAPACITY',
    marginalConnectedCapacity:'LOW_OPERATOR_RESERVE_NOT_PROVIDER_TARIFF',
    aiOperationCost:'MEDIUM_REAL_SYNTHETIC_CALLS_VERIFIED_PUBLIC_RATES',
    merchantPassThrough:'MEDIUM_CODE_CONFIRMED_CONDITIONAL_ON_ACCOUNT_CONTRACT',
    unknownPlatformFees:'UNKNOWN_NOT_ASSUMED_ZERO'}},weights:WEIGHTS,plans:PLAN,packs,profiles,guarded,occupancySensitivity,
  providerResponsibilityCount:entries.length,
  limitations:['Unknown platform/API contractual fees are null, excluded from numeric margins, and must be confirmed before a final certified launch.',
   'Capacity reserve and five-workspace mix are explicit hypotheses, not measured production saturation.',
   'Stripe billing fees are a scenario reserve; actual balance transactions replace them.',
   'Model period caps shown here are proposed configuration and are not changed in live billing.']};
}
module.exports={build,PLAN,PACKS,INFRA,WEIGHTS,STRIPE_PUBLIC_US_STANDARD,infrastructure,packsFor};
