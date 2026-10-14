'use strict';
// Lossless wire representation only. The durable journal keeps the original
// observation; page content, fields, options and live handles are never trimmed.
const DEFAULTS=Object.freeze({type:null,role:null,name:null,form:null,min:null,max:null,step:null,pattern:null,maxLength:null,
 description:'',disabled:false,required:false,readOnly:false,sensitive:false,multiple:false,optionsTruncated:false});
function compact(value){
 if(value?.screen)return {...value,screen:compact(value.screen)};
 if(!value||typeof value!=='object')return value;
 // textBlocks were a second full copy of the visible text. Keep the exact
 // source string and its deterministic line-address rule on the wire. The
 // journal retains both original values for existing claim pointers.
 if(typeof value.text==='string'&&value.textBlocks&&!value.textBlockEncoding){
  const blocks=Object.fromEntries(value.text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map((line,index)=>[`line${index}`,line]));
  if(JSON.stringify(blocks)===JSON.stringify(value.textBlocks)){
   const {textBlocks,...rest}=value;value={...rest,textBlockEncoding:'trimmed_nonempty_lines'};
  }
 }
 if(!Array.isArray(value.controls)||!value.controls.length||value.controlDefaults)return value;
 const defaults=Object.fromEntries(Object.entries(DEFAULTS).filter(([key])=>value.controls.every(c=>Object.hasOwn(c,key))));
 if(!Object.keys(defaults).length)return value;
 return {...value,controlDefaults:defaults,controls:value.controls.map(c=>Object.fromEntries(Object.entries(c)
  .filter(([key,v])=>!Object.hasOwn(defaults,key)||v!==defaults[key])))};
}
function expand(value){
 if(value?.screen)return {...value,screen:expand(value.screen)};
 if(value?.textBlockEncoding==='trimmed_nonempty_lines'){
  const {textBlockEncoding,...rest}=value;value={...rest,textBlocks:Object.fromEntries(value.text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map((line,index)=>[`line${index}`,line]))};
 }
 if(!value?.controlDefaults)return value;
 const {controlDefaults,...rest}=value;return {...rest,controls:value.controls.map(c=>({...controlDefaults,...c}))};
}
module.exports={compact,expand};
