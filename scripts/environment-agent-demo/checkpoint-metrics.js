'use strict';
const fs=require('node:fs'),path=require('node:path');
function receiptCost(detail){
 const {provider,usage:u}=detail;if(!u)return null;
 if(provider==='openai'){
  const cached=u.input_tokens_details?.cached_tokens||0,written=u.input_tokens_details?.cache_write_tokens||0;
  return ((u.input_tokens-cached-written)*2+cached*.1+written*2.5+u.output_tokens*10)/1e6;
 }
 const hour=u.cache_creation?.ephemeral_1h_input_tokens||0;
 const short=u.cache_creation?.ephemeral_5m_input_tokens??Math.max(0,(u.cache_creation_input_tokens||0)-hour);
 return (u.input_tokens*2+(u.cache_read_input_tokens||0)*.2+short*2.5+hour*4+u.output_tokens*10)/1e6;
}
function summarize(){
 const {directory,EXPERIMENT}=require('./run-checkpoint'),{directory:root}=require('./certification');
 const data=JSON.parse(fs.readFileSync(path.join(directory,'results.json'),'utf8'));
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(root,'spending.sqlite'),{readOnly:true});
 const calls=db.prepare('SELECT * FROM experiment_calls WHERE experiment=?').all(EXPERIMENT);db.close();
 const attempts=data.attempts.filter(a=>a.result).map(a=>{
  const r=a.result,rows=calls.filter(c=>c.task===a.task&&c.candidate===a.candidate);
  const trace=fs.readFileSync(path.join(directory,a.task,a.candidate,'trace.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  return {...r,receiptPricedUsd:rows.filter(c=>c.state==='SETTLED').reduce((n,c)=>n+(receiptCost(JSON.parse(c.detail||'{}'))||0),0),
   blockedCalls:trace.filter(e=>e.kind==='model_call_blocked'),
   agentBrowserActions:trace.filter(e=>e.kind==='agent_tool_started'&&e.name==='environment_browser').map(e=>({callId:e.sdkToolCallId,...e.input})),
   uiErrors:trace.filter(e=>e.kind==='browser_observation'&&(e.screen.status>=400||/Internal Server Error/.test(e.screen.text||''))).length,
   humanApprovalWaitSeconds:trace.filter(e=>e.kind==='human_approval_decision').reduce((n,e)=>n+(e.waitMs||0),0)/1000};
 });
 const candidates=['openai','adaptive','claude'].map(candidate=>{
  const rows=attempts.filter(r=>r.candidate===candidate);
  return {candidate,attempts:rows.length,completed:rows.filter(r=>r.completedExperience).length,verifiedOutcomes:rows.filter(r=>r.verifiedOutcome).length,
   browserTasks:rows.filter(r=>r.browserOperatedByAgent).length,humanReviews:rows.reduce((n,r)=>n+r.humanReviewsRequested,0),
   humanResponses:rows.reduce((n,r)=>n+r.actualHumanApprovalResponses,0),requiredApprovalsExecuted:rows.reduce((n,r)=>n+r.requiredApprovalsExecuted,0),
   correctiveMessages:rows.reduce((n,r)=>n+r.correctiveMessages,0),operatorRescues:rows.reduce((n,r)=>n+r.operatorRescues,0),
   toolFailures:rows.reduce((n,r)=>n+r.toolFailures,0),receiptPricedUsd:rows.reduce((n,r)=>n+r.receiptPricedUsd,0),
   ledgerUsd:rows.reduce((n,r)=>n+r.conservativeCostUsd,0)};
 });
 const result={generatedAt:new Date().toISOString(),budget:data.budget,stopReason:data.stopReason,excluded:data.manifest.excluded,candidates,attempts,
  totalReceiptPricedUsd:candidates.reduce((n,c)=>n+c.receiptPricedUsd,0),invoiceVerified:false,
  costBasis:'API usage receipts at pinned standard prices; conservative ledger prices all input as uncached and includes maximum unknown exposure.',
  unattempted:data.manifest.slots.filter(s=>!attempts.some(a=>a.task===s.task&&a.candidate===s.candidate))};
 fs.writeFileSync(path.join(directory,'metrics.json'),JSON.stringify(result,null,2));return result;
}
if(require.main===module){const r=summarize();console.log(JSON.stringify({budget:r.budget,candidates:r.candidates,totalReceiptPricedUsd:r.totalReceiptPricedUsd,unattempted:r.unattempted},null,2));}
module.exports={receiptCost,summarize};
