'use strict';
const {ValidationError}=require('../domain/errors');
const OPERATIONS=['ask','instruction','import_mapping'];
function quantiles(values){const sorted=[...values].sort((a,b)=>a-b);const at=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
 return {count:sorted.length,typicalUsd:sorted.length?at(.5):null,medianUsd:sorted.length?at(.5):null,
  p90Usd:sorted.length>=10?at(.9):null,p95Usd:sorted.length>=20?at(.95):null,
  mostExpensiveUsd:sorted.length?sorted.at(-1):null};}
function summarize(evidence){if(evidence?.evidence!=='REAL_MODEL_USAGE_WITH_MODELED_MONTHLY_PROFILES'||
 evidence.checkoutEnabled!==false)throw new ValidationError('A closed-checkout real-model measurement is required.');
 const plans=evidence.profiles.filter(profile=>['starter','growth','pro'].includes(profile.plan));
 if(plans.length!==3||new Set(plans.map(profile=>profile.plan)).size!==3)
  throw new ValidationError('Measure Starter, Growth and Pro before computing a distribution.');
 const operations={};
 for(const operation of OPERATIONS){const samples=plans.flatMap(profile=>(profile.measured?.[operation]?.sampleCosts||[])
   .map(sample=>({...sample,plan:profile.plan})));
  if(samples.some(sample=>sample.costUsd!==null&&(!Number.isFinite(sample.costUsd)||sample.costUsd<0)))
   throw new ValidationError('Model sample costs must be explicit non-negative amounts.');
  const backed=samples.filter(sample=>sample.modelBacked);
  const known=backed.filter(sample=>sample.costUsd!==null&&!sample.missingRate);
  const missing=backed.length-known.length;
  const models=[...new Set(plans.flatMap(profile=>(profile.costRows||[]).filter(row=>row.detail?.operation===operation)
   .map(row=>`${row.provider}/${row.model}/${row.provider_version}`)))].sort();
  const committedCredits=plans.reduce((sum,profile)=>sum+Number(profile.measured?.[operation]?.committedCredits||0),0);
  const totalKnownCostUsd=known.reduce((sum,sample)=>sum+sample.costUsd,0);
  const longCatalogue=known.filter(sample=>sample.syntheticLongCatalogue);
  operations[operation]={...quantiles(known.map(sample=>sample.costUsd)),attempts:samples.length,
   modelBackedAttempts:backed.length,failedAttempts:samples.filter(sample=>sample.outcome==='FAILED').length,
   syntheticLongCatalogueProbeCount:longCatalogue.length,
   syntheticLongCatalogueProbeMaxUsd:longCatalogue.length?Math.max(...longCatalogue.map(sample=>sample.costUsd)):null,
   deterministicOnly:samples.filter(sample=>sample.outcome==='DETERMINISTIC_ONLY').length,
   missingCostRates:missing,models,committedCredits,
   costUsdPerCommittedCredit:missing||!committedCredits?null:totalKnownCostUsd/committedCredits,
   totalMeasuredCostUsd:missing?null:totalKnownCostUsd,
   perPlan:Object.fromEntries(plans.map(profile=>{const rows=samples.filter(sample=>sample.plan===profile.plan&&sample.modelBacked);
    const priced=rows.filter(sample=>sample.costUsd!==null&&!sample.missingRate);
    return [profile.plan,{...quantiles(priced.map(sample=>sample.costUsd)),attempts:rows.length,
      failedAttempts:rows.filter(sample=>sample.outcome==='FAILED').length}];}))};
 }
 return {evidence:'REAL_MODEL_COST_DISTRIBUTION',checkoutEnabled:false,generatedFrom:evidence.generatedAt,
  sampleLimitations:['Synthetic catalogue and requests, not observed customer mix.',
   'Nearest-rank P95 from 21-24 model-backed attempts per operation is exploratory, not an SLA or tail guarantee.',
   `${operations.instruction.syntheticLongCatalogueProbeCount} long-catalogue Pro instruction probes deliberately stress the observed tail; this is not a production percentile.`,
   'Failed model-backed attempts incur cost even when customer credits reverse.',
   'Provider API price/version is dated and must be reverified before paid launch.'],operations};
}
module.exports={summarize,quantiles};
