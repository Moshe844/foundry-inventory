'use strict';
// Native constrained decoding, not a second reasoning controller. JSON values
// are serialized inside claims so arbitrary discovered records remain usable
// under a closed, provider-compatible report schema.
const string={type:'string'},nullableString={type:['string','null']};
function object(properties){return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};}
function array(items){return {type:'array',items};}
const schema=object({version:{type:'integer',enum:[1]},
 status:{type:'string',enum:['completed','needs_user','needs_reasoning','blocked']},
 outcome:{type:['string','null'],enum:['answer','navigation',null]},answer:nullableString,question:nullableString,
 missingInformation:array(string),tier:{type:['string','null'],enum:['standard','complex','exceptional',null]},reason:nullableString,
 claims:array(object({evidenceId:string,path:string,valueJson:string,historical:{type:'boolean'}})),
 navigation:{anyOf:[object({evidenceId:string,path:string}),{type:'null'}]},
 workProducts:array(object({title:string,content:string})),nextActions:array(object({label:string,instruction:string}))});
const instructions='\nUse the native final-output schema for every conversation handoff. For unused nullable fields return null; for unused arrays return []. Each claim.valueJson must be the JSON serialization of the exact recorded value, preserving its type. The host decodes this transport field and independently verifies it. historical is false for current facts. This format supplies no authority, and all original conversation and verification rules still apply.';
function decode(raw){
 let report;try{report=JSON.parse(raw);}catch{return raw;}
 if(!report||!Array.isArray(report.claims)||!report.claims.some(c=>Object.hasOwn(c,'valueJson')))return raw;
 const converted=Object.fromEntries(Object.entries(report).filter(([,value])=>value!==null));
 converted.claims=report.claims.map(claim=>{
  if(typeof claim.valueJson!=='string')throw Error('INVALID_NATIVE_CLAIM_ENCODING');
  let value;try{value=JSON.parse(claim.valueJson);}catch{throw Error('INVALID_NATIVE_CLAIM_ENCODING');}
  return {evidenceId:claim.evidenceId,path:claim.path,value,historical:claim.historical};
 });
 return JSON.stringify(converted);
}
module.exports={schema,instructions,decode};
