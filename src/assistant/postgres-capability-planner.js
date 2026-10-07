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
  'Preserve every identifying detail the owner did supply in the corresponding action argument. Do not omit a named product, party, location, or record merely because the resolver could later ask again; the resolver is for genuinely missing or ambiguous details, not for discarding stated ones.',
  'The workspace summary is routing context, not evidence for answering the owner. Registered business-wide reads work even in an empty workspace and can verify that zero records exist; do not require the owner to set up a product or location before choosing one. Even if counts are zero, select the appropriate registered read capability so its executor can verify the answer. Do not choose a capability requiring an existing linked record when that record type has none in the workspace.',
  'Do not assume a separate location or record that has not been established. When several capabilities seem plausible, choose the one requiring the fewest unestablished business records or assumptions; do not invent a linked order, bill, payment, or policy merely because one could exist.',
  'A coherent broad question should use the corresponding business-wide read capability without asking for optional product, location, status or time filters. A current-state read defaults to the whole workspace now unless the owner narrows it.',
  'Clarify only when a missing detail materially prevents selecting a capability or the deterministic argument resolver cannot find one answer.',
  'Use skuScope=currently_stocked only when the owner semantically refers to the currently stocked product or stock. Use dependsOn as zero-based indexes of prior steps only. Do not claim a dependent step is complete.',
  'Use continuesPending only when this message actually continues the pending request; a new independent request must not inherit prior arguments.',
  'When the owner answers a pending question, use pending.awaitingField and the previous arguments to continue the same capability. An email subject is optional: do not ask for one when the owner has supplied the message body; StockChief can draft a subject for approval. Preserve an explicitly supplied recipient address and an explicit request to add a new supplier or customer.',
  'Treat the current message as the primary goal. Prior turns are context, not a command to keep using their capability. Before returning a plan, check that every selected capability directly addresses the current message; if it does not, revise the plan. In particular, a read about one record type must not replace a different requested business action.',
  'Match the requested real-world effect, not merely its topic. A capability that records an event after it happened cannot substitute for initiating the event; a draft cannot substitute for sending, placing, paying, fulfilling, or physically moving; and an internal status change cannot substitute for an external provider action. If the registered capability has a narrower or different effect than the owner requests, do not select it. Explain that the requested effect is unavailable and, if useful, distinguish any related capability as an alternative rather than carrying it out.',
  'If the goal cannot be represented by registered capabilities, return no steps and one concise clarifyingQuestion that clearly says the requested operation is unavailable. Never present a different registered operation as though it fulfills the request; any alternative must be explicitly distinguished. Never invent a record, authority, policy limit, or business fact. Do not answer the owner or write SQL.',
].join(' ');

const FIT_SCHEMA={type:'object',additionalProperties:false,required:['aligned','reason'],properties:{
  aligned:{type:'boolean'},reason:{type:'string',maxLength:240},
}};
const FIT_SYSTEM='Independently check whether the proposed StockChief capabilities accomplish the owner’s CURRENT goal. The pending question is context only. Judge semantic fit by the exact business effect and timing, not wording or topical overlap. Reject a plan that substitutes a related but narrower action: recording an event is not initiating it, a draft is not sending or completing it, and changing internal state is not performing an external provider action. A read-only lookup does not fulfill a request to make or change a record. A plan that continues an old goal rather than addressing a new one is misaligned. A plan that ignores an answer to the pending question is misaligned. Check that identifying details explicitly given by the owner, such as a named product, party, location, or record, survive in the plan’s arguments rather than being dropped and turned into an unnecessary question. If the desired effect has no registered capability, set aligned=false even when the proposed action concerns the same supplier, customer, product, or amount. Do not perform the operation or invent business facts.';
const NO_STEP_FIT_SYSTEM='Independently check whether StockChief’s proposed clarification accurately addresses the owner’s CURRENT goal. Judge the requested business effect and timing, not wording or topical overlap. A question about recording an already-completed event does not answer a request to initiate that event; a question about a draft does not answer a request to send or complete it. If the requested effect is unavailable, the reply must say so or ask a genuinely relevant clarifying question, without presuming the owner wanted a related but different operation. Return aligned=false for an irrelevant or substituting clarification. Do not invent capabilities or business facts.';
const SAFE_CLARIFICATION='I could not safely match your request to an available StockChief action. Nothing changed. Please tell me the outcome you want.';

function planningCatalogue(catalogue=registry){
  const entries=catalogue.list();
  return {
    sharedContract:{contextSources:['workspace','current_page','conversation','applicable_settings'],
      validation:'Resolve references and validate against the current workspace before execution.',
      mutation:{authority:'explicit approval',confirmation:'owner review',
        executor:'canonical deterministic business service',verification:'resulting records checked in the approval transaction'},
      readInputs:['search','timeframe'],recordNavigationInput:['recordReference']},
    fields:FIELDS,
    mutations:entries.filter((entry)=>entry.kind==='mutation').map((entry)=>({
      name:entry.name,description:entry.description,required:entry.required||[],
      optional:entry.fields.filter((field)=>!entry.required?.includes(field)),
      permission:entry.permission,resultingRecords:entry.resultingRecords})),
    reads:entries.filter((entry)=>entry.kind==='read').map((entry)=>({
      name:entry.name,description:entry.description,permission:entry.permission})),
    navigation:entries.filter((entry)=>entry.kind==='navigation').map((entry)=>({
      name:entry.name,description:entry.description,permission:entry.permission})),
    policies:entries.filter((entry)=>entry.kind==='policy').map((entry)=>({
      name:entry.name,description:entry.description,permission:entry.permission,
      authority:entry.authority,confirmation:entry.confirmation})),
  };
}

function systemFor(catalogue=registry){return `${PLANNING_RULES}\nRegistered capability contracts: ${JSON.stringify(planningCatalogue(catalogue))}`;}

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
      status:pending.status,awaitingField:pending.awaitingField||null,
      proposalPending:Boolean(pending.proposalId)}:null,
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
  let selected=parseSteps(response.data,catalogue);
  if(!selected.steps.length){
    try{
      const checked=await provider.complete({system:NO_STEP_FIT_SYSTEM,
        prompt:JSON.stringify({message,pendingQuestion:pending?.question||null,
          proposedReply:selected.clarifyingQuestion}),schema:FIT_SCHEMA,
        schemaName:'stockchief_capability_fit'});
      if(checked.data?.aligned!==true)return {steps:[],clarifyingQuestion:SAFE_CLARIFICATION};
    }catch(error){if(error.code==='entitlement_required')throw error;
      return {steps:[],clarifyingQuestion:SAFE_CLARIFICATION};}
    return selected;
  }
  if(selected.steps.length){
    try{
      const candidate=()=>({message,pendingQuestion:selected.steps.some((step)=>step.continuesPending)
        ?pending?.question||null:null,
        proposedSteps:selected.steps.map((step)=>({capability:step.contract.name,
          description:step.contract.description,arguments:step.args,continuesPending:step.continuesPending}))});
      let fit=await provider.complete({system:FIT_SYSTEM,prompt:JSON.stringify(candidate()),
        schema:FIT_SCHEMA,schemaName:'stockchief_capability_fit'});
      if(fit.data?.aligned===false){
        const repaired=await provider.complete({system:systemFor(catalogue),
          prompt:JSON.stringify({...context,rejectedPlan:response.data,
            validationErrors:[{issue:'The proposed capabilities do not address the current message.',
              reason:String(fit.data.reason||'').slice(0,240)}],
            instruction:'Choose capabilities that fulfill the current message. Treat the pending request only as context if this is a new goal.'}),
          schema:schemaFor(catalogue),schemaName:'stockchief_capability_plan'});
        selected=parseSteps(repaired.data,catalogue);
        if(selected.steps.length){
          fit=await provider.complete({system:FIT_SYSTEM,prompt:JSON.stringify(candidate()),
            schema:FIT_SCHEMA,schemaName:'stockchief_capability_fit'});
          if(fit.data?.aligned===false)return {steps:[],
            clarifyingQuestion:'I could not confidently match that request to the right business action. Nothing changed.'};
        }
      }
    }catch(error){if(error.code==='entitlement_required')throw error;
      return {steps:[],clarifyingQuestion:'I could not safely verify that I understood this request. Nothing changed.'};
    }
  }
  return selected;
}

module.exports={schemaFor,systemFor,planningCatalogue,parseSteps,plan};
