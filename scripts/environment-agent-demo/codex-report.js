'use strict';
// Native constrained decoding, not a second reasoning controller. JSON values
// are serialized inside claims so arbitrary discovered records remain usable
// under a closed, provider-compatible report schema.
const string={type:'string'},nullableString={type:['string','null']};
const evidenceId={type:'string',description:'Exact _stockchiefEvidence.evidenceId returned with the recorded observation.'};
const pointer={type:'string',description:'JSON Pointer to the recorded value within that observation. This is a field location, never an application route or the value itself.'};
function object(properties){return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};}
function array(items){return {type:'array',items};}
const schema=object({version:{type:'integer',enum:[1]},
 status:{type:'string',enum:['completed','needs_user','needs_reasoning','blocked']},
 outcome:{type:['string','null'],enum:['answer','navigation',null]},answer:nullableString,question:nullableString,
 missingInformation:array(string),tier:{type:['string','null'],enum:['standard','complex','exceptional',null]},reason:nullableString,
 claims:array(object({evidenceId,path:pointer,
  value:{type:['string','number','boolean','null'],description:'For a recorded primitive, copy its exact value and type here, with valueJson null. For an array or object, use value null and valueJson.'},
  valueJson:{type:['string','null'],description:'Null for primitive claims. Only for an array/object claim, its exact JSON serialization; value must then be null.'},historical:{type:'boolean'}})),
 navigation:{anyOf:[object({evidenceId,path:{type:'string',description:'JSON Pointer to the observed destination: /url or /screen/url for a browser observation; the recorded navigation/href field for a governed result. Never an application route.'}}),{type:'null'}]},
 workProducts:array(object({title:string,content:string})),nextActions:array(object({label:string,instruction:string}))});
const instructions='\nUse the native final-output schema for every conversation handoff. For unused nullable fields return null; for unused arrays return []. Copy primitive evidence directly into claim.value with valueJson null. For an array or object, use value null and its exact JSON serialization in valueJson. The host independently verifies the decoded value. historical is false for current facts. navigation.path is a JSON Pointer to the observation URL field, never an application route. This format supplies no authority, and all original conversation and verification rules still apply.';
function decode(raw){
 let report;try{report=JSON.parse(raw);}catch{return raw;}
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
module.exports={schema,instructions,decode};
