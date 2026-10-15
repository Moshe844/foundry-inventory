'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const unavailable=(answer,code)=>({verified:false,answer,report:{version:1,status:'blocked',answer},verificationFailure:code});
// Models identify claims; the host checks their values against durable evidence
// and canonical PostgreSQL effects. A model's success flag alone is insufficient.
async function verify(database,ctx,goal,raw,catalogue,options={}){
 const conversation=require('./agent-conversation'),report=conversation.parse(raw);
 if(!report)return {verified:false,answer:conversation.FAILED};
 if(report.status==='needs_user')return {verified:false,answer:report.question,report};
 if(report.status==='blocked')return {verified:false,answer:conversation.publicText(report.answer),report};
 if(conversation.publicText(report.answer,'')!==report.answer)return {verified:false,answer:conversation.FAILED};
 if(report.status==='completed'&&goal.checkpoint.clientIntegration===1&&!['answer','navigation'].includes(report.outcome))
  return {verified:false,answer:'I could not verify delivery of the requested result. A page inspected by the agent is not proof that it opened in your browser.'};
 if(report.status!=='completed'||typeof report.answer!=='string'||!Array.isArray(report.claims)||
  (!report.claims.length&&report.outcome!=='navigation')||report.claims.length>50)
  return {verified:false,answer:conversation.publicText(report.answer)};
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
 const verified=[],fresh=new Map();
 for(const claim of report.claims){
  if(typeof claim.evidenceId!=='string'||typeof claim.path!=='string'||!claim.path.startsWith('/')||claim.path.length>400)return {verified:false,answer:report.answer};
  const entry=find(claim.evidenceId);if(!entry)return {verified:false,answer:report.answer};
  if(entry.truncated||entry.text&&createHash('sha256').update(entry.text).digest('hex')!==entry.sha256)return {verified:false,answer:report.answer};
  if(lastExecution&&claim.historical!==true&&new Date(entry.at)<new Date(lastExecution))return {verified:false,answer:report.answer};
  const original=entry.text?JSON.parse(entry.text):entry.value??entry.output??entry.result??entry;
  const presentation=require('../../scripts/environment-agent-demo/evidence-presentation');
  let selected=presentation.locate(original,claim.path),toolView=false;
  if(!selected.found||!equal(selected.value,claim.value)){
   // The same lossless codec that delivered this observation is the only
   // alternative representation accepted. No arbitrary projection/subset.
   selected=presentation.locate(presentation.project(entry.name,original),claim.path);
   if(!selected.found||!equal(selected.value,claim.value))return {verified:false,answer:report.answer};
   toolView=true;
  }
  const value=selected.value;
  if(claim.historical!==true){
   if(!fresh.has(entry.id)){
    try{fresh.set(entry.id,await require('./agent-evidence-verification').current(database,ctx,goal,entry,{catalogue,...options}));}
    catch(error){return unavailable('I could not confirm that the collected information still matches the current records. Your request and recorded work are saved.',error.message);}
   }
   const currentClaim=presentation.locate(toolView?presentation.project(entry.name,fresh.get(entry.id)):fresh.get(entry.id),claim.path);
   const current=currentClaim.value,missingCurrent=!currentClaim.found;
   // Controls, like text offsets and loopback ports, have observation-local
   // identity. Verify their complete semantic facts before trusting an array
   // position, even when an unrelated field happens to contain the same value.
   const control=entry.name==='environment_browser'?require('./browser-control-verification').unchangedControl(
    JSON.parse(entry.text),fresh.get(entry.id),claim.path):{applicable:false};
   if(control.applicable){
    if(!control.matched)return unavailable('The form changed during this request. Its earlier fields are no longer verified as current. Your request and recorded work are saved.','CURRENT_FORM_CHANGED');
   }else if(missingCurrent||!equal(current,claim.value)){
    const moved=entry.name==='environment_browser'?require('./browser-text-verification').unchangedLine(
     JSON.parse(entry.text),fresh.get(entry.id),claim.path):{matched:false};
    if(!moved.matched||!equal(moved.value,claim.value))return unavailable('The business records changed during this request. The earlier figures are no longer verified as current. Your request and recorded work are saved.','CURRENT_RECORDS_CHANGED');
   }
  }
  verified.push({evidenceId:claim.evidenceId,path:claim.path,sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex')});
 }
 let navigation=null;
 if(report.outcome==='navigation'){
  const fail=()=>({verified:false,answer:'I found a possible destination, but could not verify a safe page to open in your browser.'});
  const n=report.navigation,entry=n&&find(n.evidenceId);
  if(!entry||entry.truncated||!entry.text||createHash('sha256').update(entry.text).digest('hex')!==entry.sha256)return fail();
  const observation=JSON.parse(entry.text);let path,label,observedDestination;
  if(entry.name==='environment_browser'){
   if(!['/url','/screen/url'].includes(n.path))return fail();
   const screen=n.path==='/screen/url'?observation.screen:observation;
   if(screen?.applicationPage!==true||screen.httpStatus!==200||typeof screen.url!=='string')return fail();
   let url;try{url=new URL(screen.url);}catch{return fail();}
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return fail();
   observedDestination=screen.url;path=url.pathname+url.search;label=screen.title;
  }else if(entry.name==='business_operations'){
   const match=/^\/outcomes\/(\d+)\/result\/navigation\/href$/.exec(n.path||'');
   const outcome=match&&observation.outcomes?.[Number(match[1])];
   if(!outcome||catalogue.get(outcome.capability)?.kind!=='navigation'||outcome.result?.status!=='ANSWERED')return fail();
   path=outcome.result.navigation?.href;label=outcome.result.navigation?.label;observedDestination=path;
  }else return fail();
  const href=require('./agent-navigation-path').localPath(path);
  if(!href)return fail();
  // Navigation is itself an evidence-backed result, independent of optional
  // factual claims in the prose. Revalidate its source even when claims=[];
  // an old destination or an unrelated claim cannot bypass current authority.
  if(!fresh.has(entry.id)){
   try{fresh.set(entry.id,await require('./agent-evidence-verification').current(database,ctx,goal,entry,{catalogue,...options}));}
   catch{return fail();}
  }
  let current=fresh.get(entry.id);
  for(const part of n.path.slice(1).split('/')){
   const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
   if(['__proto__','constructor','prototype'].includes(key)||current===null||typeof current!=='object'||!Object.hasOwn(current,key))return fail();
   current=current[key];
  }
  if(current!==observedDestination)return fail();
  navigation={href,label:String(label||'the requested page').replace(/\s+·\s+StockChief$/,'').slice(0,120),
   evidenceId:entry.id,evidenceHash:entry.sha256};
 }
 return {verified:true,answer:report.answer,receipt,claims:verified,verificationScope:'referenced_claims_and_canonical_effects',navigation,delivery:require('./agent-delivery').create(report)};
}
const instructions=`\nFor your final report return JSON with status "completed", outcome ("answer" or "navigation"), answer, and claims: [{evidenceId,path,value}].
The browser tool controls a private inspection browser, NOT the user's website. When the user asks to open a page, use outcome "navigation" and navigation: {evidenceId,path:"/url"} referencing an actual successful applicationPage observation (use /screen/url if wrapped). The host will deliver that page to the user's browser and verify its arrival without another model call. Do not claim it has already opened for the user. Do not return outcome "answer" to fulfill a navigation request. For questions or completed business changes that do not request moving the user's browser, use outcome "answer".
A governed navigation operation also supplies a safe destination: reference its actual /outcomes/N/result/navigation/href in navigation.path. When that authorized destination is already available, you do not need to visit it in the private browser merely to open it for the user. Unlisted pages remain discoverable through browser exploration.
Each factual claim must reference actual durable evidence by ID and a JSON Pointer to its exact recorded value.
Use the smallest recorded values that substantiate the answer. Do not copy unrelated rows or an entire observation into claims when individual fields or visible text blocks suffice. Preserve enough claims to support all reported facts; concise evidence never removes canonical outcome verification.
Current-state claims after execution require fresh observations. Mark a historical claim historical:true and describe its time/scope explicitly.
Use the complete evidence already in a tool response. Its _stockchiefEvidence reference supplies evidenceId and valuePointerPrefix; prepend that prefix to the JSON Pointer of the displayed value. Retrieve the journal only for missing, truncated, compacted or earlier evidence. Do not retrieve a value again just to report what the current response already shows. Include current-state verification after authorized changes.
Never claim every part of a request was completed merely because one receipt was verified.`;
module.exports={verify,instructions};
