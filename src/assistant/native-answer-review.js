'use strict';
const {createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const version=1;
// A second opinion on a read-only conclusion is not an executor, planner or
// source of business truth. It can only reject delivery as a completed answer.
// Canonical work and human handoffs retain their model-free delivery path.
function packet(goal,raw){
 const report=require('./agent-conversation').parse(raw),h=goal.checkpoint?.harness||{};
 if(report?.status!=='completed'||report.outcome==='navigation')return null;
 const dependencies=require('../../scripts/environment-agent-demo/waits').dependencies(h);
 if(Object.values(dependencies).some(ids=>ids.length))return null;
 const entries=Object.values(h.evidence||{}),sources=new Map(),refs=require('../../scripts/environment-agent-demo/source-references');
 for(const input of report.claims){
  const claim=Object.hasOwn(input,'sourceRef')?refs.resolve(entries,input):input;
  const entry=entries.find(e=>e.id===claim.evidenceId);
  if(!entry||entry.truncated||typeof entry.text!=='string'||createHash('sha256').update(entry.text).digest('hex')!==entry.sha256)throw Error('ANSWER_REVIEW_EVIDENCE_UNAVAILABLE');
  if(!sources.has(entry.id)){
   if(entry.sourceText&&createHash('sha256').update(entry.sourceText).digest('hex')!==entry.sourceSha256)throw Error('ANSWER_REVIEW_EVIDENCE_UNAVAILABLE');
   const value=JSON.parse(entry.text),observation=value?.image?value.screen:value;
   sources.set(entry.id,{id:entry.id,name:entry.name,sha256:entry.sha256,source:entry.sourceText?JSON.parse(entry.sourceText):null,observation});
  }
 }
 const fit=require('./postgres-control-plane');
 return {version,policyHash:digest([fit.ANSWER_FIT_SYSTEM,fit.ANSWER_FIT_SCHEMA]),workspaceId:goal.workspace_id,actorId:goal.actor_user_id,goalId:goal.id,
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
 return {required:true,verified:review.verdict?.grounded===true,code:review.verdict?.grounded===true?null:'ANSWER_SCOPE_UNVERIFIED',reason:review.verdict?.reason||''};
}
function verdict(value){
 if(!value||typeof value.grounded!=='boolean'||typeof value.reason!=='string'||value.reason.length>200||Object.keys(value).some(k=>!['grounded','reason'].includes(k)))throw Error('ANSWER_SCOPE_REVIEW_INVALID');
 if(!value.grounded&&!value.reason.trim())throw Error('ANSWER_SCOPE_REVIEW_INVALID');
 return {grounded:value.grounded,reason:value.reason};
}
module.exports={version,binding,checked,verdict};
