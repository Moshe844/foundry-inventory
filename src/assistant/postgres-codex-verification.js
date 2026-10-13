'use strict';
const {createHash}=require('node:crypto');
// Models identify claims; the host checks their values against durable evidence
// and canonical PostgreSQL effects. A model's success flag alone is insufficient.
async function verify(database,ctx,goal,raw,catalogue){
 let report;try{report=JSON.parse(raw);}catch{return {verified:false,answer:raw};}
 if(report.status==='needs_user')return {verified:false,answer:raw};
 if(report.status!=='completed'||typeof report.answer!=='string'||!Array.isArray(report.claims)||!report.claims.length||report.claims.length>50)
  return {verified:false,answer:report.answer||raw};
 const h=goal.checkpoint.harness;
 const receipt=await require('../../scripts/environment-agent-demo/receipts').collect(database,ctx,goal,h,catalogue);
 if(receipt.dependencyState!=='READY'||receipt.operations.some(o=>!o.verified))return {verified:false,answer:report.answer,receipt};
 const evidence=h.evidence||{};
 const entries=Array.isArray(evidence)?evidence:Object.values(evidence);
 const observed=Object.values(h.calls||{}).filter(c=>c.state==='DONE').map(c=>c.result);
 function find(id){
  // Evidence journal implementation uses a keyed entries object. Never trust
  // an ID merely because it appears in the model's answer.
  const journal=Array.isArray(evidence.entries)?evidence.entries:Object.values(evidence.entries||{});
  return [...entries,...journal].find(e=>e?.id===id||e?.evidenceId===id)||observed.find(e=>e?._stockchiefEvidence?.evidenceId===id);
 }
 const lastExecution=(await database.query(`SELECT max(executed_at) AS at FROM stockchief_runtime.assistant_action_proposals
  WHERE workspace_id=$1 AND actor_user_id=$2 AND id=ANY($3::text[])`,[ctx.workspaceId,ctx.actorId,receipt.operations.map(o=>o.proposalId)])).rows[0].at;
 const verified=[];
 for(const claim of report.claims){
  if(typeof claim.evidenceId!=='string'||typeof claim.path!=='string'||!claim.path.startsWith('/')||claim.path.length>400)return {verified:false,answer:report.answer};
  const entry=find(claim.evidenceId);if(!entry)return {verified:false,answer:report.answer};
  if(entry.truncated||entry.text&&createHash('sha256').update(entry.text).digest('hex')!==entry.sha256)return {verified:false,answer:report.answer};
  if(lastExecution&&claim.historical!==true&&new Date(entry.at)<new Date(lastExecution))return {verified:false,answer:report.answer};
  let value=entry.text?JSON.parse(entry.text):entry.value??entry.output??entry.result??entry;
  for(const part of claim.path.slice(1).split('/')){const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
   if(['__proto__','constructor','prototype'].includes(key)||value===null||typeof value!=='object'||!Object.hasOwn(value,key))return {verified:false,answer:report.answer};
   value=value[key];}
  if(JSON.stringify(value)!==JSON.stringify(claim.value))return {verified:false,answer:report.answer};
  verified.push({evidenceId:claim.evidenceId,path:claim.path,sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex')});
 }
 return {verified:true,answer:report.answer,receipt,claims:verified};
}
const instructions=`\nFor your final report return JSON with status "completed", answer, and claims: [{evidenceId,path,value}].
Each factual claim must reference actual durable evidence by ID and a JSON Pointer to its exact recorded value.
Current-state claims after execution require fresh observations. Mark a historical claim historical:true and describe its time/scope explicitly.
Use the complete evidence already in a tool response. Its _stockchiefEvidence reference supplies evidenceId and valuePointerPrefix; prepend that prefix to the JSON Pointer of the displayed value. Retrieve the journal only for missing, truncated, compacted or earlier evidence. Do not retrieve a value again just to report what the current response already shows. Include current-state verification after authorized changes.
Use status "needs_user", question and missingInformation only for an actual missing human decision.
If complete outcomes cannot be established, report status "blocked" and answer explaining the limitation.
Never claim every part of a request was completed merely because one receipt was verified.`;
module.exports={verify,instructions};
