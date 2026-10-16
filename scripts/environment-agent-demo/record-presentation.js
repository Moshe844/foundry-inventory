'use strict';
// Presentation-only coordinates for canonical tabular tool results. The
// durable journal keeps untouched records; coordinates never grant authority.
const META='_stockchiefRecordPaths',BASE='_stockchiefRecordPath';
const part=value=>String(value).replaceAll('~','~0').replaceAll('/','~1');
function project(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.hasOwn(value,META))return value;
 // Match the JSON wire/journal exactly, including Date and Buffer toJSON.
 // Walking driver objects directly would turn a timestamp into an empty map.
 const source=JSON.parse(JSON.stringify(value));if(Object.hasOwn(source,META))return value;
 const keys=new Set();function collect(v){if(!v||typeof v!=='object')return;for(const[k,child]of Object.entries(v)){keys.add(k);collect(child);}}collect(source);
 let field=BASE;while(keys.has(field))field+='_';let count=0;
 function visit(v,path=''){
  if(!v||typeof v!=='object')return v;
  if(Array.isArray(v))return v.map((child,index)=>visit(child,path+'/'+index));
  return Object.fromEntries(Object.entries(v).map(([key,child])=>[key,key==='rows'&&Array.isArray(child)?child.map((row,index)=>{
   const pointer=path+'/'+part(key)+'/'+index,out=visit(row,pointer);
   if(!row||typeof row!=='object'||Array.isArray(row))return out;
   count++;return {...out,[field]:pointer};
  }):visit(child,path+'/'+part(key))]));
 }
 const result=visit(source);return count?{...result,[META]:{field,meaning:'Original journal JSON Pointer for this record. Preserve when filtering or sorting; append the business field name. This coordinate is metadata, not a business fact.'}}:value;
}
function metadataClaim(original,pointer){
 if(!original||Object.hasOwn(original,META))return false;
 const encoded=project(original),field=encoded[META]?.field;if(!field)return false;
 const keys=pointer.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'));
 return keys[0]===META||keys.includes(field);
}
module.exports={project,metadataClaim};
