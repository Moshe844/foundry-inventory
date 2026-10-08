'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const planner=require('../../src/assistant/postgres-capability-planner');
const {registry}=require('../../src/assistant/postgres-capability-registry');
const control=require('../../src/assistant/postgres-control-plane');

test('a dependent order read can answer exact quantities after an approved write',async()=>{
  const provider={complete:async()=>{throw new Error('Exact post-action order evidence does not need a model guess.');}};
  const rows=[{order:'SO-00008',orderedUnits:2,fulfilledUnits:1,heldUnits:1,
    openUnits:1,invoiced:'$0.75',paid:'$0.00',outstanding:'$0.75'}];
  const answered=await control.synthesizeReads(provider,
    'Fulfill one unit and tell me the order’s fulfilled and committed quantities.',
    [{step:{contract:registry.get('read.sales_orders')},args:{search:'SO-00008'},
      result:{status:'ANSWERED',answer:'1 customer order matched; 1 units remain open.',rows,
        columns:Object.keys(rows[0])}}],{completedActions:[{capability:'sales_order.fulfill',
        recordReference:'SO-00008',status:'EXECUTED'}]});
  assert.equal(answered[0].result.answer,
    'SO-00008: 2 ordered, 1 fulfilled, 1 still held; $0.75 invoiced, $0.00 paid, $0.75 outstanding.');
  assert.equal(answered[0].result.status,'ANSWERED');
});

test('a failed broad plan can retry against the actual named record’s capabilities',async()=>{
  const database={query:async(sql)=>({rows:/FROM sales_orders\s/i.test(sql)?[{'?column?':1}]:[]})};
  const focused=await control.focusedRecordCatalogue(database,{workspaceId:'one'},
    'Reserve all stock for SO-00007',registry);
  assert.ok(focused.get('sales_order.reserve_all'));
  assert.ok(focused.get('sales_order.confirm'));
  assert.ok(focused.get('read.sales_orders'));
  assert.equal(focused.get('purchase_order.approve'),null);
});

test('capability discovery remains compact while preserving action safety contracts',()=>{
  const catalogue=planner.planningCatalogue();
  assert.ok(planner.systemFor().length<24000,'A larger catalog can exceed Ask’s model-cost safety bound.');
  const contact=catalogue.mutations.find((entry)=>entry.n==='contact.create');
  assert.ok(contact,'contact creation is discoverable');
  assert.ok(contact.a.includes('recipient'));
  assert.ok(contact.a.includes('recipientKind'));
  assert.ok(contact.a.includes('recipientEmail'));
  const contract=registry.get('contact.create');
  assert.deepEqual(contract.required,['recipient','recipientKind']);
  assert.ok(contract.description.toLowerCase().includes('supplier'));
  assert.match(planner.systemFor(),/approval/i);
  assert.match(planner.systemFor(),/resolver verifies unique records/i);
  assert.match(registry.get('sales_order.create').description,/price PER UNIT/);
  assert.match(registry.get('purchase_order.create').description,/cost PER UNIT/);
  for(const [name,label] of [['navigate.accounting','Money'],['navigate.warehouse','Warehouse'],
    ['navigate.shipping','Shipping setup']]){
    const destination=catalogue.navigation.find((entry)=>entry.n===name);
    assert.match(destination.d,new RegExp(label),`${name} must have a distinct destination label`);
  }
});

test('an explicit per-unit quote survives a model typo and cannot fall back to a stale supplier price',()=>{
  const selected=planner.parseSteps({steps:[{capability:'purchase_order.create',arguments:[
    {name:'supplier',value:'Lab Copper Supply'},{name:'sku',value:'LAB-CE-100'},
    {name:'quantity',value:'20'},{name:'amount',value:'2.50'}],dependsOn:[],continuesPending:false}]});
  planner.groundedMoneyArguments(selected.steps,
    'Prepare a draft PO for 20 LAB-CE-100 from Lab Copper Supply at $2.40 each.');
  assert.equal(selected.steps[0].args.amount,'2.4');
});

test('a complete-order reservation stays one dependent step, not a duplicate partial confirmation',()=>{
  const planned=planner.parseSteps({steps:[
    {capability:'sales_order.create',arguments:[{name:'customer',value:'Field Buyer'},
      {name:'sku',value:'LAB-WASH-030'},{name:'quantity',value:'2'}],dependsOn:[],continuesPending:false},
    {capability:'sales_order.reserve_all',arguments:[],dependsOn:[0],continuesPending:false}],
    clarifyingQuestion:''});
  planner.coverExplicitOrderReservation(planned.steps,'Create an order, then fully reserve both units.',registry);
  assert.deepEqual(planned.steps.map((step)=>step.contract.name),
    ['sales_order.create','sales_order.reserve_all']);
  const createOnly=planner.parseSteps({steps:[{capability:'sales_order.create',arguments:[],
    dependsOn:[],continuesPending:false}],clarifyingQuestion:''});
  planner.coverExplicitOrderReservation(createOnly.steps,
    'Create the order and reserve all units.',registry);
  assert.equal(createOnly.steps[1].contract.name,'sales_order.reserve_all');
  const partial=planner.parseSteps({steps:[
    {capability:'sales_order.create',arguments:[],dependsOn:[],continuesPending:false},
    {capability:'sales_order.confirm',arguments:[],dependsOn:[0],continuesPending:false}],
    clarifyingQuestion:''});
  planner.coverExplicitOrderReservation(partial.steps,
    'Create the order, then fully reserve both units.',registry);
  assert.deepEqual(partial.steps.map((step)=>step.contract.name),
    ['sales_order.create','sales_order.reserve_all']);
});

test('full-reservation intent reaches independent fit as the strict dependent action',async()=>{
  const provider={complete:async(request)=>{
    if(request.schemaName==='stockchief_capability_plan')return {data:{steps:[
      {capability:'sales_order.create',arguments:[{name:'customer',value:'Field Buyer'},
        {name:'sku',value:'LAB-WASH-030'},{name:'quantity',value:'2'},
        {name:'deliveryMethod',value:'PICKUP'},{name:'location',value:'Main Warehouse'}],
      dependsOn:[],continuesPending:false},
      {capability:'sales_order.confirm',arguments:[],dependsOn:[0],continuesPending:false}],
      clarifyingQuestion:''}};
    if(request.schemaName==='stockchief_capability_fit'){
      const steps=JSON.parse(request.prompt).proposedSteps;
      assert.equal(steps[1].capability,'sales_order.reserve_all');
      return {data:{aligned:true,reason:''}};
    }
    throw new Error(`Unexpected model stage ${request.schemaName}`);
  }};
  const selected=await planner.plan(provider,
    'Create a pickup order for two washers, then fully reserve both units.');
  assert.deepEqual(selected.steps.map((step)=>step.contract.name),
    ['sales_order.create','sales_order.reserve_all']);
});

test('fit sees post-approval read dependencies and clears impossible pending flags',async()=>{
  const provider={complete:async(request)=>{
    if(request.schemaName==='stockchief_capability_plan')return {data:{steps:[
      {capability:'sales_order.fulfill',arguments:[{name:'recordReference',value:'SO-00008'},
        {name:'sku',value:'LAB-WASH-030'},{name:'quantity',value:'1'}],dependsOn:[],continuesPending:false},
      {capability:'read.sales_orders',arguments:[{name:'search',value:'SO-00008'}],
        dependsOn:[0],continuesPending:true}],clarifyingQuestion:''}};
    const candidate=JSON.parse(request.prompt);
    assert.deepEqual(candidate.proposedSteps[1].dependsOn,[0]);
    assert.equal(candidate.proposedSteps[1].continuesPending,false);
    assert.match(candidate.proposedSteps[1].description,/fulfilled and open units/);
    assert.match(request.system,/AFTER approval/);
    return {data:{aligned:true,reason:''}};
  }};
  const selected=await planner.plan(provider,
    'Fulfill one unit on SO-00008, then tell me its ordered, fulfilled and held quantities.');
  assert.deepEqual(selected.steps.map((step)=>step.contract.name),
    ['sales_order.fulfill','read.sales_orders']);
});

test('daily model-attempt ceiling is not mistaken for a prompt-cost failure or retried',async()=>{
  let calls=0;
  const provider={async complete(){calls++;const error=new Error('Daily model-attempt safety limit reached.');
    error.code='rate_limited';error.limitKind='daily_model_attempts';throw error;}};
  await assert.rejects(planner.plan(provider,'What stock do I have?'),
    (error)=>error.limitKind==='daily_model_attempts');
  assert.equal(calls,1);
});

for(const initial of ['read.suppliers','communication.send_email'])test(`semantic fit check rejects ${initial} when it misses the current goal`,async()=>{
  const schemas=[];let planCalls=0;let fitCalls=0;
  const provider={async complete(request){schemas.push(request.schemaName);
    if(request.schemaName==='stockchief_capability_plan'){
      planCalls++;
      return {data:{steps:[{capability:planCalls===1?initial:'read.inventory_summary',
        arguments:[],dependsOn:[],continuesPending:planCalls===1&&initial==='communication.send_email'}],clarifyingQuestion:''}};
    }
    if(request.schemaName==='stockchief_capability_fit'){
      fitCalls++;
      return {data:{aligned:fitCalls===2,reason:fitCalls===1?'That plan discusses a different record type.':''}};
    }
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'Can you check what we have on hand now?',{
    pending:{capability:'communication.send_email',args:{recipient:'Someone'},
      question:'What should the email say?',awaitingField:'body'}});
  assert.equal(result.steps[0].contract.name,'read.inventory_summary');
  assert.deepEqual(schemas,['stockchief_capability_plan','stockchief_capability_fit',
    'stockchief_capability_plan','stockchief_capability_fit']);
});

test('first-turn creation cannot be accepted as a supplier lookup after fit rejection',async()=>{
  let plans=0;
  const provider={async complete(request){
    if(request.schemaName==='stockchief_capability_plan'){
      plans++;
      return {data:{steps:[{capability:plans===1?'read.suppliers':'contact.create',
        arguments:plans===1?[]:[{name:'recipient',value:'North Supply'},
          {name:'recipientKind',value:'supplier'},{name:'recipientEmail',value:'north@example.test'}],
        dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
    }
    if(request.schemaName==='stockchief_capability_fit')
      return {data:{aligned:plans===2,reason:plans===1?'A lookup does not add a contact.':''}};
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'Please add North Supply to my contacts as a supplier.',{});
  assert.equal(result.steps[0].contract.name,'contact.create');
  assert.equal(result.steps[0].args.recipientEmail,'north@example.test');
});

test('a no-step reply cannot steer an unsupported goal into a different operation',async()=>{
  const provider={async complete(request){
    if(request.schemaName==='stockchief_capability_plan')return {data:{steps:[],
      clarifyingQuestion:'To record a payment, which bill was already paid?'}};
    if(request.schemaName==='stockchief_capability_fit')return {data:{aligned:false,
      reason:'Recording a completed event differs from initiating it.'}};
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'Arrange for the money to actually leave our bank account.');
  assert.deepEqual(result.steps,[]);
  assert.match(result.clarifyingQuestion,/could not safely match/i);
  assert.doesNotMatch(result.clarifyingQuestion,/record a payment/i);
});

test('an initial no-step miss can recover an exact registered read only after independent fit',async()=>{
  let plans=0;let fits=0;
  const provider={async complete(request){
    if(request.schemaName==='stockchief_capability_plan'){
      plans++;
      return {data:{steps:plans===1?[]:[{capability:'read.inventory',arguments:[],
        dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
    }
    if(request.schemaName==='stockchief_capability_fit'){
      fits++;
      return {data:{aligned:true,reason:''}};
    }
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'How many units are on hand across my inventory?',
    {deferReadFit:true});
  assert.equal(result.steps[0].contract.name,'read.inventory');
  assert.equal(plans,2);
  assert.equal(fits,1,'a recovered read cannot bypass the independent semantic check');
});

test('independent fit receives verified page identity for a current-product policy',async()=>{
  const page={path:'/inventory/item_verified',product:'Rule Widget',sku:'RULE-1'};
  const provider={async complete(request){
    if(request.schemaName==='stockchief_capability_plan')return {data:{steps:[{
      capability:'policy.propose',arguments:[],dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
    if(request.schemaName==='stockchief_capability_fit'){
      const candidate=JSON.parse(request.prompt);
      assert.deepEqual(candidate.currentPage,page);
      assert.equal(candidate.proposedSteps[0].inputMode,'full_owner_message');
      return {data:{aligned:true,reason:''}};
    }
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'Set the reorder point to 4 for this product.',{page});
  assert.equal(result.steps[0].contract.name,'policy.propose');
});

test('a tentative read cannot replace a requested change when semantic fit rejects it',async()=>{
  let plans=0;let fits=0;
  const provider={async complete(request){
    if(request.schemaName==='stockchief_capability_plan'){
      plans++;
      return {data:{steps:[{capability:plans===1?'read.sales_orders':'sales_order.confirm',
        arguments:plans===1?[]:[{name:'recordReference',value:'SO-00001'}],
        dependsOn:[],continuesPending:false}],clarifyingQuestion:plans===1?'Need to verify the order state.':''}};
    }
    if(request.schemaName==='stockchief_capability_fit'){
      fits++;
      return {data:{aligned:fits===2,reason:fits===1?'A read does not reserve stock.':''}};
    }
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'Commit available stock to SO-00001.',{deferReadFit:true});
  assert.equal(result.steps[0].contract.name,'sales_order.confirm');
  assert.equal(plans,2);
  assert.equal(fits,2);
});

test('independent fit treats this inventory as the authenticated workspace',async()=>{
  const workspace={business_name:'Current Business',location_count:1,product_count:2,purchase_order_count:0};
  const provider={async complete(request){
    if(request.schemaName==='stockchief_capability_plan')return {data:{steps:[{
      capability:'workspace.rename',arguments:[{name:'workspaceName',value:'New Business'}],
      dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
    if(request.schemaName==='stockchief_capability_fit'){
      assert.deepEqual(JSON.parse(request.prompt).currentWorkspace,workspace);
      return {data:{aligned:true,reason:''}};
    }
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'Rename this inventory to New Business.',{workspace});
  assert.equal(result.steps[0].contract.name,'workspace.rename');
});

test('semantic review repairs a plan that drops an explicitly named entity',async()=>{
  let plans=0;
  const provider={async complete(request){
    if(request.schemaName==='stockchief_capability_plan'){
      plans++;
      return {data:{steps:[{capability:'inventory.receive',arguments:plans===1?
        [{name:'quantity',value:'4'}]:[{name:'sku',value:'Brass Hinge'},{name:'quantity',value:'4'}],
        dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
    }
    if(request.schemaName==='stockchief_capability_fit')return {data:{aligned:plans===2,
      reason:plans===1?'The product named by the owner was omitted.':''}};
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'Four Brass Hinges just arrived.');
  assert.equal(result.steps[0].args.sku,'Brass Hinge');
});

test('semantic review does not inherit a pending question for an independent request',async()=>{
  let reviewed=null;
  const provider={async complete(request){
    if(request.schemaName==='stockchief_capability_plan')return {data:{steps:[{
      capability:'navigate.purchasing',arguments:[],dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
    if(request.schemaName==='stockchief_capability_fit'){
      reviewed=JSON.parse(request.prompt);
      return {data:{aligned:true,reason:''}};
    }
    throw new Error(`Unexpected request ${request.schemaName}`);
  }};
  const result=await planner.plan(provider,'Open Purchasing.',{pending:{
    capability:'contact.create',args:{recipient:'Old Supplier'},question:'Should I add that supplier?'}});
  assert.equal(result.steps[0].contract.name,'navigate.purchasing');
  assert.equal(reviewed.pendingRequest,null);
});
