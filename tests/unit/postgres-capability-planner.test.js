'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const planner=require('../../src/assistant/postgres-capability-planner');
const {registry}=require('../../src/assistant/postgres-capability-registry');

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
  assert.equal(reviewed.pendingQuestion,null);
});
