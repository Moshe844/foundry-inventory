'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('both actual native SDKs conclude repeated observations with consolidated retest facts and unchanged limits, offline',async()=>{
 const results=[];
 for(const candidate of ['openai','claude']){
  const r=await require('../../scripts/environment-agent-demo/offline-qualification').qualify(candidate,{mode:'retest-loop'});results.push(r);
  assert.equal(r.qualified,true,JSON.stringify(r));assert.equal(r.requests,7);
  assert.equal(r.businessCalls,1);assert.equal(r.browserCalls,5);assert.equal(r.unresolved,0);
  assert.equal(r.requestChecks.at(-1).final,true);assert.equal(r.requestChecks.at(-1).hasInventoryFacts,true);
  assert.equal(r.requestChecks.at(-1).consolidatedFacts,true);
  assert.equal(r.control.at(-1).reason,'REPEATED_UNCHANGED_EVIDENCE');
  assert.ok(r.requestChecks.every(c=>c.maxOutput===3000&&c.toolCount===8));
  if(candidate==='claude')assert.deepEqual(r.requestChecks[0].roles,['user','system']);
 }
 for(const candidate of ['openai','claude']){
  const r=await require('../../scripts/environment-agent-demo/offline-qualification').qualify(candidate,{mode:'last-turn'});results.push(r);
  assert.equal(r.qualified,true,JSON.stringify(r));assert.equal(r.requests,24);assert.equal(r.browserCalls,23);
  assert.equal(r.requestChecks.at(-1).final,true);assert.equal(r.control.at(-1).reason,'FINAL_TURN_RESERVED');
  assert.equal(r.unresolved,0);assert.ok(r.requestChecks.every(c=>c.maxOutput===3000&&c.toolCount===8));
 }
 const fs=require('node:fs'),path=require('node:path'),cert=require('../../scripts/environment-agent-demo/certification');
 fs.mkdirSync(cert.directory,{recursive:true});fs.writeFileSync(path.join(cert.directory,'protocol-loop-offline-demonstration.json'),JSON.stringify({
  sourceHash:cert.sourceHash(),checkedAt:new Date().toISOString(),results,paidCalls:0,
  limitation:'Actual SDKs and local PostgreSQL accounting; synthetic model replies and saved observations. This is not a live-model capability score.'},null,2));
});
