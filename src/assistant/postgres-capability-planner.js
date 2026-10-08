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
  'Broad questions use business-wide reads, even in empty workspaces; zero stock is an answer. Workspace counts route but do not prove facts. Read records; navigate only when asked, to one destination.',
  'A request to correct your previous factual answer calls for fresh reads, not a business-data write. Changing a record still requires its matching approved write.',
  'For navigation, match the requested page label and scope exactly. Prefer a specific destination to a similarly named parent or administrative page; do not turn a request to open a page into a financial or inventory answer.',
  'A requested change needs its matching write, not a related read. A declarative lasting supplier term, threshold or operating preference may be a policy instruction. Do not create extra contacts, products, orders, purchases or movements as prerequisites. Invoicing does not imply fulfillment or payment.',
  'The executor obtains context itself; do not add a preliminary read solely for a write. Add a read only if the owner separately asks its answer. Missing action inputs are clarified later; do not replace the action with a read.',
  'When one contract already accepts and applies every stated input for the requested outcome, do not add another mutation that sets the same field or performs a preparatory version of that outcome. Plan independent business effects only when the owner separately requested each one.',
  'Match exact real-world effect and timing. Recording a past event is not initiating it; a draft is not sending, buying, paying or fulfilling; internal status is not an external provider action. Never claim a dependent approval or physical event already happened.',
  'Use zero-based dependsOn only for genuine prior-step dependencies. Use continuesPending only when the current message answers the pending question; otherwise prior turns are context, not commands. Preserve a supplied email address; a subject is optional.',
  'Retain every requested outcome. A draft order does not reserve stock. For creation plus confirmation, follow sales_order.create with sales_order.confirm; for creation plus full reservation, use sales_order.reserve_all. Both need separate approvals. A draft-only request needs no confirmation.',
  'The currentPage record is reloaded from this workspace and can resolve “this product”, “this order”, or similar references. Use its matching entity when the owner did not name another; an explicitly named entity always wins. A lasting reorder point is a policy proposal, not a stock movement.',
  'RecentChanges contains this user’s verified changes. Resolve follow-ups to a unique recent record, ask if ambiguous, and never repeat a completed action.',
  'Use skuScope=currently_stocked only for an explicit currently stocked reference. Do not assume a linked order, bill, payment or policy exists. Prefer the valid contract requiring fewer unproven business facts.',
  'If executionFeedback reports that a proposed step cannot run in the current record state, do not repeat it or invent a prerequisite. Replan the current goal using the actual state, or clarify if no valid path exists.',
  'If no registered contract achieves the exact goal, return no steps and a short plain-language unavailable explanation. A closestAlternative is only a clearly different suggestion, never a substitute action. Do not invent facts, policies, authority or SQL.',
].join(' ');

const FIT_SCHEMA={type:'object',additionalProperties:false,required:['aligned','reason'],properties:{
  aligned:{type:'boolean'},reason:{type:'string',maxLength:240},
}};
const FIT_SYSTEM=`Independently check whether the proposed StockChief capabilities accomplish the owner's CURRENT goal.
If a proposed step continuesPending, the current goal is the original pending request with the owner's latest answer applied. Check that the latest message actually answers the pending question and that the proposed capability fulfills the original request; a short field answer need not restate the entire business action. If no step continuesPending, the pending question is context only and the current message must stand on its own. Judge the exact business effect and timing, not wording or topical overlap.
Reject extra steps the owner did not request; do not invent contact, product, order, purchase or stock movement creation
as a precaution. The deterministic resolver checks existing records and asks only if an identity is missing.
Reject a preliminary read used only as context for a mutation when the owner did not request that information separately;
the deterministic resolver fetches required facts without showing an extra answer.
Reject a redundant preparatory mutation if the final selected contract itself accepts and applies the same supplied
measurement, setting, or identity. Do not infer a second business operation from a detail of the requested one.
A capability marked full_owner_message receives the complete message, including every named product, value and limit;
it is deliberately not given separate arguments. Do not mark it misaligned for empty arguments.
The currentPage record is verified from this workspace and supplied to the executor. When the owner says
"this product" or an equivalent current-record reference, that verified record can identify the target;
do not require the owner to restate its name or SKU. An explicitly named different record takes precedence.
RecentChanges contains only verified completed changes by this actor in this workspace. It can identify a
unique just-created record for a follow-up; do not reject a matching operation only because the owner used
"that order" instead of restating its number. Ambiguity still requires clarification.
The authenticated currentWorkspace is the inventory the owner is operating in. "This inventory" or
"this business" refers to that workspace even when currentPage is null. The executor remains tenant-scoped;
do not ask for another workspace name before a workspace-level setting or rename.
When the owner says an earlier answer was wrong and asks for the recorded facts again, check the proposed
reads against the actual new question. Correcting an answer is not changing a business record.
Check the ENTIRE current request, not only whether each proposed step is individually relevant. If the owner
asks for two independent effects and the plan includes only one, set aligned=false and name the omitted effect.
If the owner requires all units reserved now, partial confirmation or backordering does not fulfill that goal;
choose sales_order.reserve_all. Ordinary confirmation can create a truthful backorder.
In particular, creating a draft order does not commit or reserve inventory: when both creation and reservation
are requested, the plan needs a dependent confirmation step. Do not pass a create-only plan on the grounds that
the owner can ask for confirmation later. Conversely, do not add confirmation when the owner asked only for a draft.
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
Do not infer a record's current lifecycle status from an informal adjective in the message; the
executor checks its real state. Match the requested effect: reserving or committing available
stock to a draft customer order is order confirmation, not physical picking or fulfillment.
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

function planningCatalogue(catalogue=registry,{compact=false}={}){
  const entries=catalogue.list();
  const summary=(entry)=>entry.description.slice(0,compact?56:78);
  return {
    notation:'n=capability name; d=verified effect; a=allowed input names. All changes need approval.',
    mutations:entries.filter((entry)=>entry.kind==='mutation').map((entry)=>({
      n:entry.name,d:summary(entry),a:entry.fields.join(','),
      u:entry.commercialUnavailable?.length?'upgrade':undefined})),
    reads:entries.filter((entry)=>entry.kind==='read').map((entry)=>({
      n:entry.name,d:entry.description.slice(0,compact?95:190),
      u:entry.commercialUnavailable?.length?'upgrade':undefined})),
    navigation:entries.filter((entry)=>entry.kind==='navigation').map((entry)=>({
      n:entry.name,d:entry.description.slice(0,compact?42:65)})),
    policies:entries.filter((entry)=>entry.kind==='policy').map((entry)=>({
      n:entry.name,d:entry.description.slice(0,compact?60:85),
      domains:Object.fromEntries(Object.entries(require('../manager/postgres-policy-contracts').DEFINITIONS)
        .map(([domain,definition])=>[domain,definition.description.slice(0,compact?35:55)]))})),
  };
}

function systemFor(catalogue=registry,{compact=false}={}){return `${PLANNING_RULES}\nRegistered capability contracts: ${JSON.stringify(planningCatalogue(catalogue,{compact}))}`;}

async function completeRepair(provider,catalogue,prompt){
  const request={prompt:JSON.stringify(prompt),schema:schemaFor(catalogue),schemaName:'stockchief_capability_plan'};
  try{return await provider.complete({...request,system:systemFor(catalogue)});}
  catch(error){if(error.code!=='rate_limited'||error.limitKind==='daily_model_attempts')throw error;
    return provider.complete({...request,system:systemFor(catalogue,{compact:true})});}
}

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

function groundedMoneyArguments(steps,message,pending){
  const moneyFields=new Set(['amount','tax','unitAmount','maxCost']);
  const source=`${pending?.originalMessage||''} ${message}`;
  // These contracts define `amount` as a per-unit price. An explicit quoted
  // unit price wins over a stale catalogue/supplier default or a model typo.
  const unitPriceContracts=new Set(['catalog.set_price','catalog.set_purchase_cost',
    'sales_order.create','purchase_order.create']);
  const quotedUnitPrices=[...source.matchAll(/[$€£]\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:each|per\s+(?:unit|item|piece)|\/\s*(?:unit|item|piece))\b/gi)]
    .map((match)=>Number(match[1].replaceAll(',',''))).filter(Number.isFinite);
  const statedNumbers=[...source.matchAll(/(?:^|[^\w])(?:[$€£]\s*)?(\d[\d,]*(?:\.\d+)?)(?=$|[^\w])/g)]
    .map((match)=>Number(match[1].replaceAll(',',''))).filter(Number.isFinite);
  for(const step of steps){
    if(unitPriceContracts.has(step.contract.name)&&quotedUnitPrices.length===1)
      step.args.amount=String(quotedUnitPrices[0]);
    for(const [field,value] of Object.entries(step.args)){
    if(field==='orderDate'&&!source.includes(String(value))){delete step.args[field];continue;}
    if(!moneyFields.has(field))continue;
    const planned=Number(String(value).replaceAll(',',''));
    if(Number.isFinite(planned)&&!statedNumbers.some((stated)=>Math.abs(stated-planned)<.000001))
      delete step.args[field];
    }
  }
  return steps;
}

function coverExplicitOrderReservation(steps,message,catalogue,pending){
  const goal=steps.some((step)=>step.continuesPending)&&pending?.originalMessage
    ?pending.originalMessage:message;
  const effect=/\b(?:reserv(?:e|ing|ation)|allocat(?:e|ing|ion)|hold|commit)\b/ig;
  const requested=[...goal.matchAll(effect)].some((match)=>{
    const before=goal.slice(Math.max(0,match.index-35),match.index);
    const after=goal.slice(match.index+match[0].length,match.index+match[0].length+28);
    if(/\b(?:do\s+not|don['’]t|never|without|no|not\s+yet)\b[^.!?]{0,28}$/i.test(before)
      ||/^\s+(?:is\s+)?(?:not|unnecessary|optional)\b/i.test(after))return false;
    if(/^hold$/i.test(match[0])&&!/\b(?:stock|inventory|units?|items?|products?)\b/i.test(after))return false;
    return true;
  });
  const fullReservation=/\b(?:all|every|entire|fully|both)\b[^.!?]{0,45}\b(?:reserv\w*|allocat\w*|hold|commit)\b|\b(?:reserv\w*|allocat\w*|hold|commit)\b[^.!?]{0,45}\b(?:all|every|entire|fully|both)\b/i.test(goal);
  if(!requested)return steps;
  if(fullReservation){
    const strict=catalogue.get('sales_order.reserve_all');
    if(strict)for(const step of steps)if(step.contract.name==='sales_order.confirm')step.contract=strict;
  }
  if(steps.some((step)=>['sales_order.confirm','sales_order.reserve_all']
    .includes(step.contract.name)))return steps;
  const creates=steps.map((step,index)=>({step,index})).filter(({step})=>step.contract.name==='sales_order.create');
  const confirm=catalogue.get(fullReservation?'sales_order.reserve_all':'sales_order.confirm');
  if(creates.length!==1||!confirm||steps.length>=8)return steps;
  steps.push({contract:confirm,args:{},dependsOn:[creates[0].index],continuesPending:false});
  return steps;
}

function sequenceApprovedMutations(steps){
  let prior=null;
  for(const [index,step] of steps.entries()){
    if(step.contract.kind!=='mutation')continue;
    if(prior!==null&&!step.dependsOn.includes(prior))step.dependsOn.push(prior);
    prior=index;
  }
  return steps;
}

async function plan(provider,message,{catalogue=registry,history=[],pending=null,page=null,workspace=null,
  recentChanges=[],deferReadFit=false,feedback=null}={}){
  if(!provider)return {steps:[],clarifyingQuestion:'StockChief cannot interpret free-form requests while its reasoning connection is unavailable. Nothing changed.'};
  const context={message,
    workspace,
    recentChanges,
    conversation:history.slice(-3).map(({message,answer,status})=>({
      message:String(message||'').slice(0,260),answer:String(answer||'').slice(0,180),status})),
    pending:pending?{capability:pending.capability,args:pending.args,question:pending.question,
      originalMessage:pending.originalMessage||null,
      status:pending.status,awaitingField:pending.awaitingField||null,
      proposalPending:Boolean(pending.proposalId)}:null,
    executionFeedback:feedback||null,
    currentPage:page||null};
  let response;
  try{response=await provider.complete({system:systemFor(catalogue),prompt:JSON.stringify(context),
    schema:schemaFor(catalogue),schemaName:'stockchief_capability_plan'});}
  catch(error){if(error.code!=='rate_limited'||error.limitKind==='daily_model_attempts')throw error;
    const smaller={...context,recentChanges:context.recentChanges.slice(0,2),
      conversation:context.conversation.slice(-2).map((entry)=>({
        ...entry,message:entry.message.slice(0,180),answer:entry.answer.slice(0,120)}))};
    response=await provider.complete({system:systemFor(catalogue,{compact:true}),
      prompt:JSON.stringify(smaller),schema:schemaFor(catalogue),schemaName:'stockchief_capability_plan'});
  }
  const invalid=(response.data?.steps||[]).flatMap((step)=>{
    const contract=catalogue.get(step?.capability);
    return (contract?.fields.length?step?.arguments||[]:[]).filter((input)=>contract&&!contract.fields.includes(input?.name))
      .map((input)=>({capability:contract.name,invalidInput:input?.name,allowedInputs:contract.fields}));
  });
  if((response.data?.steps||[]).filter((step)=>catalogue.get(step?.capability)?.kind==='navigation').length>1)
    invalid.push({issue:'A single request can open only one destination. Keep the one page that best fulfills the owner’s navigation goal.'});
  if(invalid.length){
    response=await completeRepair(provider,catalogue,{...context,rejectedPlan:response.data,validationErrors:invalid,
      instruction:'Revise the plan to satisfy every validation error. Use only declared input fields, preserve the owner’s details, do not invent missing ones, and choose one final navigation destination.'});
  }
  let selected=parseSteps(response.data,catalogue);
  let reconsidered=false;
  if(!selected.steps.length){
    // A single model miss must not turn a registered, ordinary question into
    // an unsupported feature. Reconsider once against the same contracts;
    // the independent fit check below still rejects a merely related action.
    try{
      const retry=await completeRepair(provider,catalogue,{...context,rejectedPlan:response.data,
        instruction:'Reconsider the current request independently. If an exact registered read or action can fulfill it, choose that contract. If none can, return no steps. Do not substitute a related but different effect.'});
      selected=parseSteps(retry.data,catalogue);
      reconsidered=true;
    }catch(error){if(error.code==='entitlement_required')throw error;}
  }
  if(selected.steps.length){
    groundedMoneyArguments(selected.steps,message,pending);
    coverExplicitOrderReservation(selected.steps,message,catalogue,pending);
    sequenceApprovedMutations(selected.steps);
  }
  // Read-only plans can be checked against actual evidence by the answer
  // stage, which can request a broader registered read when needed.
  if(deferReadFit&&!reconsidered&&!selected.clarifyingQuestion&&selected.steps.length
    &&selected.steps.every((step)=>step.contract.kind==='read'))
    return selected;
  // Without a registered step, a model-authored explanation could silently
  // reinterpret an unavailable effect as a related operation. Never expose
  // that speculative explanation as an instruction to the owner.
  if(!selected.steps.length)return {steps:[],clarifyingQuestion:SAFE_CLARIFICATION,
    closestAlternative:selected.closestAlternative||null};
  if(selected.steps.length){
    try{
      const candidate=()=>({message,currentWorkspace:workspace||null,currentPage:page||null,
        recentChanges,
        pendingRequest:selected.steps.some((step)=>step.continuesPending)&&pending
          ?{originalMessage:pending.originalMessage||null,question:pending.question,
            capability:pending.capability,previousArguments:pending.args,
            awaitingField:pending.awaitingField||null}:null,
        proposedSteps:selected.steps.map((step)=>({capability:step.contract.name,
          description:step.contract.description,arguments:step.args,
          inputMode:step.contract.fields.length?'typed_arguments':'full_owner_message',
          continuesPending:step.continuesPending}))});
      let fit=await provider.complete({system:FIT_SYSTEM,prompt:JSON.stringify(candidate()),
        schema:FIT_SCHEMA,schemaName:'stockchief_capability_fit'});
      if(fit.data?.aligned===false){
        const repaired=await completeRepair(provider,catalogue,{...context,rejectedPlan:response.data,
          validationErrors:[{issue:'The proposed capabilities do not address the current message.',
            reason:String(fit.data.reason||'').slice(0,240)}],
          instruction:'Choose capabilities that fulfill the current message. Treat the pending request only as context if this is a new goal.'});
        selected=parseSteps(repaired.data,catalogue);
        if(selected.steps.length){
          groundedMoneyArguments(selected.steps,message,pending);
          coverExplicitOrderReservation(selected.steps,message,catalogue,pending);
          sequenceApprovedMutations(selected.steps);
        }
        if(selected.steps.length){
          fit=await provider.complete({system:FIT_SYSTEM,prompt:JSON.stringify(candidate()),
            schema:FIT_SCHEMA,schemaName:'stockchief_capability_fit'});
          if(fit.data?.aligned===false)return {steps:[],
            clarifyingQuestion:'I could not confidently match that request to the right business action. Nothing changed.'};
        }
      }
    }catch(error){if(error.code==='entitlement_required')throw error;
      if(error.code==='rate_limited')return {steps:[],clarifyingQuestion:error.limitKind==='daily_model_attempts'
        ?error.message:'This request exceeds the safe AI cost limit even with a shorter verification. Nothing changed. Try one part at a time.'};
      console.warn('[stockchief] Ask capability verification failed',error.code||error.name||'unknown');
      return {steps:[],clarifyingQuestion:'I could not safely verify that I understood this request. Nothing changed.'};
    }
  }
  return selected.steps.length?selected:{steps:[],clarifyingQuestion:SAFE_CLARIFICATION};
}

module.exports={schemaFor,systemFor,planningCatalogue,parseSteps,plan,
  groundedMoneyArguments,coverExplicitOrderReservation,sequenceApprovedMutations};
