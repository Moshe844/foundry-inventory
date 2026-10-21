'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('only host-registered transports can reserve a single commercial attempt',()=>{
 const contract=require('../../src/commercial/provider-call-contract'),budget=require('../../src/commercial/model-cost-budget'),policy={maxOutputTokens:3000},request={prompt:'Unfamiliar source description'},untrusted={providerExecutions:1,commercialExecutions:1};
 assert.equal(contract.executions(untrusted),3);const trusted=contract.registerSingle({});assert.equal(contract.executions(trusted),1);assert.equal(contract.executions({...trusted}),3);
 const one=budget.estimateMaximumMinor(request,policy,1,2,contract.executions(trusted)),three=budget.estimateMaximumMinor(request,policy,1,2,contract.executions(untrusted));assert.equal(three.maximumMinor,one.maximumMinor*3);assert.equal(one.providerExecutions,1);assert.throws(()=>budget.estimateMaximumMinor(request,policy,1,2,0));
});
test('the registered Anthropic commercial transport makes one actual HTTP attempt on transient failure',async()=>{
 const previous=global.fetch;let calls=0;
 global.fetch=async()=>{calls++;return new Response(JSON.stringify({type:'error',error:{type:'overloaded_error',message:'Fixture transient failure'}}),{status:529,headers:{'content-type':'application/json'}});};
 try{const provider=require('../../src/ai/providers/anthropic').create({apiKey:'fixture-not-a-real-key',model:'fixture-model',effort:'none'});assert.equal(require('../../src/commercial/provider-call-contract').executions(provider),1);
  await assert.rejects(provider.complete({commercial:true,system:'Fixture',prompt:'Fixture',maxOutputTokens:3000,schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}));assert.equal(calls,1,'Both SDK retries and outer outlive retries must be disabled for metered requests');
 }finally{global.fetch=previous;}
});
