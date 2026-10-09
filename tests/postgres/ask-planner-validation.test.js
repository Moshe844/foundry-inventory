'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const planner=require('../../src/assistant/postgres-capability-planner');
const {selectedPendingChoice,synthesizeReads,focusedIntentCatalogue}=require('../../src/assistant/postgres-control-plane');
const {registry}=require('../../src/assistant/postgres-capability-registry');

test('registry-derived fallback focuses an overlooked exact action without executing a lexical guess',()=>{
  const focused=focusedIntentCatalogue('Rename this inventory to a new name, after my approval.',
    registry,{alternative:'workspace.rename'});
  assert.ok(focused);
  assert.equal(focused.get('workspace.rename')?.name,'workspace.rename');
  assert.ok(focused.list().length<registry.list().length);
  assert.equal(focused.get('shipping.label.create'),null);
  const report=focusedIntentCatalogue('Build a report grouping on-hand units by location.',registry);
  assert.equal(report.get('read.custom_report')?.name,'read.custom_report');
});

test('a selected clarification choice resumes the original authorized capability, not an unrelated read',()=>{
  const pending={status:'CLARIFY',capability:'supplier_payment.record',awaitingField:'supplier',
    args:{supplierBill:'LAB-INV-7',amount:0.5,paymentMethod:'cash',paymentDate:'2026-10-08'},
    choices:[{label:'Lab Fastener Supply',value:'Lab Fastener Supply'},
      {label:'Lab Copper Supply',value:'Lab Copper Supply'}]};
  const chosen=selectedPendingChoice(pending,'Lab Fastener Supply',registry);
  assert.equal(chosen.steps[0].contract.name,'supplier_payment.record');
  assert.equal(chosen.steps[0].continuesPending,true);
  assert.equal(chosen.steps[0].args.supplier,'Lab Fastener Supply');
  assert.equal(selectedPendingChoice(pending,'Tell me about Lab Fastener Supply',registry),null);
  assert.equal(selectedPendingChoice(pending,'Lab Fastener Supply — no changes now',registry),null);
});

test('one physical departure does not schedule a second in-transit state transition',()=>{
  const depart=registry.get('transfer.depart');
  const transit=registry.get('transfer.in_transit');
  const steps=[{contract:depart,args:{recordReference:'TR-0004'},dependsOn:[],continuesPending:false},
    {contract:transit,args:{recordReference:'TR-0004'},dependsOn:[],continuesPending:false}];
  planner.collapseRepeatedEffects(steps);
  assert.deepEqual(steps.map((entry)=>entry.contract.name),['transfer.depart']);
});

test('malformed model output retries once without turning a supported read into unavailable',async()=>{
  let attempts=0;
  const provider={async complete(){
    attempts+=1;
    if(attempts===1)throw Object.assign(new Error('Malformed model response'),{code:'ai_invalid_output'});
    return {data:{steps:[{capability:'read.locations',arguments:[],dependsOn:[],continuesPending:false}],
      clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,'Which inventory locations exist?',{deferReadFit:true});
  assert.equal(attempts,2);
  assert.equal(result.steps[0].contract.name,'read.locations');
});

test('a truncated capability-fit response retries with a bounded larger output budget',async()=>{
  const fitBudgets=[];
  const provider={async complete({schemaName,maxOutputTokens}){
    if(schemaName==='stockchief_capability_fit'){
      fitBudgets.push(maxOutputTokens);
      if(fitBudgets.length===1)throw Object.assign(new Error('Truncated fit response'),{
        code:'ai_invalid_output',details:{technical:'stop_reason max_tokens'}});
      return {data:{aligned:true,reason:''}};
    }
    return {data:{steps:[{capability:'sales_order.create',arguments:[
      {name:'customer',value:'Lab Eastside Facilities'},
      {name:'sku',value:'LAB-WASH-030'},
      {name:'quantity',value:'2'}],dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,
    'Prepare a draft order for Lab Eastside Facilities: two LAB-WASH-030 washers.');
  assert.deepEqual(fitBudgets,[384,1024]);
  assert.equal(result.steps[0].contract.name,'sales_order.create');
});

test('PO placement no-transmission guarantee survives planner catalogue compaction',()=>{
  const brief=planner.planningCatalogue(registry).mutations.find((entry)=>entry.n==='purchase_order.place');
  assert.match(brief.d,/Approved PO only/);
  assert.match(brief.d,/no email, API/);
});

test('physical movement source totals bypass model arithmetic mistakes',async()=>{
  const step={contract:registry.get('read.inventory_movements')};
  const executed=[{step,args:{search:'LAB-WASH-030'},provenance:{},result:{status:'ANSWERED',
    answer:'LAB-WASH-030 customer sale fulfillment: +0 received, -7 issued, net -7 [SO-00008, SO-00009, SO-00010].',
    rows:[{sku:'LAB-WASH-030',sourceKind:'customer_sale_fulfillment',change:-2},
      {sku:'LAB-WASH-030',sourceKind:'customer_sale_fulfillment',change:-1}]}}];
  const provider={async complete(){throw new Error('Movement arithmetic must not use AI synthesis');}};
  const result=await synthesizeReads(provider,'How many LAB-WASH-030 units went to customer sales?',executed);
  assert.equal(result[0].result.status,'ANSWERED');
  assert.match(result[0].result.answer,/-7 issued/);
  assert.deepEqual(result[0].result.researchViews,['inventory_movements']);
});

test('read synthesis reports a reached daily model limit rather than alleging absent evidence',async()=>{
  const step={contract:registry.get('read.customer_returns')};
  const executed=[{step,args:{search:'RMA-01002'},provenance:{},result:{status:'ANSWERED',
    answer:'One verified return.',rows:[{return:'RMA-01002',status:'RESTOCKED'}]}}];
  const provider={async complete(){throw Object.assign(new Error('Daily model-attempt limit reached.'),{
    code:'rate_limited',limitKind:'daily_model_attempts'});}};
  const result=await synthesizeReads(provider,'What happened to this return?',executed);
  assert.equal(result[0].result.status,'CLARIFY');
  assert.equal(result[0].result.reason,'daily_safety_limit');
  assert.match(result[0].result.answer,/Daily model-attempt limit reached/);
});

test('read synthesis retries one invalid model output without discarding verified evidence',async()=>{
  let attempts=0;
  const step={contract:registry.get('read.customer_returns')};
  const executed=[{step,args:{search:'RMA-01002'},provenance:{},result:{status:'ANSWERED',
    answer:'One verified return.',rows:[{return:'RMA-01002',status:'RESTOCKED'}]}}];
  const provider={async complete(){attempts+=1;
    if(attempts===1)throw Object.assign(new Error('Truncated'),{code:'ai_invalid_output'});
    return {data:{answer:'The verified return was restocked.',supported:true,usedSteps:[0],additionalReads:[]}};
  }};
  const result=await synthesizeReads(provider,'What happened to this return?',executed);
  assert.equal(attempts,2);
  assert.equal(result[0].result.status,'ANSWERED');
  assert.match(result[0].result.answer,/verified return was restocked/);
});

test('independent evidence check repairs a status-mixed business briefing',async()=>{
  const executed=[
    {step:{contract:registry.get('read.sales_orders')},args:{},provenance:{},result:{status:'ANSWERED',
      answer:'Recorded customer orders.',rows:[
        {order:'SO-1',status:'DRAFT',openUnits:3},
        {order:'SO-2',status:'CONFIRMED',openUnits:2},
        {order:'SO-3',status:'FULFILLED',openUnits:0}]}},
    {step:{contract:registry.get('read.purchase_orders')},args:{},provenance:{},result:{status:'ANSWERED',
      answer:'Recorded supplier orders.',rows:[{order:'PO-1',status:'DRAFT',outstandingUnits:20},
        {order:'PO-2',status:'ORDERED',outstandingUnits:4}]}}
  ];
  let plans=0,fits=0;
  const provider={async complete(input){
    plans++;
    const prompt=JSON.parse(input.prompt);
    assert.equal(prompt.verifiedStatusFacts[0].byStatus.CONFIRMED.openUnits,2);
    assert.equal(prompt.verifiedStatusFacts[1].byStatus.ORDERED.outstandingUnits,4);
    return {data:{answer:plans===1?'Three confirmed orders need shipping; 24 supplier units are incoming.':
      'One confirmed order has 2 open units. One placed supplier order has 4 units outstanding.',
    supported:true,usedSteps:[0,1],additionalReads:[]}};
  },async verifyComplete(input){
    assert.equal(input.schemaName,'stockchief_capability_answer_fit');fits++;
    return {data:{grounded:fits===2,reason:fits===1?'Draft and fulfilled orders were counted as confirmed.':''}};
  }};
  const result=await synthesizeReads(provider,'What needs doing first?',executed);
  assert.equal(plans,2);assert.equal(fits,2);
  assert.equal(result[0].result.status,'ANSWERED');
  assert.match(result[0].result.answer,/One confirmed order has 2 open units/);
});

test('a grounded multi-part business briefing is not rejected for length alone',async()=>{
  const executed=[{step:{contract:registry.get('read.needs_you')},args:{},provenance:{},
    result:{status:'ANSWERED',answer:'One decision needs attention.',rows:[
      {decision:'Resolve disputed bill BILL-2',importance:'Important',
        reason:'The supplier invoice differs from the purchase order.'}]}}];
  const briefing='I can help you inspect stock, review orders, prepare purchases, and analyze recorded results. '
    +'The one decision currently flagged is the disputed supplier bill BILL-2: its invoice differs from the purchase order. '
    +'Review that discrepancy first; I can open the source record and help you decide the next step, but I will not change the bill without your approval. '
    +'Other workflows depend on the data and permissions available in this inventory.';
  assert.ok(briefing.length>350);
  let checked=false;
  const provider={async complete(){return {data:{answer:briefing,supported:true,usedSteps:[0],additionalReads:[]}};},
    async verifyComplete(){checked=true;return {data:{grounded:true,reason:''}};}};
  const result=await synthesizeReads(provider,'What can you help me do, and what should I tackle first?',executed);
  assert.equal(checked,true);assert.equal(result[0].result.status,'ANSWERED');
});

test('a rejected synthesis retains verified source findings rather than a generic refusal',async()=>{
  const executed=[{step:{contract:registry.get('read.inventory_summary')},args:{},provenance:{},
    result:{status:'ANSWERED',answer:'There are 4 products and 18 units on hand.',
      rows:[{products:4,onHand:18}]}},
  {step:{contract:registry.get('read.needs_you')},args:{},provenance:{},
    result:{status:'ANSWERED',answer:'One decision needs your attention: review bill BILL-2.',
      rows:[{decision:'Review bill BILL-2'}]}}];
  const provider={async complete(){return {data:{answer:'There are 99 orders.',supported:true,
    usedSteps:[0,1],additionalReads:[]}};},async verifyComplete(){return {data:{grounded:false,
      reason:'No order evidence was supplied.'}};}};
  const result=await synthesizeReads(provider,'Summarize my business and next step',executed);
  assert.equal(result[0].result.status,'CLARIFY');
  assert.match(result[0].result.answer,/4 products and 18 units/);
  assert.match(result[0].result.answer,/review bill BILL-2/);
  assert.doesNotMatch(result[0].result.answer,/99 orders/);
  assert.equal(result[0].result.rows.length,2);
});

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

test('a factual order follow-up cannot be replaced by opening its page',async()=>{
  let plans=0;
  const provider={async complete({schemaName}){
    if(schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''}};
    plans+=1;
    return {data:{steps:[{capability:plans===1?'navigate.sales_order':'read.sales_orders',
      arguments:[],dependsOn:[],continuesPending:false}],clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,
    'Verify the actual lines and total of the order you just created.',{deferReadFit:true});
  assert.equal(plans,2);
  assert.deepEqual(result.steps.map(({contract})=>contract.name),['read.sales_orders']);
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

test('available-stock confirmation with backorder fallback cannot add a strict second reservation',async()=>{
  const step=(capability,dependsOn=[])=>({capability,
    arguments:[{name:'recordReference',value:'SO-00001'}],dependsOn,continuesPending:false});
  const provider={async complete({schemaName,prompt}){
    if(schemaName==='stockchief_capability_fit'){
      assert.deepEqual(JSON.parse(prompt).proposedSteps.map((row)=>row.capability),
        ['sales_order.confirm']);
      return {data:{aligned:true,reason:''}};
    }
    return {data:{steps:[step('sales_order.confirm'),step('sales_order.reserve_all',[0])],
      clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,
    'Confirm SO-00001 and reserve available units; if stock is short, backorder the rest.');
  assert.deepEqual(result.steps.map((row)=>row.contract.name),['sales_order.confirm']);
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

test('a transfer that already reserves stock cannot add a second approval for the same new transfer',async()=>{
  const provider={async complete({schemaName}){
    if(schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''}};
    return {data:{steps:[
      {capability:'inventory.transfer',arguments:[{name:'sku',value:'WASH-30'},
        {name:'fromLocation',value:'Main'},{name:'toLocation',value:'Overflow'},
        {name:'quantity',value:'2'}],dependsOn:[],continuesPending:false},
      {capability:'transfer.approve',arguments:[],dependsOn:[0],continuesPending:false},
      {capability:'navigate.record.transfer',arguments:[],dependsOn:[1],continuesPending:false},
    ],clarifyingQuestion:''}};
  }};
  const result=await planner.plan(provider,
    'Transfer and reserve two washers from Main to Overflow, then open that transfer. Do not pick or dispatch.');
  assert.deepEqual(result.steps.map((step)=>step.contract.name),
    ['inventory.transfer','navigate.record.transfer']);
  assert.deepEqual(result.steps.map((step)=>step.dependsOn),[[],[0]]);
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
  const provider={async complete({schemaName,prompt,maxOutputTokens}){
    if(schemaName==='stockchief_capability_fit'){
      assert.equal(maxOutputTokens,384);
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
