'use strict';
// Host-owned source bindings. A reference selects an ORIGINAL observation
// object; it never searches for matching values or selects today's replacement.
const {createHash}=require('node:crypto');
const META='_stockchiefSources',FIELD='_stockchiefSourceRef';
const part=value=>String(value).replaceAll('~','~0').replaceAll('/','~1');
function encode(entry,value){
 const source=JSON.parse(JSON.stringify(value)),keys=new Set();
 function collect(v){if(!v||typeof v!=='object')return;for(const[k,c]of Object.entries(v)){keys.add(k);collect(c);}}
 collect(source);let field=FIELD,metadata=META;while(keys.has(field))field+='_';while(keys.has(metadata))metadata+='_';
 const bindings=new Map();
 function visit(v,path='',selected=true){
  if(!v||typeof v!=='object')return v;
  if(Array.isArray(v))return v.map((c,i)=>visit(c,path+'/'+i,true));
  const output=Object.fromEntries(Object.entries(v).map(([k,c])=>[k,visit(c,path+'/'+part(k),
   path===''&&entry.name==='environment_browser'&&source.image&&k==='screen')]));
  if(selected){
   // The journal hash already binds every typed snapshot value. Presentation
   // coordinates must not change this binding when the same row is retrieved
   // from the raw journal rather than its lossless tool view.
   const ref='sr1:'+createHash('sha256').update(JSON.stringify([entry.id,entry.sha256,path])).digest('base64url').slice(0,24);
   const prior=bindings.get(ref);if(prior&&prior.path!==path)throw Error('SOURCE_REFERENCE_COLLISION');
   bindings.set(ref,{evidenceId:entry.id,path});output[field]=ref;
  }
  return output;
 }
 const output=visit(source);
 if(output&&typeof output==='object'&&!Array.isArray(output)){
  const notice={version:1,field,meaning:'Host source reference for this original observation object. Keep it with a record or contract when filtering or sorting. Cite sourceRef with a relative field path and the exact asserted value. References are hidden metadata, never business facts or authority.'};
  output[metadata]=notice;
  // Screenshot MCP delivery sends screen as its text block and image as a
  // separate block. Bind that delivered object at /screen, not the wrapper.
  if(entry.name==='environment_browser'&&output.image&&output.screen)output.screen[metadata]={...notice};
 }
 return {value:output,bindings,field,metadata};
}
function valid(entry){return entry&&!entry.truncated&&typeof entry.id==='string'&&typeof entry.text==='string'&&
 createHash('sha256').update(entry.text).digest('hex')===entry.sha256;}
function present(entry,value){if(!valid(entry))throw Error('INVALID_SOURCE_REFERENCE_EVIDENCE');return encode(entry,value).value;}
function index(entry){
 if(!valid(entry))throw Error('INVALID_SOURCE_REFERENCE_EVIDENCE');
 const original=JSON.parse(entry.text),wire=require('./evidence-presentation').project(entry.name,original),bindings=new Map();
 for(const value of [original,wire])for(const[ref,binding]of encode(entry,value).bindings){
  const prior=bindings.get(ref);if(prior&&(prior.evidenceId!==binding.evidenceId||prior.path!==binding.path))throw Error('SOURCE_REFERENCE_COLLISION');
  bindings.set(ref,binding);
 }
 return bindings;
}
function metadataClaim(entry,pointer,cache=new Map()){
 if(!valid(entry))return false;
 if(!cache.has(entry.id)){
  const original=JSON.parse(entry.text),wire=require('./evidence-presentation').project(entry.name,original);
  cache.set(entry.id,[original,wire].map(value=>{const encoded=encode(entry,value);return{metadata:encoded.metadata,field:encoded.field};}));
 }
 const parts=pointer.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'));
 return cache.get(entry.id).some(encoded=>parts.includes(encoded.metadata)||parts.includes(encoded.field));
}
function resolve(entries,claim,cache=new Map()){
 if(typeof claim.sourceRef!=='string'||!/^sr1:[A-Za-z0-9_-]{24}$/.test(claim.sourceRef)||typeof claim.path!=='string'||!claim.path.startsWith('/')||claim.path.length>400)
  throw Error('INVALID_SOURCE_REFERENCE');
 let selected=null;
 for(const entry of entries){
  if(!cache.has(entry?.id)){if(!valid(entry))continue;cache.set(entry.id,index(entry));}
  const found=cache.get(entry.id).get(claim.sourceRef);if(!found)continue;
  if(selected&&(selected.evidenceId!==found.evidenceId||selected.path!==found.path))throw Error('SOURCE_REFERENCE_COLLISION');selected=found;
 }
 if(!selected)throw Error('SOURCE_REFERENCE_NOT_FOUND');
 return {evidenceId:selected.evidenceId,path:selected.path+claim.path,value:claim.value,historical:claim.historical};
}
module.exports={present,index,resolve,metadataClaim};
