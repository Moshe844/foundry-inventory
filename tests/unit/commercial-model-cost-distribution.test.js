'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const raw=require('../../data/commercial-real-cost-simulation.json');
const {summarize,quantiles}=require('../../src/commercial/model-cost-distribution');
test('nearest-rank tails require enough real priced samples',()=>{
 assert.equal(quantiles([1,2,3]).p95Usd,null);
 assert.equal(quantiles(Array.from({length:20},(_,index)=>index+1)).p95Usd,19);
 const report=summarize(raw);
 assert.ok(report.operations.instruction.syntheticLongCatalogueProbeCount>=3);
 assert.ok(report.operations.instruction.syntheticLongCatalogueProbeMaxUsd>report.operations.instruction.medianUsd);
 assert.equal(report.operations.instruction.missingCostRates,0);
 assert.ok(report.operations.instruction.failedAttempts>0);
});
