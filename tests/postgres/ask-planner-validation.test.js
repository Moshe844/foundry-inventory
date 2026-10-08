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

test('a short answer to a pending action is judged against the original goal',async()=>{
  const original='Create a customer order for five valves for Northside, customer pickup.';
  const provider={async complete({schemaName,prompt,system}){
    const context=JSON.parse(prompt);
    if(schemaName==='stockchief_capability_plan'){
      assert.equal(context.pending.originalMessage,original);
      return {data:{steps:[{capability:'sales_order.create',arguments:[
        {name:'location',value:'Main Warehouse'}],dependsOn:[],continuesPending:true}],
      clarifyingQuestion:''}};
    }
    assert.equal(schemaName,'stockchief_capability_fit');
    assert.match(system,/short field answer need not restate the entire business action/);
    assert.equal(context.pendingRequest.originalMessage,original);
    assert.equal(context.pendingRequest.awaitingField,'location');
    assert.equal(context.proposedSteps[0].continuesPending,true);
    return {data:{aligned:true,reason:'The owner supplied the missing pickup location.'}};
  }};
  const result=await planner.plan(provider,'Use Main Warehouse.',{pending:{
    capability:'sales_order.create',args:{customer:'Northside',sku:'VALVE',quantity:5,
      deliveryMethod:'pickup'},question:'Which location will the customer pick this order up from?',
    originalMessage:original,status:'CLARIFY',awaitingField:'location'},
  history:[{message:original,answer:'Which location will the customer pick this order up from?',
    status:'CLARIFY'}]});
  assert.equal(result.steps[0].contract.name,'sales_order.create');
  assert.equal(result.steps[0].continuesPending,true);
});

test('fit rejects a draft-only answer to create-and-reserve and preserves verified recent records',async()=>{
  let plans=0;let fits=0;
  const recentChanges=[{action:'sales_order.create',summary:'Draft order SO-00002 for Eastside',
    record:{salesOrderId:'so_verified',orderNumber:'SO-00002'}}];
  const step=(capability,dependsOn=[])=>({capability,arguments:[],dependsOn,continuesPending:false});
  const provider={async complete({schemaName,prompt,system}){
    const context=JSON.parse(prompt);
    assert.deepEqual(context.recentChanges,recentChanges);
    if(schemaName==='stockchief_capability_fit'){
      fits+=1;assert.match(system,/ENTIRE current request/);
      return {data:{aligned:fits>1,reason:fits===1?'Reservation was omitted.':''}};
    }
    plans+=1;
    return {data:{steps:plans===1?[step('sales_order.create')]:
      [step('sales_order.create'),step('sales_order.confirm',[0])],clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,'Create an order for two valves and reserve them.',{recentChanges});
  assert.deepEqual(result.steps.map(({contract})=>contract.name),
    ['sales_order.create','sales_order.confirm']);
  assert.equal(fits,2);
});

test('an explicit reservation becomes a dependent approved step and invented per-unit money is removed',async()=>{
  const provider={async complete({schemaName}){
    if(schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''}};
    return {data:{steps:[{capability:'sales_order.create',arguments:[
      {name:'customer',value:'Northside'},{name:'sku',value:'Valve'},
      {name:'quantity',value:'2'},{name:'amount',value:'37'}],dependsOn:[],continuesPending:false}],
    clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,
    'Create a new order for 2 valves for Northside at the current price and reserve the stock.');
  assert.deepEqual(result.steps.map(({contract})=>contract.name),
    ['sales_order.create','sales_order.confirm']);
  assert.deepEqual(result.steps[1].dependsOn,[0]);
  assert.equal(Object.hasOwn(result.steps[0].args,'amount'),false);
});

test('a request to leave an order as draft never gains a reservation step',async()=>{
  const provider={async complete({schemaName}){
    if(schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''}};
    return {data:{steps:[{capability:'sales_order.create',arguments:[],dependsOn:[],
      continuesPending:false}],clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,
    'Create a draft customer order only. Do not reserve inventory yet.');
  assert.deepEqual(result.steps.map(({contract})=>contract.name),['sales_order.create']);
});

test('planner bounds stale conversation text while preserving the full current request',async()=>{
  const current='Create an order dated 2026-08-15 for four rolls and reserve the stock.';
  const provider={async complete({schemaName,prompt}){
    const context=JSON.parse(prompt);
    if(schemaName==='stockchief_capability_plan'){
      assert.equal(context.message,current);
      assert.equal(context.conversation.length,3);
      assert.ok(context.conversation.every((entry)=>entry.message.length<=260&&entry.answer.length<=180));
      return {data:{steps:[{capability:'sales_order.create',arguments:[],dependsOn:[],
        continuesPending:false}],clarifyingQuestion:''}};
    }
    return {data:{aligned:true,reason:''}};
  }};
  const history=Array.from({length:8},()=>({message:'M'.repeat(1000),answer:'A'.repeat(1000),status:'ANSWERED'}));
  const result=await planner.plan(provider,current,{history});
  assert.equal(result.steps.length,2);
});

test('a cost-bounded planner retries with a smaller catalogue and intact current goal',async()=>{
  let attempts=0;let firstLength=0;
  const provider={async complete({schemaName,system,prompt}){
    if(schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''}};
    attempts+=1;
    if(attempts===1){firstLength=system.length;throw Object.assign(new Error('cost bound'),{code:'rate_limited'});}
    assert.ok(system.length<firstLength);
    assert.equal(JSON.parse(prompt).message,'Create an order and reserve stock.');
    return {data:{steps:[{capability:'sales_order.create',arguments:[],dependsOn:[],
      continuesPending:false}],clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,'Create an order and reserve stock.');
  assert.equal(attempts,2);
  assert.deepEqual(result.steps.map(({contract})=>contract.name),
    ['sales_order.create','sales_order.confirm']);
});
