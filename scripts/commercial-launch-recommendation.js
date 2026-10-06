'use strict';
const fs=require('node:fs');const path=require('node:path');
const model=require('../docs/commercial-model-cost-distribution-2026-10-05.json');
const render=require('../data/commercial-render-cost-evidence-2026-10-05.json');
const {build}=require('../src/commercial/launch-recommendation-simulation');
const {classified}=require('../src/commercial/provider-cost-responsibility');
const output={...build(model,render),providerCostClassification:classified()};
const destination=path.resolve(__dirname,'../docs/commercial-launch-recommendation-2026-10-05.json');
fs.writeFileSync(destination,JSON.stringify(output,null,2)+'\n');
process.stdout.write(JSON.stringify({destination,checkoutEnabled:output.checkoutEnabled,
 profiles:output.profiles.map(row=>({plan:row.plan,kind:row.kind,
  margin:row.currentEstimatedCostScenario.contributionMarginPercent,
  infrastructureUsd:row.infrastructure.totalUsd,buyMore:row.requiresOptInBuyMore})),
 guarded:output.guarded.map(row=>({plan:row.plan,current:row.fullAllowanceP95Stress.contributionMarginPercent,
  plus25:row.plus25PercentProviderAndInfrastructure.contributionMarginPercent,
  plus50:row.plus50PercentProviderAndInfrastructure.contributionMarginPercent,
  doubleExpensive:row.doubleExpensiveAiAndProvider.contributionMarginPercent})),
 packs:output.packs.map(row=>({category:row.category,units:row.units,priceUsd:row.priceUsd,
  plus50:row.plus50PercentCost.contributionMarginPercent,doubleExpensive:row.doubleExpensiveAiOrInfrastructure.contributionMarginPercent}))},null,2)+'\n');
