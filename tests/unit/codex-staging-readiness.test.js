'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {verifyPricing}=require('../../src/assistant/codex-staging-readiness');
const profile=require('../../scripts/environment-agent-demo/codex-models').getProfile('sol-high');
const rates=()=>Object.entries(profile.rates).map(([operation,dollars])=>({operation,cost_per_unit_minor:dollars/10000,pricing_basis:'VERIFIED_PUBLIC'}));
test('the live missing-price defect fails deployment admission before any SDK/model startup',async()=>{
 await assert.rejects(verifyPricing({query:async()=>({rows:[]})}),{code:'STAGING_MODEL_PRICE_UNVERIFIED',operation:'model_input'});
});
test('all settlement and reservation rates must be verified and match the approved native profile',async()=>{
 for(const operation of Object.keys(profile.rates)){
  await assert.rejects(verifyPricing({query:async()=>({rows:rates().filter(r=>r.operation!==operation)})}),{code:'STAGING_MODEL_PRICE_UNVERIFIED',operation});
  await assert.rejects(verifyPricing({query:async()=>({rows:rates().map(r=>r.operation===operation?{...r,pricing_basis:'ESTIMATE'}:r)})}),{code:'STAGING_MODEL_PRICE_UNVERIFIED',operation});
  await assert.rejects(verifyPricing({query:async()=>({rows:rates().map(r=>r.operation===operation?{...r,cost_per_unit_minor:r.cost_per_unit_minor*2}:r)})}),{code:'STAGING_MODEL_PRICE_UNVERIFIED',operation});
 }
 assert.equal((await verifyPricing({query:async()=>({rows:rates()})})).pricingVerified,true);
});

test('verified decimal rates compare exactly at PostgreSQL NUMERIC precision and still reject a changed stored price',async()=>{
 const profile=require('../../scripts/environment-agent-demo/codex-models').getProfile('sol-low-ultrafast');
 const rows=Object.entries(profile.rates).map(([operation,dollars])=>({operation,cost_per_unit_minor:(dollars/10000).toFixed(8),pricing_basis:'VERIFIED_PUBLIC'}));
 assert.equal((await verifyPricing({query:async()=>({rows})},profile)).pricingVerified,true);
 const changed=rows.map(row=>row.operation==='cache_read'?{...row,cost_per_unit_minor:(Number(row.cost_per_unit_minor)+.00000001).toFixed(8)}:row);
 await assert.rejects(verifyPricing({query:async()=>({rows:changed})},profile),{code:'STAGING_MODEL_PRICE_UNVERIFIED',operation:'cache_read'});
});
