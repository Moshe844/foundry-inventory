'use strict';

const {FIELDS,registry}=require('./postgres-capability-registry');

function schemaFor(catalogue=registry){
  return {type:'object',additionalProperties:false,required:['steps','clarifyingQuestion'],properties:{
    steps:{type:'array',minItems:0,maxItems:8,items:{type:'object',additionalProperties:false,
      required:['capability','arguments','dependsOn','continuesPending'],properties:{
        capability:{type:'string',enum:catalogue.list().map((entry)=>entry.name)},
        arguments:{type:'array',maxItems:32,items:{type:'object',additionalProperties:false,
          required:['name','value'],properties:{name:{type:'string',enum:Object.keys(FIELDS)},
            value:{type:'string',maxLength:2000}}}},
        dependsOn:{type:'array',maxItems:7,items:{type:'integer',minimum:0,maximum:7}},
        continuesPending:{type:'boolean'},
      }}},
    clarifyingQuestion:{type:'string',maxLength:300},
  }};
}

const PLANNING_RULES=[
  "You are StockChief's business-operation planner. Interpret the owner's goal from meaning and context, not a sentence pattern.",
  'Choose only from the registered capability contracts below. A capability description states what it does; arguments state its business inputs. You may compose up to eight steps.',
  'For every step, provide only arguments the owner actually supplied or explicitly referred to; missing inputs are resolved from real business context by StockChief. Never supply a guessed default entity name, including a location; omit the field for the resolver.',
  'The workspace summary is routing context, not evidence for answering the owner. Registered business-wide reads work even in an empty workspace and can verify that zero records exist; do not require the owner to set up a product or location before choosing one. Even if counts are zero, select the appropriate registered read capability so its executor can verify the answer. Do not choose a capability requiring an existing linked record when that record type has none in the workspace.',
  'Do not assume a separate location or record that has not been established. When several capabilities seem plausible, choose the one requiring the fewest unestablished business records or assumptions; do not invent a linked order, bill, payment, or policy merely because one could exist.',
  'A coherent broad question should use the corresponding business-wide read capability without asking for optional product, location, status or time filters. A current-state read defaults to the whole workspace now unless the owner narrows it.',
  'Clarify only when a missing detail materially prevents selecting a capability or the deterministic argument resolver cannot find one answer.',
  'Use skuScope=currently_stocked only when the owner semantically refers to the currently stocked product or stock. Use dependsOn as zero-based indexes of prior steps only. Do not claim a dependent step is complete.',
  'Use continuesPending only when this message actually continues the pending request; a new independent request must not inherit prior arguments.',
  'If the goal cannot be represented by registered capabilities, return no steps and one concise clarifyingQuestion that clearly says the requested operation is unavailable. Never present a different registered operation as though it fulfills the request; any alternative must be explicitly distinguished. Never invent a record, authority, policy limit, or business fact. Do not answer the owner or write SQL.',
].join(' ');

function systemFor(catalogue=registry){return `${PLANNING_RULES}\nRegistered capabilities: ${JSON.stringify(catalogue.description())}`;}

function parseSteps(raw,catalogue=registry){
  if(!raw||!Array.isArray(raw.steps))return {steps:[],clarifyingQuestion:'I could not reliably understand that request. Nothing changed.'};
  const steps=[];
  for(const [index,step] of raw.steps.slice(0,8).entries()){
    const contract=catalogue.get(step?.capability);
    if(!contract)return {steps:[],clarifyingQuestion:'StockChief does not have a registered capability for that request. Nothing changed.'};
    const args={};
    for(const entry of step.arguments||[]){
      if(!contract.fields.includes(entry?.name)||typeof entry.value!=='string'||Object.hasOwn(args,entry.name))
        return {steps:[],clarifyingQuestion:'The planned action contained an invalid business input. Nothing changed.'};
      args[entry.name]=entry.value.trim().slice(0,2000);
    }
    const dependsOn=[...new Set(step.dependsOn||[])];
    if(dependsOn.some((position)=>!Number.isInteger(position)||position<0||position>=index))
      return {steps:[],clarifyingQuestion:'The request contained an invalid step dependency. Nothing changed.'};
    steps.push({contract,args,dependsOn,continuesPending:step.continuesPending===true});
  }
  return {steps,clarifyingQuestion:String(raw.clarifyingQuestion||'').trim().slice(0,300)};
}

async function plan(provider,message,{catalogue=registry,history=[],pending=null,page=null,workspace=null}={}){
  if(!provider)return {steps:[],clarifyingQuestion:'StockChief cannot interpret free-form requests while its reasoning connection is unavailable. Nothing changed.'};
  const context={message,
    workspace,
    conversation:history.slice(-6).map(({message,answer,status})=>({message,answer,status})),
    pending:pending?{capability:pending.capability,args:pending.args,question:pending.question,
      status:pending.status,proposalPending:Boolean(pending.proposalId)}:null,
    currentPage:page||null};
  let response=await provider.complete({system:systemFor(catalogue),prompt:JSON.stringify(context),
    schema:schemaFor(catalogue),schemaName:'stockchief_capability_plan'});
  const invalid=(response.data?.steps||[]).flatMap((step)=>{
    const contract=catalogue.get(step?.capability);
    return (step?.arguments||[]).filter((input)=>contract&&!contract.fields.includes(input?.name))
      .map((input)=>({capability:contract.name,invalidInput:input?.name,allowedInputs:contract.fields}));
  });
  if(invalid.length){
    response=await provider.complete({system:systemFor(catalogue),
      prompt:JSON.stringify({...context,rejectedPlan:response.data,validationErrors:invalid,
        instruction:'Revise the plan using only the input fields declared by each selected capability. Preserve the owner’s supplied details and do not invent missing ones.'}),
      schema:schemaFor(catalogue),schemaName:'stockchief_capability_plan'});
  }
  return parseSteps(response.data,catalogue);
}

module.exports={schemaFor,systemFor,parseSteps,plan};
