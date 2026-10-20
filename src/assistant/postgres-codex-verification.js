'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
 const unavailable=(answer,code,detail={})=>({verified:false,answer,report:{version:1,status:'blocked',answer},verificationFailure:code,verificationDetail:detail});
// Models identify claims; the host checks their values against durable evidence
// and canonical PostgreSQL effects. A model's success flag alone is insufficient.
async function verify(database,ctx,goal,raw,catalogue,options={}){
 const conversation=require('./agent-conversation');let report=conversation.parse(raw);
 if(!report)return {verified:false,answer:conversation.FAILED};
 if(report.status==='needs_user')return {verified:false,answer:report.question,report};
 if(['blocked','refused'].includes(report.status))return {verified:false,answer:conversation.publicText(report.answer),report};
 if(conversation.publicText(report.answer,'')!==report.answer)return {verified:false,answer:conversation.FAILED};
 if(report.status==='completed'&&goal.checkpoint.clientIntegration===1&&!['answer','navigation'].includes(report.outcome))
  return {verified:false,answer:'I could not verify delivery of the requested result. A page inspected by the agent is not proof that it opened in your browser.'};
 let tables;try{tables=require('../../scripts/environment-agent-demo/source-tables').materialize(goal,report);report=tables.report;}
 catch(error){return unavailable('I could not verify the requested table. Your goal and collected evidence are saved.',error.message);}
 if(report.status!=='completed'||typeof report.answer!=='string'||!Array.isArray(report.claims)||
  (!report.claims.length&&!tables.claims.length&&report.outcome!=='navigation')||report.claims.length>50)
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
 const verified=[],fresh=new Map(),sourceCache=new Map(),sourceMetadataCache=new Map();
 async function currentEvidence(entry,path){
  const match=entry.name==='business_operations'&&/^\/outcomes\/(0|[1-9]\d*)(?:\/|$)/.exec(path);
  const outcomeIndex=match?Number(match[1]):null,key=JSON.stringify([entry.id,outcomeIndex]);
  if(!fresh.has(key))fresh.set(key,await require('./agent-evidence-verification').current(database,ctx,goal,entry,{catalogue,...options,outcomeIndex}));
  return fresh.get(key);
 }
 for(const [claimIndex,inputClaim] of [...report.claims,...tables.claims].entries()){
  let claim=inputClaim;
  if(Object.hasOwn(claim,'sourceRef'))try{claim=require('../../scripts/environment-agent-demo/source-references').resolve(entries,claim,sourceCache);}
  catch(error){return unavailable('I could not verify the supporting evidence for this answer. Your request and collected information are saved.',error.message,
   {claimIndex,...(/^(?:sr1:[A-Za-z0-9_-]{24}|fv1:[A-Za-z0-9_-]{16})$/.test(inputClaim.sourceRef)?{sourceRef:inputClaim.sourceRef}:{})});}
  if(typeof claim.evidenceId!=='string'||typeof claim.path!=='string'||!claim.path.startsWith('/')||claim.path.length>400)return {verified:false,answer:report.answer};
  const entry=find(claim.evidenceId);if(!entry)return {verified:false,answer:report.answer};
  if(entry.truncated||entry.text&&createHash('sha256').update(entry.text).digest('hex')!==entry.sha256)return {verified:false,answer:report.answer};
  // Observation age is not a substitute for checking current truth. A later
  // operation may change another record entirely (for example, sending an
  // email after reading an already-paid order). Every nonhistorical claim is
  // re-read below under CURRENT authority and compared exactly. Rejecting an
  // earlier observation before that check discards valid durable knowledge
  // and forces unnecessary model/tool turns without improving verification.
  const original=entry.text?JSON.parse(entry.text):entry.value??entry.output??entry.result??entry;
  if(entry.name==='authorized_navigation')return unavailable('Navigation metadata cannot substantiate business facts.','TRANSPORT_METADATA_NOT_EVIDENCE');
  if(require('../../scripts/environment-agent-demo/source-references').metadataClaim(entry,claim.path,sourceMetadataCache))
   return unavailable('The answer needs supporting business facts, not internal source references.','TRANSPORT_METADATA_NOT_EVIDENCE');
  if(entry.name==='environment_browser'&&/^\/(?:screen\/)?viewState(?:\/|$)/.test(claim.path))
   return unavailable('The answer needs observed application facts, not internal presentation metadata.','TRANSPORT_METADATA_NOT_EVIDENCE');
  if(['business_operations','environment_dataset'].includes(entry.name)&&require('../../scripts/environment-agent-demo/record-presentation').metadataClaim(original,claim.path))
   return unavailable('The answer needs supporting business facts, not internal record coordinates.','TRANSPORT_METADATA_NOT_EVIDENCE');
  if(entry.name==='canonical_execution_state'&&/^\/operations\/\d+\/result(?:\/|$)/.test(claim.path)&&claim.historical!==true)
   return unavailable('A recorded execution result proves what happened then. Current-state claims still need a fresh business record.','EXECUTION_RESULT_REQUIRES_HISTORICAL_SCOPE');
  const presentation=require('../../scripts/environment-agent-demo/evidence-presentation');
  let selected=presentation.locate(original,claim.path),toolView=false,legacyBrowserWindows=false;
  if(!selected.found||!equal(selected.value,claim.value)){
   // The same lossless codec that delivered this observation is the only
   // alternative representation accepted. No arbitrary projection/subset.
   selected=presentation.locate(presentation.project(entry.name,original),claim.path);
   // Saved native reports may contain the prior lossless control encoding.
   // Accept that exact original representation, never a guessed subset. The
   // metadata gate above still rejects individual inspector-window claims,
   // and every actual DOM fact is freshly verified below in all encodings.
   if((!selected.found||!equal(selected.value,claim.value))&&entry.name==='environment_browser'){
    selected=presentation.locate(presentation.project(entry.name,original,{legacyBrowserWindows:true}),claim.path);
    legacyBrowserWindows=true;
   }
   if(!selected.found||!equal(selected.value,claim.value))return unavailable(
    'I could not verify the supporting evidence for this answer. Your request and collected information are saved.',
    selected.found?'EVIDENCE_VALUE_MISMATCH':'EVIDENCE_POINTER_NOT_FOUND',{claimIndex,evidenceId:claim.evidenceId,path:claim.path});
   toolView=true;
  }
  const value=selected.value;
  if(claim.historical!==true){
   let currentObservation;
   try{currentObservation=await currentEvidence(entry,claim.path);}
   catch(error){return unavailable('I could not confirm that the collected information still matches the current records. Your request and recorded work are saved.',error.message,
    {claimIndex,evidenceId:entry.id,path:claim.path,...error.verificationDetail});}
   const currentClaim=presentation.locate(toolView?presentation.project(entry.name,currentObservation,{legacyBrowserWindows}):currentObservation,claim.path);
   const current=currentClaim.value,missingCurrent=!currentClaim.found;
   // Only host-materialized table claims may select a column projection.
   // The model's ordinary claim schema cannot supply this private scope.
   const table=claimIndex>=report.claims.length&&Array.isArray(inputClaim.tableColumns)
    ?require('./business-row-verification').unchangedTable(value,current,inputClaim.tableColumns):{applicable:false};
   const record=entry.name==='business_operations'?require('./business-row-verification').unchangedRow(original,currentObservation,claim.path):{applicable:false};
   // Controls, like text offsets and loopback ports, have observation-local
   // identity. Verify their complete semantic facts before trusting an array
   // position, even when an unrelated field happens to contain the same value.
   const control=entry.name==='environment_browser'?require('./browser-control-verification').unchangedControl(
    JSON.parse(entry.text),currentObservation,claim.path):{applicable:false};
   if(table.applicable){
    if(!table.matched)return unavailable('The displayed business records changed during this request. Your request and collected information are saved.','CURRENT_RECORDS_CHANGED',{evidenceId:claim.evidenceId,path:claim.path});
   }else if(record.applicable){
    if(!record.matched||!equal(record.value,claim.value))return unavailable('The business record changed during this request. Its earlier value is no longer verified as current. Your request and recorded work are saved.','CURRENT_RECORDS_CHANGED',{evidenceId:claim.evidenceId,path:claim.path});
   }else if(control.applicable){
    if(!control.matched)return unavailable('The form changed during this request. Its earlier fields are no longer verified as current. Your request and recorded work are saved.','CURRENT_FORM_CHANGED',{evidenceId:claim.evidenceId,path:claim.path});
   }else if(missingCurrent||!equal(current,claim.value)){
    const moved=entry.name==='environment_browser'?require('./browser-text-verification').unchangedLine(
     JSON.parse(entry.text),currentObservation,claim.path):{matched:false};
    if(!moved.matched||!equal(moved.value,claim.value))return unavailable('The business records changed during this request. The earlier figures are no longer verified as current. Your request and recorded work are saved.','CURRENT_RECORDS_CHANGED',{evidenceId:claim.evidenceId,path:claim.path});
   }
  }
  verified.push({evidenceId:claim.evidenceId,path:claim.path,sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'),
   ...(claimIndex>=report.claims.length&&Array.isArray(inputClaim.tableColumns)?{columns:inputClaim.tableColumns}:{} )});
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
  }else if(entry.name==='authorized_navigation'){
   const match=/^\/collections\/([A-Za-z0-9_.-]{1,120})\/href$/.exec(n.path||''),
    collection=match&&Object.hasOwn(observation.collections||{},match[1])&&observation.collections[match[1]];
   if(!collection)return fail();path=collection.href;label=collection.label;observedDestination=path;
  }else return fail();
  const href=require('./agent-navigation-path').localPath(path);
  if(!href)return fail();
  // Navigation is itself an evidence-backed result, independent of optional
  // factual claims in the prose. Revalidate its source even when claims=[];
  // an old destination or an unrelated claim cannot bypass current authority.
  let current;try{current=await currentEvidence(entry,n.path);}catch{return fail();}
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
const instructions=`\nFor a completed result, use the native final-output schema with outcome "answer" or "navigation", the usable answer, and its supporting claims. The host alone verifies completion.
The browser tool controls a private inspection browser, NOT the user's website. When the user asks to open a page, use outcome "navigation" and navigation: {evidenceId,path:"/url"} referencing an actual successful applicationPage observation (use /screen/url if wrapped). The host will deliver that page to the user's browser and verify its arrival without another model call. Do not claim it has already opened for the user. Do not return outcome "answer" to fulfill a navigation request. For questions or completed business changes that do not request moving the user's browser, use outcome "answer".
Host-recorded owning-list navigation evidence supplies an exact evidenceId and /collections/KEY/href pointer for a recordCollections entry. You may report that destination directly without an extra browser/tool/model round; the host freshly rechecks its authority and destination and verifies the actual user-browser arrival. This metadata cannot substantiate business facts or business execution. Individual records and unlisted destinations still require discovered current evidence.
A governed navigation operation also supplies a safe destination: reference its actual /outcomes/N/result/navigation/href in navigation.path. When that authorized destination is already available, you do not need to visit it in the private browser merely to open it for the user. Unlisted pages remain discoverable through browser exploration.
For new factual claims use schema v3: {sourceRef,historical,value}, copying the issued fv1 field reference and its exact primitive value from the original observation. Legacy evidence-ID/JSON-Pointer reports remain readable but must not be generated for new factual claims.
Use the smallest recorded values that substantiate the answer. Do not copy unrelated rows or an entire observation into claims when individual fields or visible text blocks suffice. Preserve enough claims to support all reported facts; concise evidence never removes canonical outcome verification.
Current-state claims after execution require fresh observations. Mark a historical claim historical:true and describe its time/scope explicitly.
Evaluation, synchronization and monitoring timestamps are point-in-time receipts: a background check may legitimately advance them while you answer. Cite the recorded timestamp with historical:true and say when it was observed; keep claims about the current business condition nonhistorical so changes to stock, warning status, amounts or authority are still freshly checked. Do not claim a previously observed timestamp is the latest at delivery time.
Canonical execution receipts prove committed effects at their recorded time. Their result fields may describe an intermediate state that later approved work changed. Claims under canonical_execution_state /operations/N/result must use historical:true; use fresh business records for the final current state. Never treat an earlier confirmed or draft status as a failure merely because the same order has since been fulfilled.
Use the complete evidence already in a tool response. The _stockchiefSources.valueField map supplies exact primitive field references; preserve each original reference when selecting or reordering records. _stockchiefEvidence identifies durable observations for retrieval and the separate navigation handoff. Retrieve the journal only for missing, truncated, compacted or earlier evidence. Do not retrieve a value again just to report what the current response already shows. Include current-state verification after authorized changes.
Never claim every part of a request was completed merely because one receipt was verified.`;
function needsBrowser(goal,raw){
 const report=require('./agent-conversation').parse(raw);if(report?.status!=='completed')return false;
 try{const scope=require('./native-answer-review').checked(goal,raw);
  if(scope.required&&scope.verified===false&&scope.code==='ANSWER_SCOPE_UNVERIFIED')return false;
 }catch{/* The deterministic verifier owns malformed-reference rejection. */}
 const entries=Object.values(goal.checkpoint.harness?.evidence||{}),byId=new Map(entries.map(e=>[e.id,e]));
 if(report.outcome==='navigation'&&byId.get(report.navigation?.evidenceId)?.name==='environment_browser')return true;
 try{
  const tables=require('../../scripts/environment-agent-demo/source-tables').materialize(goal,report),cache=new Map();
  return [...report.claims,...tables.claims].some(claim=>{
   const resolved=Object.hasOwn(claim,'sourceRef')?require('../../scripts/environment-agent-demo/source-references').resolve(entries,claim,cache):claim;
   return byId.get(resolved.evidenceId)?.name==='environment_browser';
  });
 }catch{return false;} // The normal verifier retains its exact rejection.
}
async function verifyFinal(database,ctx,goal,raw,catalogue,options={}){
 let scope;
 // A settled, input-bound negative review already rejects this conclusion.
 // Reopening all referenced screens cannot make that rejected answer complete.
 // Positive, absent, invalid or mismatched reviews still take the full fresh
 // verifier below. In particular, malformed references retain its typed error
 // and existing bounded correction path. No receipt or completion is invented.
 try{
  scope=require('./native-answer-review').checked(goal,raw);
  if(scope.required===true&&scope.verified===false&&scope.code==='ANSWER_SCOPE_UNVERIFIED')return unavailable(
   'I could not verify that these findings answer the complete request. Your goal and collected evidence are saved.',scope.code,{reason:scope.reason});
 }catch{/* Preserve normal evidence/reference validation and its error. */}
 const result=await verify(database,ctx,goal,raw,catalogue,options);
 if(!result.verified)return result;
 // The goal and raw report are this call's immutable inputs. Reuse only this
 // input-bound review decision; the factual verifier above still re-read all
 // required CURRENT evidence and canonical outcomes independently.
 scope??=require('./native-answer-review').checked(goal,raw);
 if(scope.required&&!scope.verified)return {...unavailable('I could not verify that these findings answer the complete request. Your goal and collected evidence are saved.',scope.code,{reason:scope.reason}),receipt:result.receipt};
 return {...result,answerScopeReview:scope.required?'governed_semantic_review':'canonical_or_navigation_lifecycle'};
}
module.exports={verify,verifyFinal,instructions,needsBrowser};
