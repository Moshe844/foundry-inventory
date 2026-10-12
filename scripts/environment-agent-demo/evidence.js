'use strict';
const {createHash}=require('node:crypto');
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
// Remove duplicated transport bookkeeping only at known envelope boundaries.
// Arbitrary business-row fields, including notes, stay intact and untrusted.
function project(value){
 if(value?.image)return project(value.screen);
 if(Array.isArray(value?.outcomes))return {...value,outcomes:value.outcomes.map(o=>{
  const {intent,interactionId,...result}=o.result||{};return {...o,result};
 })};
 return value;
}
// Large evidence is paged as complete JSON values with JSON Pointer paths.
// Oversized individual strings are explicit text chunks, never broken JSON.
function units(value,path=''){
 if(bytes({path,value})<=4800)return [{path,value}];
 if(typeof value==='string'){
  const out=[];let start=0;while(start<value.length){let end=Math.min(start+1600,value.length);
   if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]))end--;
   out.push({path,text:value.slice(start,end),start,end,length:value.length});start=end;
  }return out;
 }
 const entries=Array.isArray(value)?value.map((v,i)=>[String(i),v]):Object.entries(value||{});
 return entries.flatMap(([key,child])=>units(child,`${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`));
}
function page(value,id,offset=0,at=null){
 const all=units(project(value)),records=[];
 if(!Number.isSafeInteger(offset)||offset<0||offset>all.length)throw new Error('INVALID_EVIDENCE_OFFSET');
 const result={evidenceId:id,observedAt:at,historical:true,untrusted:true,offset,offsetUnit:'record',records,
  totalRecords:all.length,nextOffset:null,truncated:false};
 for(let i=offset;i<all.length;i++){
  if(bytes({...result,records:[...records,all[i]]})>6100)break;records.push(all[i]);
 }
 result.nextOffset=offset+records.length<all.length?offset+records.length:null;
 result.truncated=result.nextOffset!==null;
 return result;
}
function semantic(name,result){
 const value=project(result?.screen||result);
 if(name==='environment_browser')return {url:value.url,title:value.title,httpStatus:value.httpStatus,text:value.text,
  controls:value.controls?.map(({ref,optionsNextRef,...rest})=>rest),error:result.error};
 if(name==='environment_evidence')return {records:value.records,text:value.text,offset:value.offset,
  nextOffset:value.nextOffset,sourceTruncated:value.sourceTruncated};
 return value;
}
// Compare observed business content, not clocks or presentation/query metadata.
// Row fields remain intact: their meaning is owned by the canonical reader.
function rowContent(value){return Array.isArray(value?.rows)?{rows:value.rows,hasMore:value.hasMore??null}:value;}
function remember(h,name,input,result,id){
 h.facts||={};h.progress||={seen:{},stagnant:0,repetitions:0};const at=new Date().toISOString();
 let steps=input.steps;try{steps||=JSON.parse(input.stepsJson);}catch{}
 const data=semantic(name,result),signature=hash({name,data});
 const p=h.progress;p.liveSources||={};
 // Track comparable live observations by scope, not by adjacent tool call.
 // New business facts advance an investigation even when the screen has not
 // changed. Contracts, notes and historical replays alone cannot reset it.
 const live=[];
 let newScreen=false;
 if(name==='environment_browser'){
  const key=hash({name,url:data.url||null});newScreen=!p.liveSources[key];live.push({key,data});
  if(result?.image?.base64)live.push({key:hash({name,url:data.url||null,modality:'image'}),
   data:createHash('sha256').update(Buffer.from(result.image.base64,'base64')).digest('hex')});
 }
 if(name==='environment_dataset')live.push({key:hash({name,input}),data:rowContent(data)});
 if(name==='business_operations')for(const [i,o] of (project(result).outcomes||[]).entries()){
  const original=result.outcomes[i]?.result;
  live.push({key:hash({name,capability:o.capability,query:steps?.[i]?.arguments||original?.intent?.search||null,
   timeframe:original?.intent?.timeframe||null}),data:rowContent(o.result)});
 }
 let changed=false,allSame=live.length>0;
 for(const entry of live){const next=hash(entry.data),prior=p.liveSources[entry.key];
  if(prior!==next)allSame=false;
  if(prior&&prior!==next)changed=true;
  p.liveSources[entry.key]=next;
 }
 // A return to a prior value after an observed change/error is a legitimate
 // fresh observation. Identical pages at alternating URLs remain repetitions.
 const repeated=live.length?allSame:!!p.seen[signature];
 p.knownFacts||={};let newFacts=false;
 const sources=name==='environment_dataset'?[{source:result.provenance?.dataset||result.config?.dataset||name,rows:result.rows}]:
  name==='business_operations'?(project(result).outcomes||[]).map(o=>({source:o.capability,rows:o.result?.rows})):[];
 for(const source of sources)for(const row of source.rows||[]){
  const key=hash({source:source.source,row});if(!p.knownFacts[key])newFacts=true;p.knownFacts[key]=true;
 }
 h.progress.seen[signature]=(h.progress.seen[signature]||0)+1;
 if(changed||newScreen||newFacts){p.stagnant=0;if(p.finalReason==='REPEATED_UNCHANGED_EVIDENCE')delete p.finalReason;}
 else if(name!=='environment_notebook'&&repeated)p.stagnant++;
 if(repeated)h.progress.repetitions++;
 h.progress.warning=repeated?'Unchanged evidence. Use the consolidated observations; select a different source only for a specific unresolved question.':null;
 if(h.progress.stagnant>=4)h.progress.finalReason='REPEATED_UNCHANGED_EVIDENCE';
 h.progress.last={name,evidenceId:id,signature,repeated,changed,newScreen,newFacts};
 if(name==='business_operations')for(const [index,o] of (project(result).outcomes||[]).entries()){
  const r=o.result;if(!Array.isArray(r?.rows))continue;
  const original=result.outcomes.find(v=>v.capability===o.capability)?.result;
  const scope={capability:o.capability,query:steps?.[index]?.arguments||original?.intent?.search||null,
   timeframe:original?.intent?.timeframe||null};
  const key=hash(scope);delete h.facts[key];h.facts[key]={source:o.capability,evidenceId:id,observedAt:at,data:r};
 }
 else if(name==='environment_dataset'){
  const key=hash({name,input});delete h.facts[key];h.facts[key]={source:name,evidenceId:id,observedAt:at,data:project(result)};
 }
 else if(name==='environment_browser')h.screen={evidenceId:id,observedAt:at,data};
}
function consolidated(h,limit=5000){
 const facts=[];for(const fact of require('./observations').ordered(Object.values(h.facts||{})).reverse()){
  const packed=bytes(fact)<=3500?fact:{...fact,data:page(fact.data,fact.evidenceId,0,fact.observedAt),partial:true};
  if(bytes([...facts,packed])<=limit)facts.push(packed);
  else {const pointer={source:fact.source,evidenceId:fact.evidenceId,observedAt:fact.observedAt,partial:true,
   notice:'Full observation is in the evidence journal; no conclusion from omitted fields is implied.'};
   if(bytes([...facts,pointer])<=limit)facts.push(pointer);}
 }
 return facts;
}
function report(h){
 const facts=consolidated(h,12000);if(!facts.length)return null;
 return ['The investigation ended before a complete answer could be verified.',
  'Recorded observations below are historical evidence, not new authority. They may need a fresh check; unquoted completion is not implied.',
  ...facts.map(f=>`${f.source} [${f.evidenceId}, observed ${f.observedAt}]: ${f.data?JSON.stringify(f.data):f.notice}`),
  'Unresolved: full coverage of the original request has not been established.'].join('\n');
}
module.exports={project,page,semantic,remember,consolidated,report,hash,bytes};
