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
  'Choose only from the registered capability contracts below. A capability description states what it does; arguments state its business inputs. Use the fewest steps that achieve the stated goal. Compose multiple steps only when the owner actually requests multiple effects or one requested effect has a genuine dependency; at most eight steps are allowed.',
  'For every step, provide only arguments declared by that capability and actually supplied or explicitly referred to by the owner; missing inputs are resolved from real business context by StockChief. Omit unknown argument values entirely; never use a schema-field name, context path, or other placeholder as its value. Capabilities with no declared fields must receive an empty arguments array: StockChief passes the complete owner message to their interpreter. Never supply a guessed default entity name, including a location; omit the field for the resolver.',
  'Preserve every identifying detail the owner did supply in the corresponding action argument. Do not omit a named product, party, location, or record merely because the resolver could later ask again; the resolver is for genuinely missing or ambiguous details, not for discarding stated ones.',
  'The workspace summary is routing context, not evidence for answering the owner. Registered business-wide reads work even in an empty workspace and can verify that zero records exist; do not require the owner to set up a product or location before choosing one. Even if counts are zero, select the appropriate registered read capability so its executor can verify the answer. Do not choose a capability requiring an existing linked record when that record type has none in the workspace.',
  'Do not assume a separate location or record that has not been established. When several capabilities seem plausible, choose the one requiring the fewest unestablished business records or assumptions; do not invent a linked order, bill, payment, or policy merely because one could exist.',
  'A coherent broad question should use the corresponding business-wide read capability without asking for optional product, location, status or time filters. A current-state read defaults to the whole workspace now unless the owner narrows it.',
  'A request to learn what records exist, their status, or their count is a read even if the owner uses a visual verb. Select navigation only when the goal is to change the visible application page, not merely to display an answer.',
  'Only one application page can be opened at a time. Choose exactly one navigation destination for a navigation request, even when its name contains concepts also used by another page; do not add a second navigation as explanation.',
  'When the owner asks StockChief to obtain, buy, replenish, or invoice something, select the matching registered write capability if available; a stock lookup alone is not fulfillment of an action request. The deterministic resolver will ask for genuinely missing quantity, price, party, or date. Do not reinterpret an action as a read just because details are missing.',
  'A declarative business fact addressed to StockChief can be an instruction to remember or change a persistent setting, even without an imperative verb. When it supplies a supplier term, threshold, or operating preference rather than asking whether that fact is already true, choose the registered policy capability; a read of old records does not save the new fact.',
  'Do not add a contact, product, order, purchase or stock movement merely as a precaution or prerequisite when the owner did not request that creation. StockChief resolves existing records in the workspace and asks only if an identity is truly missing. Invoicing does not imply creating a sales order or fulfilling stock.',
  'Do not add a read step just to look up context for a requested mutation. The deterministic argument resolver and executor read needed records themselves. Add a separate read only if the owner also asks for its answer.',
  'Clarify only when a missing detail materially prevents selecting a capability or the deterministic argument resolver cannot find one answer.',
  'Use skuScope=currently_stocked only when the owner semantically refers to the currently stocked product or stock. Use dependsOn as zero-based indexes of prior steps only. Do not claim a dependent step is complete.',
  'Use continuesPending only when this message actually continues the pending request; a new independent request must not inherit prior arguments.',
  'When the owner answers a pending question, use pending.awaitingField and the previous arguments to continue the same capability. An email subject is optional: do not ask for one when the owner has supplied the message body; StockChief can draft a subject for approval. Preserve an explicitly supplied recipient address and an explicit request to add a new supplier or customer.',
  'Treat the current message as the primary goal. Prior turns are context, not a command to keep using their capability. Before returning a plan, check that every selected capability directly addresses the current message; if it does not, revise the plan. In particular, a read about one record type must not replace a different requested business action.',
  'Match the requested real-world effect, not merely its topic. A capability that records an event after it happened cannot substitute for initiating the event; a draft cannot substitute for sending, placing, paying, fulfilling, or physically moving; and an internal status change cannot substitute for an external provider action. If the registered capability has a narrower or different effect than the owner requests, do not select it. Explain that the requested effect is unavailable and, if useful, distinguish any related capability as an alternative rather than carrying it out.',
  'If the goal cannot be represented by registered capabilities, return no steps and one concise, plain-language clarifyingQuestion that names the requested effect and says it is unavailable. Do not expose internal capability names. Never present a different registered operation as though it fulfills the request; any alternative must be explicitly distinguished. Never invent a record, authority, policy limit, or business fact. Do not answer the owner or write SQL.',
].join(' ');

const FIT_SCHEMA={type:'object',additionalProperties:false,required:['aligned','reason'],properties:{
  aligned:{type:'boolean'},reason:{type:'string',maxLength:240},
}};
const FIT_SYSTEM=`Independently check whether the proposed StockChief capabilities accomplish the owner's CURRENT goal.
The pending question is context only. Judge the exact business effect and timing, not wording or topical overlap.
Reject extra steps the owner did not request; do not invent contact, product, order, purchase or stock movement creation
as a precaution. The deterministic resolver checks existing records and asks only if an identity is missing.
Reject a preliminary read used only as context for a mutation when the owner did not request that information separately;
the deterministic resolver fetches required facts without showing an extra answer.
A capability marked full_owner_message receives the complete message, including every named product, value and limit;
it is deliberately not given separate arguments. Do not mark it misaligned for empty arguments.
An owner stating a durable supplier term, stock threshold or operating preference is telling StockChief business information
worth proposing as a rule. The proposal still requires explicit owner approval before any setting changes.
Preparing a consequential operation for owner approval is StockChief's normal safety boundary: judge the effect
the registered executor has after approval, not whether it happens without approval.
Creating and posting a customer invoice is billing in StockChief, even though separately sending the invoice or
collecting payment is not included; only require those effects when the owner actually asks for them.
Reject a plan that substitutes a related but narrower action: recording an event is not initiating it, a draft is not
sending or completing it, and changing internal state is not performing an external provider action.
A read-only lookup does not fulfill a request to change business state. Reject a plan that continues an old goal
rather than addressing a new one, or ignores an answer to a pending question. For capabilities with declared
input fields, check that identifying details explicitly given by the owner survive in the arguments.
Judge capability fit, not input completeness. Required inputs the owner did not provide must be omitted;
the deterministic resolver supplies a unique value from workspace or prior context, or asks the owner.
Never mark an otherwise fitting capability misaligned merely because quantity, cost, location, party,
or another required input is genuinely missing. A clarification is the expected next result.
For a read, check that the contract description covers every measure and distinction the owner asks for;
reject a narrower read when a registered broader read is required to answer fully.
If the desired effect has no registered capability, set aligned=false even when a proposed action concerns the same
supplier, customer, product, or amount. Do not perform the operation or invent business facts.`;
const SAFE_CLARIFICATION='StockChief cannot carry out or verify that outcome. Nothing changed.';

function conciseClarification(value){
  const answer=String(value||'').trim();
  if(answer.length<=240)return answer;
  const end=[...answer.matchAll(/[.!?](?=\s|$)/g)].find((match)=>match.index<240);
  return end?answer.slice(0,end.index+1):SAFE_CLARIFICATION;
}

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
      authority:entry.authority,confirmation:entry.confirmation,
      domains:require('../manager/postgres-policy-contracts').DEFINITIONS})),
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
    for(const entry of contract.fields.length?step.arguments||[]:[]){
      if(!contract.fields.includes(entry?.name)||typeof entry.value!=='string'||Object.hasOwn(args,entry.name))
        return {steps:[],clarifyingQuestion:'The planned action contained an invalid business input. Nothing changed.'};
      args[entry.name]=entry.value.trim().slice(0,2000);
    }
    const dependsOn=[...new Set(step.dependsOn||[])];
    if(dependsOn.some((position)=>!Number.isInteger(position)||position<0||position>=index))
      return {steps:[],clarifyingQuestion:'The request contained an invalid step dependency. Nothing changed.'};
    steps.push({contract,args,dependsOn,continuesPending:step.continuesPending===true});
  }
  if(steps.filter((step)=>step.contract.kind==='navigation').length>1)
    return {steps:[],clarifyingQuestion:'I can open one area at a time. Which area should I open?'};
  return {steps,clarifyingQuestion:conciseClarification(raw.clarifyingQuestion)};
}

async function plan(provider,message,{catalogue=registry,history=[],pending=null,page=null,workspace=null,
  deferReadFit=false}={}){
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
    return (contract?.fields.length?step?.arguments||[]:[]).filter((input)=>contract&&!contract.fields.includes(input?.name))
      .map((input)=>({capability:contract.name,invalidInput:input?.name,allowedInputs:contract.fields}));
  });
  if((response.data?.steps||[]).filter((step)=>catalogue.get(step?.capability)?.kind==='navigation').length>1)
    invalid.push({issue:'A single request can open only one destination. Keep the one page that best fulfills the owner’s navigation goal.'});
  if(invalid.length){
    response=await provider.complete({system:systemFor(catalogue),
      prompt:JSON.stringify({...context,rejectedPlan:response.data,validationErrors:invalid,
        instruction:'Revise the plan to satisfy every validation error. Use only declared input fields, preserve the owner’s details, do not invent missing ones, and choose one final navigation destination.'}),
      schema:schemaFor(catalogue),schemaName:'stockchief_capability_plan'});
  }
  let selected=parseSteps(response.data,catalogue);
  // Read-only plans can be checked against actual evidence by the answer
  // stage, which can request a broader registered read when needed.
  if(deferReadFit&&selected.steps.length&&selected.steps.every((step)=>step.contract.kind==='read'))
    return selected;
  // Without a registered step, a model-authored explanation could silently
  // reinterpret an unavailable effect as a related operation. Never expose
  // that speculative explanation as an instruction to the owner.
  if(!selected.steps.length)return {steps:[],clarifyingQuestion:SAFE_CLARIFICATION};
  if(selected.steps.length){
    try{
      const candidate=()=>({message,pendingQuestion:selected.steps.some((step)=>step.continuesPending)
        ?pending?.question||null:null,
        proposedSteps:selected.steps.map((step)=>({capability:step.contract.name,
          description:step.contract.description,arguments:step.args,
          inputMode:step.contract.fields.length?'typed_arguments':'full_owner_message',
          continuesPending:step.continuesPending}))});
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
  return selected.steps.length?selected:{steps:[],clarifyingQuestion:SAFE_CLARIFICATION};
}

module.exports={schemaFor,systemFor,planningCatalogue,parseSteps,plan};
