'use strict';
// Native constrained decoding, not a second reasoning controller. Group only
// repeated source metadata; every original path and exact value is preserved
// and decoded into the unchanged independently verified conversation contract.
const string={type:'string'},nullableString={type:['string','null']};
const evidenceId={type:'string',description:'Exact _stockchiefEvidence.evidenceId returned with the recorded observation.'};
const pointer={type:'string',description:'JSON Pointer to the recorded value within that observation. This is a field location, never an application route or the value itself.'};
function object(properties){return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};}
function array(items){return {type:'array',items};}
const legacySchema=object({version:{type:'integer',enum:[2]},
 status:{type:'string',enum:['completed','needs_user','needs_reasoning','blocked','refused'],description:'Use completed only for an evidence-backed business answer or verified navigation. Use refused when declining a request on authority, privacy or safety grounds; this ends the request without offering a retry. Use blocked for recoverable unavailable access, service problems or unsupported capabilities. Use needs_user only for a genuinely required user choice.'},
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
 navigation:{anyOf:[object({evidenceId,path:{type:'string',description:'JSON Pointer to the observed destination: /url or /screen/url for a browser observation; the recorded navigation/href field for a governed result, or /collections/KEY/href for host-recorded owning-list navigation evidence. Never an application route.'}}),{type:'null'}]},
 workProducts:{...array(object({title:string,content:{type:'string',description:'Full customer-visible artifact content in Markdown, including all requested rows or draft text. This is a saved conversation artifact, not a canonical business record or evidence of execution.'}})),description:'Optional complete artifacts delivered alongside the completed answer. If empty, all requested usable result content must be in answer. Evidence claims are not artifacts.'},nextActions:array(object({label:string,instruction:string}))});
const schema={...legacySchema,properties:{...legacySchema.properties,version:{type:'integer',enum:[3]},
 workProducts:{...array({anyOf:[object({title:string,content:string}),object({title:string,sourceTable:object({sourceRef:{type:'string',description:'Copy an issued tb1 reference from _stockchiefSources.tables. The host renders exact recorded cells and re-verifies their complete source.'},columns:array(string),rows:{anyOf:[array({type:'integer'}),{type:'null'}],description:'null for every returned source row; otherwise unique original zero-based source-row indices, optionally reordered. This selects records, never supplies values.'}})})]}),description:'Use sourceTable for an existing canonical record table instead of recopying its cells or generating a claim per cell. Choose a supplied table reference and exact column keys. The host materializes and verifies the complete table before delivery. Markdown content remains available for prose and small custom artifacts.'},
 claims:{...array(object({sourceRef:{type:'string',description:'Copy the exact fv1 field reference from the original fact’s value-reference map, named by _stockchiefSources.valueField. Do not reconstruct a path, array index or observation ID.'},historical:{type:'boolean'},
  value:{type:['string','number','boolean','null'],description:'Copy the exact primitive field value. Containers carry presentation metadata; cite their individual factual fields instead.'}})),description:'Hidden factual assertions. Each reference binds the ORIGINAL observation AND exact primitive field. Retain the exact asserted value. No path or observation ID is generated for a factual claim.'}}};
const instructions='\nUse native final-output schema version 3 for every new conversation handoff. For unused nullable fields return null; for unused arrays return []. A completed answer requires genuine durable evidence claims; refusals use refused with the useful explanation, without invented evidence or unnecessary tools. For each factual claim, copy sourceRef from the exact field in the value-reference map named by _stockchiefSources.valueField and copy its asserted primitive value. Browser textBlocks keys starting fv1: are already complete field references: copy that key and its exact displayed text. Return {sourceRef,historical,value}; NEVER generate a field path, observation ID, relative path or array index for a new factual claim. Object-level sr1 references and evidenceId/path encodings are legacy history only; if earlier evidence lacks field references, retrieve that durable observation with environment_evidence. Do not repeat inspection just to obtain references. Copy primitive factual fields directly. Do not assert whole arrays, objects or presentation metadata; cite the relevant individual factual fields instead. Historical container reports remain readable but are never generated for new answers. These assertions are hidden verification data, not the customer answer or artifact. Include the requested usable content in answer/workProducts. Historical is false for current facts. The host resolves each reference to its original observation and field, then retains exact asserted-value, source-integrity, authority and current-business verification. References grant no business authority. Navigation remains a separate navigation object whose path locates its observed destination. Existing path-based instructions apply to legacy reports and navigation, not new factual claims.';
function decode(raw){
 let report;try{report=JSON.parse(raw);}catch{return raw;}
 if(report?.version===3){
  // Historical v3 reports can contain JSON containers. Keep decoding those
  // exact assertions; the new-generation schema above permits leaves only.
  if(!Array.isArray(report.claims)||report.claims.length>50)throw Error('INVALID_NATIVE_CLAIM_ENCODING');
  const converted=Object.fromEntries(Object.entries(report).filter(([,value])=>value!==null));converted.version=1;
  converted.claims=report.claims.map(claim=>{
   if(!claim||typeof claim.sourceRef!=='string'||typeof claim.historical!=='boolean'||!Object.hasOwn(claim,'value')||Object.keys(claim).some(k=>!['sourceRef','historical','value'].includes(k)))throw Error('INVALID_NATIVE_CLAIM_ENCODING');
   let value=claim.value;
   if(value!==null&&typeof value==='object'){
    if(Array.isArray(value)||Object.keys(value).length!==1||typeof value.json!=='string')throw Error('INVALID_NATIVE_CLAIM_ENCODING');
    try{value=JSON.parse(value.json);}catch{throw Error('INVALID_NATIVE_CLAIM_ENCODING');}
    if(value===null||typeof value!=='object')throw Error('INVALID_NATIVE_CLAIM_ENCODING');
   }else if(!['string','number','boolean'].includes(typeof value)&&value!==null)throw Error('INVALID_NATIVE_CLAIM_ENCODING');
   return {sourceRef:claim.sourceRef,value,historical:claim.historical};
  });return JSON.stringify(converted);
 }
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
const tableInstructions='\nCanonical tabular observations may offer _stockchiefSources.tables. For a requested table, prefer a workProduct {title,sourceTable:{sourceRef,columns,rows}} using that issued tb1 reference and supplied column keys. rows:null includes all returned source rows; otherwise choose unique original source-row indices programmatically before filtering or sorting. This is a presentation selection, not a new query or permission. The host copies exact recorded cells, checks the complete current source and reviews the fully rendered table against the original goal. Do not recopy those cells into answer, Markdown content or individual claims. Keep answer a brief summary and retain explicit primitive claims for additional prose or calculations. This contract cannot join sources, calculate new cells, fill missing fields, establish complete source coverage from a partial page, execute business work or replace approvals. Use current canonical tools for missing evidence. Each workProduct remains bounded by the existing artifact size; use an observed authenticated report link for a result too large to deliver. The 50 model-authored-claim, model-output, tool, turn and spending limits remain unchanged.';
const computedInstructions='\nAn exact field reference asserts its recorded value, not arithmetic performed on that value. For counts, filtered totals and other derived figures, prefer the existing canonical dataset aggregation with the required filters and currency scope; cite the returned aggregate. If you calculate from complete records, cite the actual input values and coverage without substituting the calculated answer for a referenced input. Page extent and group counts only describe the population explicitly recorded in that query. This applies to every dataset and domain; it grants no authority or verification exemption.';
module.exports={schema,legacySchema,instructions:instructions+tableInstructions+computedInstructions,decode};
