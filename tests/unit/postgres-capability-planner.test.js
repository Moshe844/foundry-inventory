'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const planner=require('../../src/assistant/postgres-capability-planner');

test('capability discovery remains compact while preserving action safety contracts',()=>{
  const catalogue=planner.planningCatalogue();
  assert.ok(planner.systemFor().length<24000,'A larger catalog can exceed Ask’s model-cost safety bound.');
  const contact=catalogue.mutations.find((entry)=>entry.name==='contact.create');
  assert.deepEqual(contact.required,['recipient','recipientKind']);
  assert.ok(contact.optional.includes('recipientEmail'));
  assert.ok(contact.resultingRecords.includes('suppliers'));
  assert.equal(catalogue.sharedContract.mutation.authority,'explicit approval');
  assert.equal(catalogue.sharedContract.mutation.verification,
    'resulting records checked in the approval transaction');
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
