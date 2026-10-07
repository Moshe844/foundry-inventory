'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const planner=require('../../src/assistant/postgres-capability-planner');

test('a single navigation request cannot produce two competing page jumps',async()=>{
  let attempts=0;
  const step=(capability)=>({capability,arguments:[],dependsOn:[],continuesPending:false});
  const provider={async complete({schemaName}){
    if(schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''}};
    attempts+=1;
    return {data:{steps:attempts===1?
      [step('navigate.connections'),step('navigate.settings')]:[step('navigate.connections')],
    clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,'Open the area for connected systems and settings.');
  assert.equal(attempts,2);
  assert.deepEqual(result.steps.map(({contract})=>contract.name),['navigate.connections']);
});
