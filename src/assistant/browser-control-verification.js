'use strict';
// Host-only evidence comparison. Interaction refs are observation-local opaque
// handles, never durable business facts or an execution/approval grant.
const pointer=/^(\/screen)?\/controls\/(0|[1-9]\d*)(\/.*)?$/;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
function facts(control){if(!control||typeof control!=='object'||Array.isArray(control))return null;
 const {ref,optionsNextRef,evidencePath,...value}=control;return JSON.stringify(stable(value));}
function unchangedControl(previous,current,path){
 const match=pointer.exec(path);if(!match)return {applicable:false,matched:false};
 const old=match[1]?previous.screen:previous,fresh=match[1]?current.screen:current,suffix=match[3]||'';
 if(!Array.isArray(old?.controls)||!Array.isArray(fresh?.controls)||/^\/(?:ref|optionsNextRef|evidencePath)(?:\/|$)/.test(suffix))return {applicable:true,matched:false};
 const original=old.controls[Number(match[2])],identity=facts(original);
 const sameSequence=old.controls.length===fresh.controls.length&&old.controls.every((control,index)=>facts(control)===facts(fresh.controls[index]));
 // A full unchanged field/control, not a matching isolated value, anchors the
 // fact. Its label, name, form target, constraints, options, flags and value
 // must ALL match. Duplicate fields are ambiguous and cannot be rebased.
 // Repeated names/labels are valid HTML (for example ordered array fields).
 // Their ordinal is anchored only when the ENTIRE observed control sequence
 // is unchanged. If any control changed, preserve strict unique rebasing.
 if(!identity||!sameSequence&&old.controls.filter(c=>facts(c)===identity).length!==1)return {applicable:true,matched:false};
 const matches=sameSequence?[{control:fresh.controls[Number(match[2])],index:Number(match[2])}]:fresh.controls.map((control,index)=>({control,index})).filter(({control})=>facts(control)===identity);
 if(matches.length!==1)return {applicable:true,matched:false};
 let value=original;
 if(suffix)for(const part of suffix.slice(1).split('/')){
  const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
  if(['__proto__','constructor','prototype','ref','optionsNextRef','evidencePath'].includes(key)||value===null||typeof value!=='object'||!Object.hasOwn(value,key))return {applicable:true,matched:false};
  value=value[key];
 }
 return {applicable:true,matched:true,value,currentPointer:(match[1]||'')+'/controls/'+matches[0].index+suffix};
}
module.exports={facts,unchangedControl};
