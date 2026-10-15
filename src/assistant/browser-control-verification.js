'use strict';
// Host-only evidence comparison. Interaction refs are observation-local opaque
// handles, never durable business facts or an execution/approval grant.
const pointer=/^(\/screen)?\/controls\/(0|[1-9]\d*)(\/.*)?$/;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
function facts(control){if(!control||typeof control!=='object'||Array.isArray(control))return null;
 const {ref,optionsNextRef,...value}=control;return JSON.stringify(stable(value));}
function unchangedControl(previous,current,path){
 const match=pointer.exec(path);if(!match)return {applicable:false,matched:false};
 const old=match[1]?previous.screen:previous,fresh=match[1]?current.screen:current,suffix=match[3]||'';
 if(!Array.isArray(old?.controls)||!Array.isArray(fresh?.controls)||/^\/(?:ref|optionsNextRef)(?:\/|$)/.test(suffix))return {applicable:true,matched:false};
 const original=old.controls[Number(match[2])],identity=facts(original);
 // A full unchanged field/control, not a matching isolated value, anchors the
 // fact. Its label, name, form target, constraints, options, flags and value
 // must ALL match. Duplicate fields are ambiguous and cannot be rebased.
 if(!identity||old.controls.filter(c=>facts(c)===identity).length!==1)return {applicable:true,matched:false};
 const matches=fresh.controls.map((control,index)=>({control,index})).filter(({control})=>facts(control)===identity);
 if(matches.length!==1)return {applicable:true,matched:false};
 let value=original;
 if(suffix)for(const part of suffix.slice(1).split('/')){
  const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
  if(['__proto__','constructor','prototype','ref','optionsNextRef'].includes(key)||value===null||typeof value!=='object'||!Object.hasOwn(value,key))return {applicable:true,matched:false};
  value=value[key];
 }
 return {applicable:true,matched:true,value,currentPointer:(match[1]||'')+'/controls/'+matches[0].index+suffix};
}
module.exports={unchangedControl};
