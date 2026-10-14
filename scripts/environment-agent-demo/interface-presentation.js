'use strict';
// Lossless presentation of governed contract metadata. The original response
// remains in the durable evidence journal. Never applied to business rows,
// browser observations or authority checks.
const KEY='_stockchiefDefinitions',PREFIX='#/'+KEY+'/';
function compact(value){
 if(!value||!Array.isArray(value.operations)||value.datasets!==undefined&&!Array.isArray(value.datasets)||Object.hasOwn(value,KEY))return value;
 const occurrences=new Map();let existingReference=false;
 function count(v){if(!v||typeof v!=='object')return;const encoded=JSON.stringify(v);
  if(typeof v.$ref==='string'&&v.$ref.startsWith(PREFIX))existingReference=true;
  if(Buffer.byteLength(encoded)>=120){const entry=occurrences.get(encoded)||{value:v,count:0};entry.count++;occurrences.set(encoded,entry);}
  for(const child of Object.values(v))count(child);
 }
 count(value);if(existingReference)return value;const candidates=new Map(),definitions={};
 for(const [encoded,entry]of occurrences)if(entry.count>1&&Buffer.byteLength(encoded)*(entry.count-1)>entry.count*70+40)candidates.set(encoded,entry.value);
 function visit(v,root=false){
  if(!v||typeof v!=='object')return v;const encoded=JSON.stringify(v);
  if(!root&&candidates.has(encoded)){let key=Object.keys(definitions).find(key=>JSON.stringify(definitions[key])===encoded);
   if(key===undefined){key='d'+Object.keys(definitions).length;definitions[key]=v;}
   return {$ref:PREFIX+key};
  }
  return Array.isArray(v)?v.map(child=>visit(child)):Object.fromEntries(Object.entries(v).map(([key,child])=>[key,visit(child)]));
 }
 const result=visit(value,true);if(!Object.keys(definitions).length)return value;
 result[KEY]=definitions;
 return Buffer.byteLength(JSON.stringify(result))<Buffer.byteLength(JSON.stringify(value))?result:value;
}
function expand(value){
 if(!value||!Object.hasOwn(value,KEY))return value;const definitions=value[KEY];
 function visit(v){if(!v||typeof v!=='object')return v;
  if(Object.keys(v).length===1&&typeof v.$ref==='string'&&v.$ref.startsWith(PREFIX)){
   const key=v.$ref.slice(PREFIX.length);if(!Object.hasOwn(definitions,key))throw Error('INTERFACE_REFERENCE_UNAVAILABLE');
   // Definitions are original subtrees, not rewritten references.
   return structuredClone(definitions[key]);
  }
  return Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).map(([key,child])=>[key,visit(child)]));
 }
 const {[KEY]:ignored,...rest}=value;return visit(rest);
}
module.exports={compact,expand};
