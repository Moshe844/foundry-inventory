'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {Registry,registry}=require('../../src/assistant/postgres-capability-registry');
const planner=require('../../src/assistant/postgres-capability-planner');
const resolver=require('../../src/assistant/postgres-context-resolver');
const {destinationById}=require('../../src/web/postgres-navigation');

test('the planner contract grows from a registered capability, not a sentence list',()=>{
  const catalogue=new Registry();
  catalogue.register({name:'inventory.cycle_count',description:'Create a cycle count for a bounded inventory location.',
    kind:'mutation',permission:'COUNT_STOCK',confirmation:'owner_review',fields:['location'],
    authority:{mode:'explicit_approval'},resultingRecords:['cycle_counts'],validate:()=>true,
    prepare:async()=>({status:'PREPARED'}),verify:async()=>true,execute:async()=>({id:'count'}),
    verifyExecution:async()=>true});
  const names=planner.schemaFor(catalogue).properties.steps.items.properties.capability.enum;
  assert.deepEqual(names,['inventory.cycle_count']);
  assert.match(planner.systemFor(catalogue),/Create a cycle count/);
  assert.equal(planner.parseSteps({steps:[{capability:'inventory.cycle_count',arguments:[
    {name:'location',value:'North Warehouse'}],dependsOn:[],continuesPending:false}],clarifyingQuestion:''},
  catalogue).steps[0].args.location,'North Warehouse');
  assert.equal(planner.parseSteps({steps:[{capability:'inventory.cycle_count',arguments:[
    {name:'supplier',value:'Outside field'}],dependsOn:[],continuesPending:false}],clarifyingQuestion:''},
  catalogue).steps.length,0);
});

test('every registered mutation has a deterministic executor and result verifier',()=>{
  for(const contract of registry.list('mutation')){
    assert.equal(typeof contract.execute,'function',contract.name);
    assert.equal(typeof contract.verifyExecution,'function',contract.name);
    assert.ok(contract.permission,contract.name);
    assert.ok(contract.confirmation,contract.name);
  }
});

test('planner repairs arguments against the selected capability schema, not a wording pattern',async()=>{
  const plans=[
    {steps:[{capability:'inventory.receive',arguments:[{name:'search',value:'Brass Hinge'}],
      dependsOn:[],continuesPending:false}],clarifyingQuestion:''},
    {steps:[{capability:'inventory.receive',arguments:[{name:'sku',value:'Brass Hinge'},
      {name:'quantity',value:'4'}],dependsOn:[],continuesPending:false}],clarifyingQuestion:''},
  ];
  const prompts=[];
  const provider={async complete(request){prompts.push(JSON.parse(request.prompt));return {data:plans.shift()};}};
  const selected=await planner.plan(provider,'unseen owner wording',{workspace:{business_name:'Test'}});
  assert.equal(selected.steps[0].args.sku,'Brass Hinge');
  assert.equal(selected.steps[0].args.quantity,'4');
  assert.deepEqual(prompts[1].validationErrors,[{capability:'inventory.receive',
    invalidInput:'search',allowedInputs:registry.get('inventory.receive').fields}]);
});

test('typed context resolution fills a unique valid location independent of wording',async()=>{
  const database={async query(statement){
    if(statement.includes('FROM locations'))return {rows:[{value:'North Room',label:'North Room'}]};
    if(statement.includes('FROM skus'))return {rows:[{value:'ABC-1',label:'ABC-1 Alpha'}]};
    throw new Error(statement);
  }};
  const contract=registry.get('inventory.receive');
  const result=await resolver.resolveArguments(database,{workspaceId:'workspace'},contract,
    {quantity:'9'},{});
  assert.equal(result.args.location,'North Room');
  assert.equal(result.args.sku,'ABC-1');
  assert.equal(result.provenance.location.source,'single_valid_candidate');
  assert.equal(result.provenance.sku.source,'single_valid_candidate');
  assert.equal(result.args.quantity,9);
});

test('ambiguous entities never become arbitrary IDs or names',async()=>{
  const database={async query(statement){
    if(statement.includes('FROM locations'))return {rows:[{value:'North',label:'North'},
      {value:'South',label:'South'}]};
    if(statement.includes('FROM skus'))return {rows:[{value:'ABC-1',label:'ABC-1 Alpha'}]};
    throw new Error(statement);
  }};
  const result=await resolver.resolveArguments(database,{workspaceId:'workspace'},
    registry.get('inventory.receive'),{sku:'ABC-1',quantity:'2'},{});
  assert.equal(result.args.location,null);
  assert.equal(result.unresolved[0].reason,'ambiguous');
});

test('navigation uses registered destination IDs and a server URL builder',()=>{
  assert.deepEqual(destinationById('accounting'),{href:'/money',label:'Money'});
  assert.equal(destinationById('unregistered-destination'),null);
});
