'use strict';
// Transport adaptation only. Canonical validation, resolution and execution
// remain responsible for business meaning and authority.
const {FIELDS}=require('../../src/assistant/postgres-capability-registry');
function invalid(message){throw Object.assign(new Error(message),{code:'TOOL_CONTRACT_INVALID',effectMayHaveOccurred:false});}
function operationSteps(steps,catalogue){
 if(!Array.isArray(steps)||!steps.length||steps.length>8)invalid('Provide one to eight operations.');
 return steps.map((step,index)=>{
  const contract=catalogue.get(step?.capability);
  if(!contract)invalid(`Step ${index}: discover an authorized registered capability before calling it.`);
  if(!Array.isArray(step.arguments)||!Array.isArray(step.dependsOn))invalid(`Step ${index}: arguments and dependsOn must be arrays.`);
  const seen=new Set();
  const args=step.arguments.map(entry=>{
   const field=entry?.name,type=FIELDS[field]?.type;
   if(!contract.fields.includes(field)||seen.has(field))invalid(`Step ${index}: invalid or duplicate field ${field}. Allowed fields: ${contract.fields.join(', ')}.`);
   seen.add(field);let value=entry.value;
   if(typeof value==='number'&&['number','integer'].includes(type)){
    if(!Number.isFinite(value)||type==='integer'&&!Number.isSafeInteger(value))invalid(`${field} requires a finite ${type}.`);
    value=String(value);
   }
   if(typeof value!=='string'||value.length>2000)invalid(`${field} requires ${type==='string'?'a string':`a ${type} or its string representation`}, at most 2000 characters. Objects, null and booleans are not accepted.`);
   if(['number','integer'].includes(type)&&value.trim()&&(!Number.isFinite(Number(value))||type==='integer'&&!Number.isSafeInteger(Number(value))))invalid(`${field} requires a finite ${type}.`);
   return {name:field,value:value.trim()};
  });
  if(step.dependsOn.some(n=>!Number.isInteger(n)||n<0||n>=index))invalid(`Step ${index}: dependencies must refer to earlier steps.`);
  return {...step,arguments:args};
 });
}
function datasetSpec(spec,actor){
 const reports=require('../../src/reports/postgres-service');
 const contract=reports.queryContract(spec?.dataset,actor);
 if(!contract)invalid('Discover an authorized dataset before reading it.');
 const validate=new (require('ajv'))({allErrors:true,strict:false}).compile(contract.schema);
 if(!validate(spec))invalid(`Report input: ${validate.errors.slice(0,4).map(e=>`${e.instancePath||'/'} ${e.message}${e.params.allowedValues?'; allowed: '+e.params.allowedValues.join(', '):''}${e.params.additionalProperty?'; unexpected: '+e.params.additionalProperty:''}`).join('; ')}. Use operator (not op); see environment_interfaces for the complete queryContract.`);
 try{return reports.normalize(spec,actor);}catch(error){if(error.code==='validation_error')invalid(error.message);throw error;}
}
function parseJson(text){try{return JSON.parse(text);}catch{invalid('Provide valid JSON using the discovered tool contract. No operation ran.');}}
module.exports={operationSteps,datasetSpec,parseJson};
