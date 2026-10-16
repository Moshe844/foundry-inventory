'use strict';
// Native constrained decoding, not a second reasoning controller. Group only
// repeated source metadata; every original path and exact value is preserved
// and decoded into the unchanged independently verified conversation contract.
const string={type:'string'},nullableString={type:['string','null']};
const evidenceId={type:'string',description:'Exact _stockchiefEvidence.evidenceId returned with the recorded observation.'};
const pointer={type:'string',description:'JSON Pointer to the recorded value within that observation. This is a field location, never an application route or the value itself.'};
function object(properties){return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};}
function array(items){return {type:'array',items};}
const schema=object({version:{type:'integer',enum:[2]},
 status:{type:'string',enum:['completed','needs_user','needs_reasoning','blocked'],description:'Use completed only for an evidence-backed business answer or verified navigation. A refusal or unsupported request uses blocked, including when the user explicitly asks you to refuse. Use needs_user only for a genuinely required user choice.'},
 outcome:{type:['string','null'],enum:['answer','navigation',null]},
 answer:{...nullableString,description:'For completed results, the actual customer-visible Markdown answer. Include the requested facts, rows, calculations or explanation here, or put the full requested artifact in workProducts and summarize it here. Claims are hidden verification data and never display a result for you. Do not announce content that is absent from both answer and workProducts.'},
 question:{...nullableString,description:'For needs_user, the customer-visible question about genuinely missing information or a real choice. A search filter you inferred is a hypothesis, not a user constraint. Reconsider unsuccessful inferred filters within authorized scope before asking; retain explicit constraints and clarify genuine ambiguity.'},
 missingInformation:array(string),tier:{type:['string','null'],enum:['standard','complex','exceptional',null]},reason:nullableString,
 claims:{...array({anyOf:[
  object({sourceRef:{type:'string',description:'Copy the host-generated source reference from the exact record or contract object. Do not reconstruct an observation ID or array position.'},historical:{type:'boolean'},values:array(object({path:{...pointer,description:'JSON Pointer relative to the object carrying sourceRef, for example /description or /quantity. Copy the actual field key; never prepend its former array position.'},
   value:{anyOf:[{type:['string','number','boolean','null']},object({json:{type:'string',description:'Exact JSON serialization of an asserted array or object. Primitives are copied directly.'}})]}}))}),
  object({evidenceId,historical:{type:'boolean'},values:array(object({path:pointer,
   value:{anyOf:[{type:['string','number','boolean','null']},object({json:{type:'string',description:'Only for an array or object: its exact JSON serialization. Primitives are copied directly, without this wrapper.'}})]}}))})
 ]}),description:'Hidden supporting evidence for host verification. Prefer sourceRef from the actual object with relative paths and exact asserted values. Legacy evidenceId/absolute-path claims remain readable. Claims are never the customer-visible answer or artifact.'},
 navigation:{anyOf:[object({evidenceId,path:{type:'string',description:'JSON Pointer to the observed destination: /url or /screen/url for a browser observation; the recorded navigation/href field for a governed result. Never an application route.'}}),{type:'null'}]},
 workProducts:{...array(object({title:string,content:{type:'string',description:'Full customer-visible artifact content in Markdown, including all requested rows or draft text. This is a saved conversation artifact, not a canonical business record or evidence of execution.'}})),description:'Optional complete artifacts delivered alongside the completed answer. If empty, all requested usable result content must be in answer. Evidence claims are not artifacts.'},nextActions:array(object({label:string,instruction:string}))});
const instructions='\nUse the native final-output schema version 2 for every conversation handoff. For unused nullable fields return null; for unused arrays return []. A completed answer requires at least one genuine durable evidence claim; do not emit a claimless completed answer. For a refusal, unavailable access or unsupported request, return status blocked with the useful explanation in answer, even when refusing satisfies what the user asked. Such an explanation needs no claims or unnecessary tool calls. Never invent evidence merely to finish. Group claims sharing the same evidenceId and historical flag into one claims entry, with a values array containing every original path and its exact value. Copy primitive values directly. Only for an array or object use value:{json:its exact JSON serialization}. This is lossless transport compression: do not remove supporting claims, omit facts or substitute a whole-page citation merely to shorten output. The host expands every entry and independently verifies every value with the unchanged evidence verifier. historical is false for current facts. navigation.path is a JSON Pointer to the observation URL field, never an application route. This format supplies no authority, and all original conversation and verification rules still apply.';
function decode(raw){
 let report;try{report=JSON.parse(raw);}catch{return raw;}
 if(report?.version===2){
  if(!Array.isArray(report.claims)||report.claims.length>50)throw Error('INVALID_NATIVE_CLAIM_ENCODING');
  const converted=Object.fromEntries(Object.entries(report).filter(([,value])=>value!==null));
  converted.version=1;converted.claims=[];
  for(const group of report.claims){
   if(!group||typeof group.historical!=='boolean'||!Array.isArray(group.values)||
    (typeof group.sourceRef==='string')===(typeof group.evidenceId==='string'))throw Error('INVALID_NATIVE_CLAIM_ENCODING');
   for(const entry of group.values){
    if(!entry||typeof entry.path!=='string'||!Object.hasOwn(entry,'value'))throw Error('INVALID_NATIVE_CLAIM_ENCODING');
    let value=entry.value;
    if(value!==null&&typeof value==='object'){
     if(Array.isArray(value)||Object.keys(value).length!==1||typeof value.json!=='string')throw Error('INVALID_NATIVE_CLAIM_ENCODING');
     try{value=JSON.parse(value.json);}catch{throw Error('INVALID_NATIVE_CLAIM_ENCODING');}
     if(value===null||typeof value!=='object')throw Error('INVALID_NATIVE_CLAIM_ENCODING');
    }else if(!['string','number','boolean'].includes(typeof value)&&value!==null)throw Error('INVALID_NATIVE_CLAIM_ENCODING');
    converted.claims.push({...(typeof group.sourceRef==='string'?{sourceRef:group.sourceRef}:{evidenceId:group.evidenceId}),path:entry.path,value,historical:group.historical});
    if(converted.claims.length>50)throw Error('INVALID_NATIVE_CLAIM_ENCODING');
   }
  }
  return JSON.stringify(converted);
 }
 if(!report||!Array.isArray(report.claims)||!report.claims.some(c=>Object.hasOwn(c,'valueJson')))return raw;
 const converted=Object.fromEntries(Object.entries(report).filter(([,value])=>value!==null));
 converted.claims=report.claims.map(claim=>{
  let value;
  if(claim.valueJson===null){value=claim.value;if(!['string','number','boolean'].includes(typeof value)&&value!==null)throw Error('INVALID_NATIVE_CLAIM_ENCODING');}
  else{
   if(typeof claim.valueJson!=='string'||claim.value!==undefined&&claim.value!==null)throw Error('INVALID_NATIVE_CLAIM_ENCODING');
   try{value=JSON.parse(claim.valueJson);}catch{throw Error('INVALID_NATIVE_CLAIM_ENCODING');}
  }
  return {evidenceId:claim.evidenceId,path:claim.path,value,historical:claim.historical};
 });
 return JSON.stringify(converted);
}
const sourceInstructions='\nPrefer host-owned source references when the observation supplies _stockchiefSources.field. Each original record or contract object carries that named source-reference field. Preserve it with the object when filtering, sorting or storing notes. Group its claims by sourceRef with paths relative to that object and exact asserted values. Do not join a different observation ID to that object, calculate its prior array index, or put source-reference metadata into the customer answer. The host resolves each reference to the original observation and object before unchanged integrity, value, authority and current-record verification. Legacy evidenceId/absolute-path claims are supported for earlier observations without source references. A reference supplies no business authority and never substitutes for a factual asserted value.';
module.exports={schema,instructions:instructions+sourceInstructions,decode};
