'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('legacy planning and independent fit verification receive the same scoped conversation record arguments',async()=>{
 const history=[{message:'How much of valve K-28 is on hand?',answer:'There are 9 units.',status:'ANSWERED',intent:{controlPlane:{capability:'read.inventory',args:{search:'K-28'}}}}],calls=[];
 const provider={complete:async request=>{
  calls.push(request.schemaName);const context=JSON.parse(request.prompt);
  assert.equal(context.conversation[0].arguments.search,'K-28');assert.equal(context.conversation[0].capability,'read.inventory');
  if(request.schemaName==='stockchief_capability_plan')return{data:{steps:[{capability:'read.inventory_positions',arguments:[{name:'search',value:'K-28'}],dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
  assert.equal(request.schemaName,'stockchief_capability_fit');return{data:{aligned:true,reason:'The follow-up asks for locations of the uniquely identified prior product.'}};
 }};
 const result=await require('../../src/assistant/postgres-capability-planner').plan(provider,'And where are those kept?',{history});
 assert.deepEqual(calls,['stockchief_capability_plan','stockchief_capability_fit']);assert.equal(result.steps[0].contract.name,'read.inventory_positions');assert.equal(result.steps[0].args.search,'K-28');
});
test('a supplied message survives capitalization and whitespace normalization as a dependent draft',async()=>{
 const provider={complete:async request=>request.schemaName==='stockchief_capability_fit'?{data:{aligned:true,reason:'Both requested effects are retained.'}}:{data:{steps:[
  {capability:'contact.create',arguments:[{name:'recipient',value:'Copper Parts'},{name:'recipientKind',value:'supplier'},{name:'recipientEmail',value:'copper@example.test'}],dependsOn:[],continuesPending:false},
  {capability:'communication.send_email',arguments:[{name:'body',value:'Please confirm the delivery date.'}],dependsOn:[0],continuesPending:false}],clarifyingQuestion:''}}};
 const result=await require('../../src/assistant/postgres-capability-planner').plan(provider,'Add Copper Parts as a supplier at copper@example.test, then draft an email saying please   confirm the delivery date.');
 assert.deepEqual(result.steps.map(step=>step.contract.name),['contact.create','communication.send_email']);assert.deepEqual(result.steps[1].dependsOn,[0]);
});
test('planning preflights the existing price bound and reduces its output reservation without losing the current goal or record arguments',async()=>{
 const planner=require('../../src/assistant/postgres-capability-planner'),full=planner.systemFor(),history=[{message:'Earlier product lookup',answer:'A recorded result',status:'ANSWERED',intent:{controlPlane:{capability:'read.inventory',args:{search:'PART-87'}}}}];let checks=0;
 const provider={promptByteAllowance:async request=>{checks++;return request.maxOutputTokens<=1500?20000:0;},complete:async request=>{
  const context=JSON.parse(request.prompt);
  if(request.schemaName==='stockchief_capability_plan'){
   assert.equal(request.maxOutputTokens,1500);assert.equal(context.message,'Where is that stock?');assert.equal(context.conversation[0].arguments.search,'PART-87');
   return{data:{steps:[{capability:'read.inventory_positions',arguments:[{name:'search',value:'PART-87'}],dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
  }return{data:{aligned:true,reason:'The same product is read with current evidence.'}};
 }};
 const result=await planner.plan(provider,'Where is that stock?',{history});assert.equal(result.steps.length,1);assert(checks>=2);
});
