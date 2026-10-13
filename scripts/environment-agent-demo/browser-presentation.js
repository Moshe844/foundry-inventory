'use strict';
// Lossless wire representation only. The durable journal keeps the original
// observation; page content, fields, options and live handles are never trimmed.
const DEFAULTS=Object.freeze({type:null,role:null,name:null,form:null,min:null,max:null,step:null,pattern:null,maxLength:null,
 description:'',disabled:false,required:false,readOnly:false,sensitive:false,multiple:false,optionsTruncated:false});
function compact(value){
 if(value?.screen)return {...value,screen:compact(value.screen)};
 if(!Array.isArray(value?.controls)||!value.controls.length||value.controlDefaults)return value;
 const defaults=Object.fromEntries(Object.entries(DEFAULTS).filter(([key])=>value.controls.every(c=>Object.hasOwn(c,key))));
 if(!Object.keys(defaults).length)return value;
 return {...value,controlDefaults:defaults,controls:value.controls.map(c=>Object.fromEntries(Object.entries(c)
  .filter(([key,v])=>!Object.hasOwn(defaults,key)||v!==defaults[key])))};
}
function expand(value){
 if(value?.screen)return {...value,screen:expand(value.screen)};
 if(!value?.controlDefaults)return value;
 const {controlDefaults,...rest}=value;return {...rest,controls:value.controls.map(c=>({...controlDefaults,...c}))};
}
module.exports={compact,expand};
