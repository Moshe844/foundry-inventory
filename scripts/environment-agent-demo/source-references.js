'use strict';
// Host-owned source bindings. A reference selects an ORIGINAL observation
// object; it never searches for matching values or selects today's replacement.
const {createHash}=require('node:crypto');
const META='_stockchiefSources',FIELD='_stockchiefSourceRef',VALUES='_stockchiefValueRefs';
const part=value=>String(value).replaceAll('~','~0').replaceAll('/','~1');
function encode(entry,value,{legacy=false,indexHeadings=false,indexRepresentation=false}={}){
 const source=JSON.parse(JSON.stringify(value)),keys=new Set();
 function collect(v){if(!v||typeof v!=='object')return;for(const[k,c]of Object.entries(v)){keys.add(k);collect(c);}}
 collect(source);let field=FIELD,metadata=META,valueField=VALUES;while(keys.has(field))field+='_';while(keys.has(metadata))metadata+='_';while(keys.has(valueField))valueField+='_';
 const original=JSON.parse(entry.text),coordinates=!Object.hasOwn(original,'_stockchiefRecordPaths')&&source?._stockchiefRecordPaths?.field;
 const generated=new Set(coordinates?['_stockchiefRecordPaths',coordinates]:[]);
 const bindings=new Map();
 function fieldReference(pointer){
  const ref='fv1:'+createHash('sha256').update(JSON.stringify([entry.id,entry.sha256,pointer])).digest('base64url').slice(0,16);
  const prior=bindings.get(ref);if(prior&&prior.path!==pointer)throw Error('SOURCE_REFERENCE_COLLISION');
  bindings.set(ref,{evidenceId:entry.id,path:pointer,kind:'value'});return ref;
 }
 function visit(v,path='',selected=true){
  if(!v||typeof v!=='object')return v;
  if(entry.name==='environment_browser'&&path==='/image')return v;
  if(Array.isArray(v))return v.map((c,i)=>visit(c,path+'/'+i,true));
  // The browser already labels each complete visible text block. Use its
  // complete field reference as that label instead of repeating a second
  // per-line map. Original line keys remain untouched in the journal.
  if(!legacy&&entry.name==='environment_browser'&&/^\/(?:screen\/)?textBlocks$/.test(path)&&Object.values(v).every(text=>typeof text==='string'))
   return Object.fromEntries(Object.entries(v).map(([key,text])=>[fieldReference(path+'/'+part(key)),text]));
  // Table headings describe the representation. Issuing a fact reference for
  // a heading such as "currency" alongside actual currency values made the
  // recorded native answer bind a record count to a column label and require a paid
  // correction. Keep headings intact, without presenting them as record facts.
  // Legacy indexing still resolves old bindings to their exact original value.
  const heading=k=>!legacy&&!indexHeadings&&!indexRepresentation&&(
   ['business_operations','environment_dataset'].includes(entry.name)&&Array.isArray(v.rows)&&Array.isArray(v.columns)&&['columns','columnLabels'].includes(k)||
   // Page coordinates, formatting and action handles are transport metadata.
   // Keep all values losslessly without issuing redundant factual bindings.
   // Unknown fields, labels, values, constraints and options stay citable.
   entry.name==='environment_browser'&&(
    ['','/screen'].includes(path)&&['textRegions','controlDefaults','pagination'].includes(k)||
    ['','/screen'].includes(path)&&v.textEncoding==='labelled_blocks_and_separators'&&['textEncoding','textSeparators'].includes(k)||
    /^\/(?:screen\/)?controls\/\d+$/.test(path)&&['ref','evidencePath','optionsNextRef'].includes(k)));
  const output=Object.fromEntries(Object.entries(v).filter(([k])=>legacy||!generated.has(k)).map(([k,c])=>[k,heading(k)?c:visit(c,path+'/'+part(k),
   Boolean(path===''&&entry.name==='environment_browser'&&source.image&&k==='screen'))]));
  const values={};
  for(const[k,value]of Object.entries(v)){
   const pointer=path+'/'+part(k);
   if(heading(k)||generated.has(k)||entry.name==='environment_browser'&&pointer==='/image'||/^\/(?:screen\/)?viewState(?:\/|$)/.test(pointer))continue;
   // A presented container can contain host labels or projected children.
   // Its displayed JSON is not the original factual value. New reports cite
   // the primitive leaves; historical container bindings remain indexed.
   if(legacy||value===null||typeof value!=='object')values[k]=fieldReference(pointer);
   if(!legacy&&Array.isArray(value)){
    const leaves=(array,at,label)=>array.forEach((child,index)=>{
     if(Array.isArray(child))leaves(child,at+'/'+index,label+'['+index+']');
     else if(child===null||typeof child!=='object'){
      let key=label+'['+index+']';while(Object.hasOwn(v,key)||Object.hasOwn(values,key))key+='_';
      values[key]=fieldReference(at+'/'+index);
     }
    });leaves(value,pointer,k);
   }
  }
  if(!legacy&&Object.keys(values).length)output[valueField]=values;
  if(legacy&&selected){
   // The journal hash already binds every typed snapshot value. Presentation
   // coordinates must not change this binding when the same row is retrieved
   // from the raw journal rather than its lossless tool view.
   const ref='sr1:'+createHash('sha256').update(JSON.stringify([entry.id,entry.sha256,path])).digest('base64url').slice(0,24);
   const prior=bindings.get(ref);if(prior&&prior.path!==path)throw Error('SOURCE_REFERENCE_COLLISION');
   bindings.set(ref,{evidenceId:entry.id,path,kind:'object'});output[field]=ref;
  }
  return output;
 }
 const output=visit(source);
 if(output&&typeof output==='object'&&!Array.isArray(output)){
  const notice=legacy?{version:1,field,meaning:'Legacy object reference; paths are relative to this object.'}:
   {version:2,valueField,meaning:'Copy the field reference and exact value; no path or observation ID. Browser textBlocks keys are already complete field references. Hidden metadata; no business authority.'};
  output[metadata]=notice;
  // Screenshot MCP delivery sends screen as its text block and image as a
  // separate block. Bind that delivered object at /screen, not the wrapper.
  if(entry.name==='environment_browser'&&output.image&&output.screen)output.screen[metadata]={...notice};
 }
 return {value:output,bindings,field,metadata,valueField};
}
function valid(entry){return entry&&!entry.truncated&&typeof entry.id==='string'&&typeof entry.text==='string'&&
 createHash('sha256').update(entry.text).digest('hex')===entry.sha256;}
function present(entry,value,options){if(!valid(entry))throw Error('INVALID_SOURCE_REFERENCE_EVIDENCE');return encode(entry,value,options).value;}
function index(entry){
 if(!valid(entry))throw Error('INVALID_SOURCE_REFERENCE_EVIDENCE');
 const original=JSON.parse(entry.text),wire=require('./evidence-presentation').project(entry.name,original),bindings=new Map();
 for(const value of [original,wire])for(const mode of [{legacy:false},{legacy:true},{indexRepresentation:true}])for(const[ref,binding]of encode(entry,value,mode).bindings){
  const prior=bindings.get(ref);if(prior&&(prior.evidenceId!==binding.evidenceId||prior.path!==binding.path))throw Error('SOURCE_REFERENCE_COLLISION');
  bindings.set(ref,binding);
 }
 // A prior browser codec accidentally issued object anchors on root children
 // when image was absent. Decode those ORIGINAL bindings for saved reports;
 // never reissue them in new tool output or reinterpret their relative paths.
 if(entry.name==='environment_browser'&&!Object.hasOwn(original,'image'))for(const view of [original,wire])for(const [key,value]of Object.entries(view)){
  if(!value||typeof value!=='object'||Array.isArray(value))continue;
  const pointer='/'+part(key),ref='sr1:'+createHash('sha256').update(JSON.stringify([entry.id,entry.sha256,pointer])).digest('base64url').slice(0,24);
  bindings.set(ref,{evidenceId:entry.id,path:pointer,kind:'object'});
 }
 return bindings;
}
function metadataClaim(entry,pointer,cache=new Map()){
 if(!valid(entry))return false;
 if(!cache.has(entry.id)){
  const original=JSON.parse(entry.text),wire=require('./evidence-presentation').project(entry.name,original);
  cache.set(entry.id,[original,wire].map(value=>{const encoded=encode(entry,value);return{metadata:encoded.metadata,field:encoded.field,valueField:encoded.valueField};}));
 }
 const parts=pointer.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'));
 return cache.get(entry.id).some(encoded=>parts.includes(encoded.metadata)||parts.includes(encoded.field)||parts.includes(encoded.valueField));
}
function resolve(entries,claim,cache=new Map()){
 if(typeof claim.sourceRef!=='string'||!(/^(?:sr1:[A-Za-z0-9_-]{24}|fv1:[A-Za-z0-9_-]{16})$/).test(claim.sourceRef))
  throw Error('INVALID_SOURCE_REFERENCE');
 let selected=null;
 for(const entry of entries){
  if(!cache.has(entry?.id)){if(!valid(entry))continue;cache.set(entry.id,index(entry));}
  const found=cache.get(entry.id).get(claim.sourceRef);if(!found)continue;
  if(selected&&(selected.evidenceId!==found.evidenceId||selected.path!==found.path))throw Error('SOURCE_REFERENCE_COLLISION');selected=found;
 }
 if(!selected)throw Error('SOURCE_REFERENCE_NOT_FOUND');
 if(selected.kind==='value'){
  if(Object.hasOwn(claim,'path'))throw Error('FIELD_REFERENCE_MUST_NOT_SUPPLY_PATH');
  return {evidenceId:selected.evidenceId,path:selected.path,value:claim.value,historical:claim.historical};
 }
 if(typeof claim.path!=='string'||!claim.path.startsWith('/')||claim.path.length>400)throw Error('INVALID_SOURCE_REFERENCE');
 return {evidenceId:selected.evidenceId,path:selected.path+claim.path,value:claim.value,historical:claim.historical};
}
module.exports={present,index,resolve,metadataClaim};
