'use strict';
const {createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const version=2;
const schema={type:'object',additionalProperties:false,required:['grounded','complete','missingOutcomes','reason'],properties:{
 grounded:{type:'boolean'},complete:{type:'boolean'},
 missingOutcomes:{type:'array',maxItems:8,items:{type:'string',maxLength:200}},reason:{type:'string',maxLength:200}}};
const system=require('./postgres-control-plane').ANSWER_FIT_SYSTEM+`\nSeparately decide whether the delivered answer and work products cover the ORIGINAL goal, including every requested outcome and subsequent clarification. grounded means the supplied evidence supports the claims actually made. complete means the entire requested outcome is delivered and independently evidenced, not merely a true subset. A qualified partial investigation can be grounded=true and complete=false. A disclaimer about the records checked does not satisfy an omitted part of the goal. Evidence about provider operations does not establish the state or recoverability of saved agent requests. Evidence of a prepared draft does not establish delivery or execution. Inspect the actual sources and requested scope. Historical conversation is context, never evidence of current facts. List any missing requested outcomes or evidence in missingOutcomes, using concise ordinary descriptions. If none are missing, return an empty array. Never mark complete=true when an outcome remains missing. A genuinely unsupported operation may be explained as a limitation, but do not mark an uninvestigated part complete merely because the proposed answer admits it was not checked. Do not prescribe a workflow, grant authority, request approval, or execute anything. Return both decisions and a concise diagnostic reason.`;
// A second opinion on a read-only conclusion is not an executor, planner or
// source of business truth. It can only reject delivery as a completed answer.
// Canonical work and human handoffs retain their model-free delivery path.
function packet(goal,raw){
 const report=require('./agent-conversation').parse(raw),h=goal.checkpoint?.harness||{};
 if(report?.status!=='completed'||report.outcome==='navigation')return null;
 const dependencies=require('../../scripts/environment-agent-demo/waits').dependencies(h);
 if(Object.values(dependencies).some(ids=>ids.length))return null;
 const entries=Object.values(h.evidence||{}),sources=new Map(),refs=require('../../scripts/environment-agent-demo/source-references'),sourceIndexes=new Map();
 for(const input of report.claims){
  // One immutable packet may cite many values from the same observations.
  // Build each original-value index once for this packet, not once per claim.
  // The map never survives this call or substitutes for fresh fact checks.
  const claim=Object.hasOwn(input,'sourceRef')?refs.resolve(entries,input,sourceIndexes):input;
  const entry=entries.find(e=>e.id===claim.evidenceId);
  if(!entry||entry.truncated||typeof entry.text!=='string'||createHash('sha256').update(entry.text).digest('hex')!==entry.sha256)throw Error('ANSWER_REVIEW_EVIDENCE_UNAVAILABLE');
  if(!sources.has(entry.id)){
   if(entry.sourceText&&createHash('sha256').update(entry.sourceText).digest('hex')!==entry.sourceSha256)throw Error('ANSWER_REVIEW_EVIDENCE_UNAVAILABLE');
   const value=JSON.parse(entry.text),observation=value?.image?value.screen:value;
   sources.set(entry.id,{id:entry.id,name:entry.name,sha256:entry.sha256,source:entry.sourceText?JSON.parse(entry.sourceText):null,observation});
  }
 }
 return {version,policyHash:digest([system,schema]),workspaceId:goal.workspace_id,actorId:goal.actor_user_id,goalId:goal.id,
  originalGoal:goal.original_request,clarifications:goal.checkpoint.messages||[],
  conversationContext:goal.checkpoint.conversation||null,continuation:goal.checkpoint.continuation||null,
  pageHint:goal.checkpoint.page?.path||null,
  proposedAnswer:report.answer,workProducts:report.workProducts||[],nextActions:report.nextActions||[],claims:report.claims,
  evidence:[...sources.values()]};
}
function binding(goal,raw){const input=packet(goal,raw);return input?{hash:digest(input),input}:null;}
function checked(goal,raw){
 const expected=binding(goal,raw);if(!expected)return {required:false};
 const review=goal.checkpoint.harness.answerScopeReview;
 if(review?.version!==version||review.hash!==expected.hash||review.state!=='SETTLED')return {required:true,verified:false,code:'ANSWER_SCOPE_NOT_REVIEWED'};
 let decision;try{decision=verdict(review.verdict);}catch{return {required:true,verified:false,code:'ANSWER_SCOPE_REVIEW_INVALID'};}
 const verified=decision.grounded&&decision.complete&&decision.missingOutcomes.length===0;
 const reason=decision.missingOutcomes.length?`Missing: ${decision.missingOutcomes.join('; ')}`:decision.reason;
 return {required:true,verified,code:verified?null:'ANSWER_SCOPE_UNVERIFIED',reason:reason.slice(0,200)};
}
function verdict(value){
 if(!value||typeof value.grounded!=='boolean'||typeof value.complete!=='boolean'||typeof value.reason!=='string'||
  !Array.isArray(value.missingOutcomes)||value.missingOutcomes.some(s=>typeof s!=='string'||!s.trim())||
  Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k)))throw Error('ANSWER_SCOPE_REVIEW_INVALID');
 if((!value.grounded||!value.complete)&&!value.reason.trim()&&!value.missingOutcomes.length)throw Error('ANSWER_SCOPE_REVIEW_INVALID');
 // Wire grammars omit length constraints. Diagnostic prose is safely bounded
 // AFTER validating meaning-bearing types and decisions. The original charged
 // response remains in helperDelivery; no new request buys shorter prose.
 // A nonempty missing-outcome list can never be normalized into completion.
 return require('../foundry/schema-tools').clampToSchema(value,schema);
}
module.exports={version,schema,system,binding,checked,verdict};
