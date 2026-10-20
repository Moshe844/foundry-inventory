'use strict';
// Lossless wire representation only. The durable journal keeps the original
// observation; page content, fields, options and live handles are never trimmed.
const DEFAULTS=Object.freeze({type:null,role:null,name:null,form:null,min:null,max:null,step:null,pattern:null,maxLength:null,
 description:'',disabled:false,required:false,readOnly:false,sensitive:false,multiple:false,optionsTruncated:false});
const WINDOW='_stockchiefInspectionWindow';
const windowNotice='This is paging of the inspection tool response only. It does not mean the application or its select control is paginated. Retrieve nextRef to inspect omitted output; describe the actual DOM separately.';
function windowed(value){
 if(!value||typeof value!=='object')return value;
 const result={...value};
 if(Object.hasOwn(value,'pagination')&&!Object.hasOwn(value,WINDOW)){
  delete result.pagination;result[WINDOW]={kind:'inspection_response',notice:windowNotice,page:value.pagination};
 }
 if(Array.isArray(value.controls))result.controls=value.controls.map(control=>{
  if(Object.hasOwn(control,WINDOW))return control;
  // describe() has optional undefined JS properties even on ordinary links
  // and inputs. They are absent on the JSON wire; do not manufacture an empty
  // options window (and repeat its notice) for every non-select control.
  const paging=Object.fromEntries(['optionsOffset','optionsTruncated','optionsNextRef'].filter(k=>Object.hasOwn(control,k)&&control[k]!==undefined).map(k=>[k,control[k]]));
  if(!Object.keys(paging).length)return control;
  const result={...control};for(const key of Object.keys(paging))delete result[key];
  return {...result,[WINDOW]:{kind:'inspection_response',notice:windowNotice,options:paging}};
 });
 return result;
}
function unwindowed(value){
 if(!value||typeof value!=='object')return value;
 const result={...value};
 if(value[WINDOW]?.kind==='inspection_response'&&Object.hasOwn(value[WINDOW],'page')){
  result.pagination=value[WINDOW].page;delete result[WINDOW];
 }
 if(Array.isArray(value.controls))result.controls=value.controls.map(control=>{
  if(control[WINDOW]?.kind!=='inspection_response'||!control[WINDOW].options)return control;
  const result={...control,...control[WINDOW].options};delete result[WINDOW];return result;
 });
 return result;
}
function compact(value,{compactControls=true,inspectionWindows=true}={}){
 if(value?.screen)return {...value,screen:compact(value.screen,{compactControls,inspectionWindows})};
 if(!value||typeof value!=='object')return value;
 // Preserve explicit line labels: asking the model to count an unlabelled
 // page creates unverifiable citations. Encode only the duplicate full text.
 // Separators restore its exact whitespace; journal claim pointers stay intact.
 if(typeof value.text==='string'&&value.textBlocks&&!value.textEncoding){
  const blocks=Object.fromEntries(value.text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map((line,index)=>[`line${index}`,line]));
  if(JSON.stringify(blocks)===JSON.stringify(value.textBlocks)){
   const separators=[];let cursor=0;
   for(const match of value.text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)){
    const block=match[0].trim();if(!block)continue;
    const at=match.index+match[0].indexOf(block);separators.push(value.text.slice(cursor,at));cursor=at+block.length;
   }
   separators.push(value.text.slice(cursor));
   const {text,...rest}=value;value={...rest,textEncoding:'labelled_blocks_and_separators',textSeparators:separators};
  }
 }
 const encodeWindow=inspectionWindows?windowed:value=>value;
 if(!compactControls||!Array.isArray(value.controls)||!value.controls.length||value.controlDefaults)return encodeWindow(value);
 const defaults=Object.fromEntries(Object.entries(DEFAULTS).filter(([key])=>value.controls.every(c=>Object.hasOwn(c,key))));
 if(!Object.keys(defaults).length)return encodeWindow(value);
 return encodeWindow({...value,controlDefaults:defaults,controls:value.controls.map(c=>Object.fromEntries(Object.entries(c)
  .filter(([key,v])=>!Object.hasOwn(defaults,key)||v!==defaults[key])))});
}
function expand(value){
 if(value?.screen)return {...value,screen:expand(value.screen)};
 value=unwindowed(value);
 if(value?.textEncoding==='labelled_blocks_and_separators'){
  const {textEncoding,textSeparators,...rest}=value,blocks=Object.values(value.textBlocks);
  value={...rest,text:blocks.map((block,index)=>textSeparators[index]+block).join('')+textSeparators.at(-1)};
 }
 if(!value?.controlDefaults)return value;
 const {controlDefaults,...rest}=value;return {...rest,controls:value.controls.map(c=>({...controlDefaults,...c}))};
}
module.exports={compact,expand};
