'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {build}=require('../src/commercial/readiness-simulation');
const root=path.resolve(__dirname,'..');
function read(relative){const raw=fs.readFileSync(path.join(root,relative));return {data:JSON.parse(raw),
 source:{path:relative,sha256:crypto.createHash('sha256').update(raw).digest('hex')}};}
function main(){
 const measured=read('docs/commercial-model-cost-distribution-2026-10-05.json');
 const render=read('data/commercial-render-cost-evidence-2026-10-05.json');
 const result={generatedAt:new Date().toISOString(),sources:[measured.source,render.source],
  ...build({measurement:measured.data,renderEvidence:render.data})};
 const destination=path.join(root,'docs/commercial-readiness-simulation-2026-10-05.json');
 fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({destination,checkoutEnabled:result.checkoutEnabled,
  profiles:result.profiles.map(row=>({id:row.id,aiCredits:row.aiCredits,connectedOperations:row.connectedOperations,
   withinIncludedAllowance:row.withinIncludedAllowance,monthlyModelUsd:row.projectedModelCostAtMeasuredMedianUsd,
   projectedMarginPercent:row.monthlyListScenario?.projectedMarginPercent??null,
   optInBuyMoreMarginPercent:row.hypotheticalOptInBuyMoreScenario?.projectedMarginPercent??null,
   stressMarginPercent:row.stressScenario2xModel2_5xConnected4xSharedHosting?.projectedMarginPercent??null,
   optInBuyMoreStressMarginPercent:row.hypotheticalOptInBuyMoreStressScenario?.projectedMarginPercent??null})),
  fullAllowance:result.fullAllowance.map(row=>({plan:row.plan,margin:row.monthlyScenario.projectedMarginPercent,
   stressMargin:row.sensitivity2xModel2_5xConnected4xHosting.projectedMarginPercent}))},null,2));
}
if(require.main===module)main();module.exports={main};
