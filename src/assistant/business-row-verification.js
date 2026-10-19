'use strict';
// Current verification of canonical record rows. Source references continue to
// address their original observation; only current record lookup uses identity.
const {isDeepStrictEqual:equal}=require('node:util'),{locate}=require('../../scripts/environment-agent-demo/evidence-presentation');
function unchangedRow(original,current,pointer){
 const match=/^(\/outcomes\/(?:0|[1-9]\d*)\/result\/rows)\/(0|[1-9]\d*)(\/.*)?$/.exec(pointer);
 if(!match)return {applicable:false};
 const before=locate(original,match[1]).value,after=locate(current,match[1]).value,index=Number(match[2]),suffix=match[3]||'';
 if(!Array.isArray(before)||!Array.isArray(after)||!before[index]||typeof before[index]!=='object')return {applicable:true,matched:false};
 if([...before,...after].some(r=>!r||typeof r!=='object'||Array.isArray(r)))return {applicable:true,matched:false};
 const row=before[index];
 for(const key of ['id']){
  const value=row[key];if(!['string','number'].includes(typeof value)||value==='')continue;
  // Shared page links and duplicated IDs are not record identities. Never
  // select a row by an asserted amount, label, reason, position or fuzzy match.
  if(before.filter(r=>r&&equal(r[key],value)).length!==1)return {applicable:true,matched:false};
  const matches=after.filter(r=>r&&equal(r[key],value));
  if(matches.length!==1)return {applicable:true,matched:false};
  const selected=suffix?locate(matches[0],suffix):{found:true,value:matches[0]};
  return {applicable:true,matched:selected.found,value:selected.value};
 }
 // Legacy/aggregate rows without canonical IDs may only retain their position
 // when the ENTIRE original sequence is unchanged. A navigation URL, label or
 // coincidentally equal amount cannot identify a replacement record. New IDs
 // must remain exactly equal; never infer an identity absent from the source.
 const comparable=after;
 if(!equal(before,comparable))return {applicable:true,matched:false};
 const selected=suffix?locate(comparable[index],suffix):{found:true,value:comparable[index]};
 return {applicable:true,matched:selected.found,value:selected.value};
}
module.exports={unchangedRow};
