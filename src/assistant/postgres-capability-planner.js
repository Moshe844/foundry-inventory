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
    closestAlternative:{type:'string',enum:['',...catalogue.list().filter((entry)=>entry.discovery).map((entry)=>entry.name)]},
  }};
}

const PLANNING_RULES=[
  "Plan the owner's CURRENT goal by meaning, not phrase matching. Use only registered contracts (n=name, d=effect, a=allowed inputs). At most eight steps; use the fewest that actually accomplish the goal.",
  'Include only argument fields declared for each contract. Preserve every product, party, record, amount, location, date and address the owner supplied. Omit unknown values; never guess a default entity, fabricate a placeholder, or supply fields for a capability with no inputs. The resolver verifies unique records or asks for missing inputs.',
  'A broad question uses a business-wide read even when the workspace is empty. Zero recorded products or stock is a verifiable answer, not a reason to refuse or offer a narrower lookup. Workspace counts route the question but are not answer evidence. Read recorded facts; navigate only when the owner asks to change the visible page, and open at most one destination.',
  'A requested change needs its matching write, not a related read. A declarative lasting supplier term, threshold or operating preference may be a policy instruction. Do not create extra contacts, products, orders, purchases or movements as prerequisites. Invoicing does not imply fulfillment or payment.',
  'The executor obtains context itself; do not add a preliminary read solely for a write. Add a read only if the owner separately asks its answer. Missing action inputs are clarified later; do not replace the action with a read.',
  'When one contract already accepts and applies every stated input for the requested outcome, do not add another mutation that sets the same field or performs a preparatory version of that outcome. Plan independent business effects only when the owner separately requested each one.',
  'Match exact real-world effect and timing. Recording a past event is not initiating it; a draft is not sending, buying, paying or fulfilling; internal status is not an external provider action. Never claim a dependent approval or physical event already happened.',
  'Use zero-based dependsOn only for genuine prior-step dependencies. Use continuesPending only when the current message answers the pending question; otherwise prior turns are context, not commands. Preserve a supplied email address; a subject is optional.',
  'Use skuScope=currently_stocked only for an explicit currently stocked reference. Do not assume a linked order, bill, payment or policy exists. Prefer the valid contract requiring fewer unproven business facts.',
  'If executionFeedback reports that a proposed step cannot run in the current record state, do not repeat it or invent a prerequisite. Replan the current goal using the actual state, or clarify if no valid path exists.',
  'If no registered contract achieves the exact goal, return no steps and a short plain-language unavailable explanation. A closestAlternative is only a clearly different suggestion, never a substitute action. Do not invent facts, policies, authority or SQL.',
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
Reject a redundant preparatory mutation if the final selected contract itself accepts and applies the same supplied
measurement, setting, or identity. Do not infer a second business operation from a detail of the requested one.
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
const SAFE_CLARIFICATION='I could not safely match that request to a supported action. Nothing changed.';

function conciseClarification(value){
  const answer=String(value||'').trim();
  if(answer.length<=240)return answer;
  const end=[...answer.matchAll(/[.!?](?=\s|$)/g)].find((match)=>match.index<240);
  return end?answer.slice(0,end.index+1):SAFE_CLARIFICATION;
}

function planningCatalogue(catalogue=registry){
  const entries=catalogue.list();
  const summary=(entry)=>entry.description.slice(0,78);
  return {
    notation:'n=capability name; d=verified effect; a=allowed input names. All changes need approval.',
    mutations:entries.filter((entry)=>entry.kind==='mutation').map((entry)=>({
      n:entry.name,d:summary(entry),a:entry.fields.join(','),
      u:entry.commercialUnavailable?.length?'upgrade':undefined})),
    reads:entries.filter((entry)=>entry.kind==='read').map((entry)=>({
      n:entry.name,d:entry.description.slice(0,190),
      u:entry.commercialUnavailable?.length?'upgrade':undefined})),
    navigation:entries.filter((entry)=>entry.kind==='navigation').map((entry)=>({
      n:entry.name,d:entry.recordKind?entry.description.slice(0,65):undefined})),
    policies:entries.filter((entry)=>entry.kind==='policy').map((entry)=>({
      n:entry.name,d:entry.description.slice(0,85),
      domains:Object.fromEntries(Object.entries(require('../manager/postgres-policy-contracts').DEFINITIONS)
        .map(([domain,definition])=>[domain,definition.description.slice(0,55)]))})),
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
  const alternative=catalogue.get(raw.closestAlternative);
  return {steps,clarifyingQuestion:conciseClarification(raw.clarifyingQuestion),
    closestAlternative:alternative?.discovery?alternative.name:null};
}

async function plan(provider,message,{catalogue=registry,history=[],pending=null,page=null,workspace=null,
  deferReadFit=false,feedback=null}={}){
  if(!provider)return {steps:[],clarifyingQuestion:'StockChief cannot interpret free-form requests while its reasoning connection is unavailable. Nothing changed.'};
  const context={message,
    workspace,
    conversation:history.slice(-6).map(({message,answer,status})=>({message,answer,status})),
    pending:pending?{capability:pending.capability,args:pending.args,question:pending.question,
      status:pending.status,awaitingField:pending.awaitingField||null,
      proposalPending:Boolean(pending.proposalId)}:null,
    executionFeedback:feedback||null,
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
  let reconsidered=false;
  if(!selected.steps.length){
    // A single model miss must not turn a registered, ordinary question into
    // an unsupported feature. Reconsider once against the same contracts;
    // the independent fit check below still rejects a merely related action.
    try{
      const retry=await provider.complete({system:systemFor(catalogue),
        prompt:JSON.stringify({...context,rejectedPlan:response.data,
          instruction:'Reconsider the current request independently. If an exact registered read or action can fulfill it, choose that contract. If none can, return no steps. Do not substitute a related but different effect.'}),
        schema:schemaFor(catalogue),schemaName:'stockchief_capability_plan'});
      selected=parseSteps(retry.data,catalogue);
      reconsidered=true;
    }catch(error){if(error.code==='entitlement_required')throw error;}
  }
  // Read-only plans can be checked against actual evidence by the answer
  // stage, which can request a broader registered read when needed.
  if(deferReadFit&&!reconsidered&&selected.steps.length&&selected.steps.every((step)=>step.contract.kind==='read'))
    return selected;
  // Without a registered step, a model-authored explanation could silently
  // reinterpret an unavailable effect as a related operation. Never expose
  // that speculative explanation as an instruction to the owner.
  if(!selected.steps.length)return {steps:[],clarifyingQuestion:SAFE_CLARIFICATION,
    closestAlternative:selected.closestAlternative||null};
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
