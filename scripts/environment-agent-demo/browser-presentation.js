'use strict';
// Lossless wire representation only. The durable journal keeps the original
// observation; page content, fields, options and live handles are never trimmed.
const DEFAULTS=Object.freeze({type:null,role:null,name:null,form:null,min:null,max:null,step:null,pattern:null,maxLength:null,
 description:'',disabled:false,required:false,readOnly:false,sensitive:false,multiple:false,optionsTruncated:false});
function compact(value){
 if(value?.screen)return {...value,screen:compact(value.screen)};
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
 if(!Array.isArray(value.controls)||!value.controls.length||value.controlDefaults)return value;
 const defaults=Object.fromEntries(Object.entries(DEFAULTS).filter(([key])=>value.controls.every(c=>Object.hasOwn(c,key))));
 if(!Object.keys(defaults).length)return value;
 return {...value,controlDefaults:defaults,controls:value.controls.map(c=>Object.fromEntries(Object.entries(c)
  .filter(([key,v])=>!Object.hasOwn(defaults,key)||v!==defaults[key])))};
}
function expand(value){
 if(value?.screen)return {...value,screen:expand(value.screen)};
 if(value?.textEncoding==='labelled_blocks_and_separators'){
  const {textEncoding,textSeparators,...rest}=value,blocks=Object.values(value.textBlocks);
  value={...rest,text:blocks.map((block,index)=>textSeparators[index]+block).join('')+textSeparators.at(-1)};
 }
 if(!value?.controlDefaults)return value;
 const {controlDefaults,...rest}=value;return {...rest,controls:value.controls.map(c=>({...controlDefaults,...c}))};
}
module.exports={compact,expand};
