'use strict';

// Offline planning only. No prices, allowances, or rates in this module are
// applied to the commercial database or published to customers.
const {ValidationError}=require('../domain/errors');
const modelCostBudget=require('./model-cost-budget');
const DAYS=30;const MAILBOX_POLLS_PER_MONTH=DAYS*24*60/5;
const CREDIT_WEIGHTS={ask:1,instruction:3,import_mapping:5};
const PROFILES=[
 {id:'starter-light',plan:'starter',ai:{ask:60,instruction:4,import_mapping:1,failedInstructionAttempts:0},
  connected:{mailboxes:0,mailboxMessages:0,mailboxSends:0,commerceEvents:100,accountingSync:0,shippingRateTracking:25,
   automation:20,background:100},systemEmails:20,storageGb:1,egressGb:.2},
 {id:'starter-heavy',plan:'starter',ai:{ask:350,instruction:35,import_mapping:8,failedInstructionAttempts:3},
  connected:{mailboxes:0,mailboxMessages:0,mailboxSends:0,commerceEvents:500,accountingSync:0,shippingRateTracking:100,
   automation:150,background:800},systemEmails:70,storageGb:5,egressGb:1},
 {id:'growth-normal',plan:'growth',ai:{ask:700,instruction:80,import_mapping:20,failedInstructionAttempts:5},
  connected:{mailboxes:1,mailboxMessages:300,mailboxSends:100,commerceEvents:3000,accountingSync:300,shippingRateTracking:400,
   automation:2000,background:1000},systemEmails:150,storageGb:8,egressGb:2},
 {id:'growth-heavy',plan:'growth',ai:{ask:1500,instruction:220,import_mapping:60,failedInstructionAttempts:20},
  connected:{mailboxes:2,mailboxMessages:1000,mailboxSends:500,commerceEvents:12000,accountingSync:1500,shippingRateTracking:2000,
   automation:3000,background:1000},systemEmails:500,storageGb:20,egressGb:6},
 {id:'pro-normal',plan:'pro',ai:{ask:2200,instruction:500,import_mapping:400,failedInstructionAttempts:20},
  connected:{mailboxes:3,mailboxMessages:5000,mailboxSends:1000,commerceEvents:18000,accountingSync:3000,shippingRateTracking:4000,
   automation:8000,background:4000},systemEmails:600,storageGb:30,egressGb:10},
 {id:'pro-heavy',plan:'pro',ai:{ask:3500,instruction:1100,import_mapping:600,failedInstructionAttempts:60},
  connected:{mailboxes:5,mailboxMessages:12000,mailboxSends:3000,commerceEvents:45000,accountingSync:7000,shippingRateTracking:10000,
   automation:18000,background:8000},systemEmails:1500,storageGb:75,egressGb:30},
 {id:'extreme-abusive',plan:'pro',ai:{ask:0,instruction:3333,import_mapping:0,failedInstructionAttempts:360},
  connected:{mailboxes:8,mailboxMessages:30000,mailboxSends:10000,commerceEvents:100000,accountingSync:20000,
   shippingRateTracking:30000,automation:30000,background:20000},systemEmails:4000,storageGb:150,egressGb:100},
];
const CANDIDATE={
 allowances:{starter:{ai:500,connected:2000},growth:{ai:2500,connected:20000},pro:{ai:8000,connected:80000}},
 packs:[{category:'ai',units:500,priceUsd:69,autoTopUp:true},{category:'ai',units:2500,priceUsd:329,autoTopUp:false},
  {category:'connected',units:5000,priceUsd:75,autoTopUp:true},{category:'connected',units:25000,priceUsd:349,autoTopUp:false}],
};
const DEFAULT_ASSUMPTIONS={targetContributionMarginPercent:60,projectedCustomerCount:10,
 connectedReserveUsdPerOperation:.002,systemEmailReserveUsdPerEmail:.001,
 paymentFeeFraction:.032,paymentFeeFixedUsd:.30,
 storageBaselineGb:15,monthlyDiskUsdPerGb:.30,monthlyEgressIncludedGb:5,egressUsdPerGb:.15};
function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new ValidationError(`${label} must be non-negative and finite.`);return value;}
function cost(measurement,operation,field){const item=measurement.operations?.[operation];
 if(!item||item.count<20||item.missingCostRates!==0||!Number.isFinite(item[field]))
  throw new ValidationError(`Measured ${operation} ${field} requires at least 20 fully priced attempts.`);
 return item[field];}
function money(value){return Math.round(value*10000)/10000;}
function connectedCount(row){return row.mailboxes*MAILBOX_POLLS_PER_MONTH+
  Object.entries(row).filter(([key])=>key!=='mailboxes').reduce((sum,[,value])=>sum+value,0);}
function packCoverage(needed,packs){if(needed<=0)return {units:0,priceUsd:0,purchases:0,packs:[]};
 const [small,large]=[...packs].sort((a,b)=>a.units-b.units);if(!small||!large)throw new ValidationError('Two pack sizes required per category.');
 let best=null;for(let big=0;big<=Math.ceil(needed/large.units);big++){
  const little=Math.ceil(Math.max(0,needed-big*large.units)/small.units);
  const choice={units:big*large.units+little*small.units,priceUsd:big*large.priceUsd+little*small.priceUsd,
   purchases:big+little,packs:[{units:small.units,count:little},{units:large.units,count:big}]};
  if(!best||choice.priceUsd<best.priceUsd||choice.priceUsd===best.priceUsd&&choice.purchases<best.purchases)best=choice;}
 return best;}
function build({measurement,renderEvidence,assumptions={},candidate=CANDIDATE,profiles=PROFILES}){
 if(measurement?.evidence!=='REAL_MODEL_COST_DISTRIBUTION'||measurement.checkoutEnabled!==false)
  throw new ValidationError('Real, closed-checkout model distribution evidence is required.');
 if(renderEvidence?.currency!=='USD'||!Number.isSafeInteger(renderEvidence.octoberMonthToDate?.providerProjectedMonthTotalCents))
  throw new ValidationError('Provider Render forecast evidence is required.');
 const a={...DEFAULT_ASSUMPTIONS,...assumptions};for(const [name,value] of Object.entries(a))finite(value,name);
 if(!Number.isSafeInteger(a.projectedCustomerCount)||a.projectedCustomerCount<1)throw new ValidationError('Positive projected customer count required.');
 if(a.targetContributionMarginPercent/100+a.paymentFeeFraction>=1)
  throw new ValidationError('The target margin and payment-fee assumption leave no priceable contribution.');
 const model={};for(const operation of Object.keys(CREDIT_WEIGHTS))model[operation]={median:cost(measurement,operation,'medianUsd'),
  p95:cost(measurement,operation,'p95Usd'),max:cost(measurement,operation,'mostExpensiveUsd')};
 const renderForecast=renderEvidence.octoberMonthToDate.providerProjectedMonthTotalCents/100;
 const planPrices={starter:{monthly:199,annualMonthly:1990/12},growth:{monthly:499,annualMonthly:4990/12},
  pro:{monthly:999,annualMonthly:9990/12}};
 const formula=(revenue,variable,ai,connected,infrastructure,email)=>{
  const paymentFee=revenue*a.paymentFeeFraction+a.paymentFeeFixedUsd;
  const total=variable+ai+connected+infrastructure+email+paymentFee;
  return {revenueUsd:money(revenue),paymentFeeReserveUsd:money(paymentFee),projectedCostUsd:money(total),
   projectedContributionUsd:money(revenue-total),projectedMarginPercent:money((revenue-total)/revenue*100),
   meetsTarget:((revenue-total)/revenue*100)>=a.targetContributionMarginPercent};};
 const monthly=profiles.map(profile=>{
  const aiCredits=Object.entries(CREDIT_WEIGHTS).reduce((sum,[key,weight])=>sum+profile.ai[key]*weight,0);
  const ops=connectedCount(profile.connected);const included=candidate.allowances[profile.plan];
  const modelMedian=Object.entries(CREDIT_WEIGHTS).reduce((sum,[key])=>sum+profile.ai[key]*model[key].median,0)+
   profile.ai.failedInstructionAttempts*model.instruction.median;
  const modelP95=Object.entries(CREDIT_WEIGHTS).reduce((sum,[key])=>sum+profile.ai[key]*model[key].p95,0)+
   profile.ai.failedInstructionAttempts*model.instruction.p95;
  const storageIncrement=Math.max(0,profile.storageGb-a.storageBaselineGb)*a.monthlyDiskUsdPerGb;
  const egressIncrement=Math.max(0,profile.egressGb-a.monthlyEgressIncludedGb)*a.egressUsdPerGb;
  const infrastructure=renderForecast/a.projectedCustomerCount+storageIncrement+egressIncrement;
  const connected=ops*a.connectedReserveUsdPerOperation;
  const email=profile.systemEmails*a.systemEmailReserveUsdPerEmail;
  const price=planPrices[profile.plan];
  const base=formula(price.monthly,0,modelMedian,connected,infrastructure,email);
  const stress=formula(price.monthly,0,modelP95*2,connected*2.5,
   renderForecast*4/a.projectedCustomerCount+storageIncrement*2+egressIncrement*2,email*2);
  const allowed=aiCredits<=included.ai&&ops<=included.connected;
  const aiPacks=packCoverage(Math.max(0,aiCredits-included.ai),candidate.packs.filter(pack=>pack.category==='ai'));
  const connectedPacks=packCoverage(Math.max(0,ops-included.connected),candidate.packs.filter(pack=>pack.category==='connected'));
  const packRevenue=aiPacks.priceUsd+connectedPacks.priceUsd;
  const packFixedFees=(aiPacks.purchases+connectedPacks.purchases)*a.paymentFeeFixedUsd;
  const withPurchases=formula(price.monthly+packRevenue,packFixedFees,modelMedian,connected,infrastructure,email);
  const withPurchasesStress=formula(price.monthly+packRevenue,packFixedFees,modelP95*2,connected*2.5,
   renderForecast*4/a.projectedCustomerCount+storageIncrement*2+egressIncrement*2,email*2);
  const modelDollarCap=modelCostBudget.DEFAULTS.period[profile.plan];
  const stressModelExecutable=modelP95*2<=modelDollarCap;
  const ratios=[['AI_INCLUDED_LIMIT',aiCredits?included.ai/aiCredits:Infinity],
   ['CONNECTED_INCLUDED_LIMIT',ops?included.connected/ops:Infinity],
   ['AI_DOLLAR_PERIOD_CAP',modelP95?modelDollarCap/(modelP95*2):Infinity]];
  const firstGuardrail=[...ratios].sort((left,right)=>left[1]-right[1])[0];
  return {id:profile.id,plan:profile.plan,monthlyWorkflow:profile,aiCredits,connectedOperations:ops,
   included,withinIncludedAllowance:allowed,additionalCreditsNeeded:Math.max(0,aiCredits-included.ai),
   additionalOperationsNeeded:Math.max(0,ops-included.connected),
   hypotheticalPackCoverage:{ai:aiPacks,connected:connectedPacks},
   projectedModelCostAtMeasuredMedianUsd:money(modelMedian),projectedModelCostAtMeasuredP95Usd:money(modelP95),
   estimatedConnectedReserveUsd:money(connected),projectedInfrastructureUsd:money(infrastructure),
   projectedIncrementalStorageUsd:money(storageIncrement),projectedIncrementalEgressUsd:money(egressIncrement),
   estimatedSystemEmailReserveUsd:money(email),monthlyListScenario:allowed?base:null,
   unfundedDemandScenario:allowed?null:base,
   stressScenario2xModel2_5xConnected4xSharedHosting:allowed&&stressModelExecutable?stress:null,
   hypotheticalOptInBuyMoreScenario:allowed?null:withPurchases,
   hypotheticalOptInBuyMoreStressScenario:allowed||!stressModelExecutable?null:withPurchasesStress,
   firstGuardrailAtStatedStress:firstGuardrail[1]<1?firstGuardrail[0]:'NONE_WITHIN_PROFILE',
   modelDollarPeriodCapUsd:modelDollarCap,stressModelDemandUsd:money(modelP95*2),
   stressExecutableEvenWithPacks:stressModelExecutable,
   actualStripeRevenueUsd:null,certifiedMarginPercent:null};});
 const fullAllowance=Object.entries(candidate.allowances).map(([plan,allowance])=>{
  const price=planPrices[plan];const maxPerCredit=Math.max(...Object.entries(CREDIT_WEIGHTS).map(([key,weight])=>model[key].p95/weight));
  const modelP95=allowance.ai*maxPerCredit;const connected=allowance.connected*a.connectedReserveUsdPerOperation;
  const stressCostBeforeRevenueFee=modelP95*2+connected*2.5+renderForecast*4/a.projectedCustomerCount+a.paymentFeeFixedUsd;
  const targetFraction=a.targetContributionMarginPercent/100;
  const requiredPrice=stressCostBeforeRevenueFee/(1-targetFraction-a.paymentFeeFraction);
  return {plan,allowance,p95MostExpensiveCreditMixModelUsd:money(modelP95),connectedReserveUsd:money(connected),
   monthlyListPriceScenarioUsd:price.monthly,requiredMonthlyPriceForStressTargetUsd:money(requiredPrice),
   halfAllowanceScenario:formula(price.monthly,0,modelP95*.5,connected*.5,
    renderForecast/a.projectedCustomerCount,0),
   monthlyScenario:formula(price.monthly,0,modelP95,connected,renderForecast/a.projectedCustomerCount,0),
   annualScenarioMonthlyEquivalent:formula(price.annualMonthly,0,modelP95,connected,
    renderForecast/a.projectedCustomerCount,0),
   sensitivity2xModel2_5xConnected4xHosting:formula(price.monthly,0,modelP95*2,connected*2.5,
    renderForecast*4/a.projectedCustomerCount,0),
   guardedStress:formula(price.monthly,0,Math.min(modelP95*2,modelCostBudget.DEFAULTS.period[plan]),
    connected*2.5,renderForecast*4/a.projectedCustomerCount,0),
   firstGuardrail:modelP95*2>modelCostBudget.DEFAULTS.period[plan]?'AI_DOLLAR_PERIOD_CAP':'INCLUDED_LIMIT_AT_FULL_USE'};});
 const packs=candidate.packs.map(pack=>{const unitCost=pack.category==='ai'?Math.max(...Object.entries(CREDIT_WEIGHTS)
  .map(([key,weight])=>model[key].p95/weight)):a.connectedReserveUsdPerOperation;
  return {...pack,unitCostBasis:pack.category==='ai'?'MAX_MEASURED_P95_PER_CREDIT':'UNVERIFIED_CONNECTED_RESERVE',
   base:formula(pack.priceUsd,0,pack.units*unitCost,0,0,0),
   sensitivity:formula(pack.priceUsd,0,pack.units*unitCost*(pack.category==='ai'?2:2.5),0,0,0)};});
 const proNormal=profiles.find(profile=>profile.id==='pro-normal');
 const alternatives=[
  {id:'baseline-with-dollar-cap',allowance:{ai:8000,connected:80000},instructionWeight:3,aiPeriodCapUsd:250,
   tradeoff:'Preserves current provisional included usage but pauses expensive AI before all credits can be used.'},
  {id:'A-lower-included',allowance:{ai:5000,connected:60000},instructionWeight:3,aiPeriodCapUsd:250,
   tradeoff:'Reduces exposure but Pro normal demand exceeds both included pools.'},
  {id:'B-weight-policy',allowance:{ai:8000,connected:80000},instructionWeight:7,aiPeriodCapUsd:250,
   tradeoff:'Expensive policy work consumes more AI credits; connected exposure remains high.'},
  {id:'C-dollar-cap',allowance:{ai:8000,connected:80000},instructionWeight:3,aiPeriodCapUsd:100,
   tradeoff:'Prevents model-cost runaway but can pause with unused customer credits.'},
  {id:'D-earlier-buy-more',allowance:{ai:8000,connected:40000},instructionWeight:3,aiPeriodCapUsd:250,
   tradeoff:'Explicitly lowers included Connected Operations rather than quietly consuming paid packs first.'},
  {id:'E-combined',allowance:{ai:8000,connected:45000},instructionWeight:7,aiPeriodCapUsd:100,
   tradeoff:'Retains Pro normal AI capacity but its current five-minute multi-mailbox workload needs one connected pack.'},
  {id:'F-premium-sticker',allowance:{ai:8000,connected:80000},instructionWeight:7,aiPeriodCapUsd:100,
   priceUsd:1499,tradeoff:'Preserves normal Pro included usage but asks a materially higher monthly price; vulnerable to another connected-fee increase.'},
  {id:'G-premium-buffer',allowance:{ai:8000,connected:80000},instructionWeight:7,aiPeriodCapUsd:100,
   priceUsd:1699,tradeoff:'Preserves normal Pro included usage and a 20% connected-fee buffer, but the sticker price may suppress demand.'},
 ].map(option=>{
  const optionPrice=option.priceUsd||planPrices.pro.monthly;
  const weights={...CREDIT_WEIGHTS,instruction:option.instructionWeight};
  const mostExpensiveP95Credit=Math.max(...Object.entries(weights).map(([key,weight])=>model[key].p95/weight));
  const unguardedModelStress=option.allowance.ai*mostExpensiveP95Credit*2;
  const modelStress=Math.min(unguardedModelStress,option.aiPeriodCapUsd);
  const connectedStress=option.allowance.connected*a.connectedReserveUsdPerOperation*2.5;
  const infrastructureStress=renderForecast*4/a.projectedCustomerCount;
  const normalCredits=Object.entries(weights).reduce((sum,[key,weight])=>sum+proNormal.ai[key]*weight,0);
  const normalOps=connectedCount(proNormal.connected);
  const neededAi=Math.max(0,normalCredits-option.allowance.ai);
  const neededOps=Math.max(0,normalOps-option.allowance.connected);
  const aiPacks=packCoverage(neededAi,candidate.packs.filter(pack=>pack.category==='ai'));
  const connectedPacks=packCoverage(neededOps,candidate.packs.filter(pack=>pack.category==='connected'));
  const failedPolicyStress=proNormal.ai.failedInstructionAttempts*model.instruction.p95*2;
  const normalModelStress=Object.keys(weights).reduce((sum,key)=>sum+proNormal.ai[key]*model[key].p95,0)*2+
    failedPolicyStress;
  const normalInfrastructureStress=renderForecast*4/a.projectedCustomerCount+
    Math.max(0,proNormal.storageGb-a.storageBaselineGb)*a.monthlyDiskUsdPerGb*2+
    Math.max(0,proNormal.egressGb-a.monthlyEgressIncludedGb)*a.egressUsdPerGb*2;
  const normalRevenue=optionPrice+aiPacks.priceUsd+connectedPacks.priceUsd;
  const normalWithPacksStress=normalModelStress<=option.aiPeriodCapUsd?
    formula(normalRevenue,(aiPacks.purchases+connectedPacks.purchases)*a.paymentFeeFixedUsd,
      normalModelStress,normalOps*a.connectedReserveUsdPerOperation*2.5,
      normalInfrastructureStress,proNormal.systemEmails*a.systemEmailReserveUsdPerEmail*2):null;
  return {...option,mostExpensiveP95CreditUsd:money(mostExpensiveP95Credit),
   stressBreakdownUsd:{modelBeforeGuard:money(unguardedModelStress),modelAfterGuard:money(modelStress),
    connectedProviderReserve:money(connectedStress),sharedInfrastructure:money(infrastructureStress),
    failedPolicyAttemptsInNormalProfile:money(failedPolicyStress)},
   fullIncludedGuardedStress:formula(optionPrice,0,modelStress,connectedStress,infrastructureStress,0),
   sensitivityAboveGuardedStress:{connectedCostPlus20Percent:formula(optionPrice,0,
     modelStress,connectedStress*1.2,infrastructureStress,0),
    normalModelCostDoubledWouldPause:normalModelStress*2>option.aiPeriodCapUsd},
   proNormalCoverage:{aiCredits:normalCredits,connectedOperations:normalOps,
    aiFits:normalCredits<=option.allowance.ai,connectedFits:normalOps<=option.allowance.connected,
    hypotheticalAiPacks:aiPacks,hypotheticalConnectedPacks:connectedPacks,
    hypotheticalWithOptInPacksStress:normalWithPacksStress},
   firstGuardrailAtWorstPolicyMix:unguardedModelStress>option.aiPeriodCapUsd?'AI_DOLLAR_PERIOD_CAP':
    'INCLUDED_LIMIT_AT_FULL_USE'};
 });
 return {evidence:'MEASURED_MODEL_AND_PROJECTED_LOW_CONFIDENCE_COST_SCENARIOS',checkoutEnabled:false,
  pricesApproved:false,allowancesApproved:false,currency:'USD',modelSampleCount:Object.values(measurement.operations)
   .reduce((sum,row)=>sum+row.count,0),mailboxPollIntervalMinutes:5,mailboxPollsPerMonth:MAILBOX_POLLS_PER_MONTH,
  measuredModelCostPerAttempt:model,renderForecastUsd:renderForecast,
  assumptions:{...a,confidence:{model:'MEDIUM_EXPLORATORY_SYNTHETIC',connectedReserve:'LOW_OPERATOR_STRESS_ASSUMPTION',
   emailReserve:'LOW_OPERATOR_STRESS_ASSUMPTION',renderForecast:'MEDIUM_PROVIDER_PROJECTION_NOT_PAID_FULL_MONTH',
   storageAndEgress:'LOW_PROVIDER_DISPLAYED_UNIT_RATES_NO_TENANT_ALLOCATION',paymentFee:'LOW_SCENARIO_NOT_CONTRACT',
   planRevenue:'LOW_PROVISIONAL_LIST_NOT_ACTUAL_STRIPE_RECEIPT'}},
  candidate,profiles:monthly,fullAllowance,packs,proStressAlternatives:alternatives,
  limitations:['The $0.002 connected-operation reserve and $0.001 email reserve are configurable low-confidence stress assumptions, not measured provider bills.',
   'Render forecast is shared qualification infrastructure; ten customers and 4x capacity sensitivity are hypotheses, not validated capacity.',
   'Storage and egress unit estimates extrapolate displayed Render invoice rates; baseline included capacity is not a zero-cost claim.',
   'Subscription list prices and payment fees are provisional simulation inputs, never actual Stripe revenue or contracted fees.',
   'Full-allowance model mix uses the highest observed P95 per credit, not a verified hard worst-case cost.',
   'No production customer demand distribution or maximum-size model prompt cost has been observed.',
   'Unsupported or unconfigured connected services remain unavailable; they are simulated as possible future workloads only.']};
}
module.exports={build,PROFILES,CANDIDATE,DEFAULT_ASSUMPTIONS,MAILBOX_POLLS_PER_MONTH,connectedCount};
