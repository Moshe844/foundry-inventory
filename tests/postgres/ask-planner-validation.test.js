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

test('a cost-bounded semantic repair uses the compact catalogue and still verifies every effect',async()=>{
  let plans=0;let firstRepairLength=0;let fitChecks=0;
  const provider={async complete({schemaName,system,prompt}){
    if(schemaName==='stockchief_capability_fit'){
      fitChecks++;
      return {data:{aligned:fitChecks>1,reason:fitChecks===1?'Reservation was omitted.':''}};
    }
    plans++;
    if(plans===2){firstRepairLength=system.length;
      throw Object.assign(new Error('cost bound'),{code:'rate_limited'});}
    if(plans===3){assert.ok(system.length<firstRepairLength);
      assert.match(JSON.parse(prompt).message,/create.*reserve/i);}
    return {data:{steps:[{capability:'sales_order.create',arguments:[],dependsOn:[],continuesPending:false}],
      clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,'Create an order and reserve stock.');
  assert.equal(plans,3);
  assert.equal(fitChecks,2);
  assert.deepEqual(result.steps.map((step)=>step.contract.name),['sales_order.create','sales_order.confirm']);
});

test('consequential writes in one instruction wait for earlier approved writes',async()=>{
  const provider={async complete({schemaName}){
    if(schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''}};
    return {data:{steps:[
      {capability:'catalog.set_price',arguments:[{name:'sku',value:'HG-400'},
        {name:'amount',value:'14.50'}],dependsOn:[],continuesPending:false},
      {capability:'sales_order.create',arguments:[{name:'sku',value:'HG-400'},
        {name:'customer',value:'Eastside'},{name:'quantity',value:'5'}],dependsOn:[],continuesPending:false},
    ],clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,
    'Set the HG-400 selling price to $14.50, create an Eastside order for five and reserve them.');
  assert.deepEqual(result.steps.map((step)=>step.contract.name),
    ['catalog.set_price','sales_order.create','sales_order.confirm']);
  assert.deepEqual(result.steps.map((step)=>step.dependsOn),[[],[0],[1]]);
});

test('a twice-rejected fast plan gets one compact, independently verified registry replan',async()=>{
  let fastPlans=0,strongFits=0;
  const step=(capability)=>({capability,arguments:[],dependsOn:[],continuesPending:false});
  const fast={async complete({schemaName,prompt}){
    if(schemaName==='stockchief_capability_fit')return {
      data:{aligned:false,reason:'A catalogue write cannot create the requested customer order.'}};
    fastPlans++;
    return {data:{steps:[step(JSON.parse(prompt).validationErrors?.[0]?.independentReason
      ?'sales_order.create':'catalog.create_item')],clarifyingQuestion:''}};
  }};
  const independent={async complete({schemaName,prompt}){
    if(schemaName==='stockchief_capability_fit'){
      strongFits++;
      const names=JSON.parse(prompt).proposedSteps.map((row)=>row.capability);
      return {data:{aligned:names.length===1&&names[0]==='sales_order.create',
        reason:names[0]==='sales_order.create'?'':'Wrong business effect.'}};
    }
    throw new Error('A full-registry stronger-model replan should not bypass the cost bound.');
  }};
  const result=await planner.plan(fast,'Create a customer order for a new account.',
    {verificationProvider:independent});
  assert.deepEqual(result.steps.map((row)=>row.contract.name),['sales_order.create']);
  assert.equal(fastPlans,3);assert.equal(strongFits,3);
});

test('duplicate state-transition proposals collapse to one dependent approval',async()=>{
  const step=(capability,dependsOn=[])=>({capability,arguments:[],dependsOn,continuesPending:false});
  const provider={async complete({schemaName,prompt}){
    if(schemaName==='stockchief_capability_fit'){
      const proposed=JSON.parse(prompt).proposedSteps;
      assert.deepEqual(proposed.map((row)=>row.capability),
        ['sales_order.create','sales_order.reserve_all']);
      assert.deepEqual(proposed[1].dependsOn,[0]);
      return {data:{aligned:true,reason:''}};
    }
    return {data:{steps:[step('sales_order.create'),step('sales_order.reserve_all',[0]),
      step('sales_order.reserve_all',[1])],clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,
    'Create an order for sixteen washers and reserve all sixteen.');
  assert.deepEqual(result.steps.map((row)=>row.contract.name),
    ['sales_order.create','sales_order.reserve_all']);
});

test('distinct targets and repeatable financial movements are not silently collapsed',()=>{
  const catalogue=require('../../src/assistant/postgres-capability-registry').registry;
  const steps=[
    {contract:catalogue.get('sales_order.reserve_all'),args:{recordReference:'SO-1'},dependsOn:[],continuesPending:false},
    {contract:catalogue.get('sales_order.reserve_all'),args:{recordReference:'SO-2'},dependsOn:[],continuesPending:false},
    {contract:catalogue.get('supplier_payment.record'),args:{amount:'5'},dependsOn:[],continuesPending:false},
    {contract:catalogue.get('supplier_payment.record'),args:{amount:'5'},dependsOn:[],continuesPending:false},
  ];
  planner.collapseRepeatedEffects(steps);
  assert.equal(steps.length,4);
});
