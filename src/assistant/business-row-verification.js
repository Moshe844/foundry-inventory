'use strict';
// Current verification of canonical record rows. Source references continue to
// address their original observation; only current record lookup uses identity.
const {isDeepStrictEqual:equal}=require('node:util'),{locate}=require('../../scripts/environment-agent-demo/evidence-presentation');
function unchangedRow(original,current,pointer){
 const match=/^(\/outcomes\/(?:0|[1-9]\d*)\/result\/(?:rows|inactiveStockWarnings|pending))\/(0|[1-9]\d*)(\/.*)?$/.exec(pointer);
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
// A host-rendered table claims its selected columns and source membership.
// With unique canonical IDs, an unrelated timestamp/field changing must not
// invalidate the displayed cells. Sources without IDs retain strict equality;
// labels, prices and positions never become inferred identities.
function unchangedTable(before,after,columns){
 if(!Array.isArray(before)||!Array.isArray(after)||!Array.isArray(columns)||!columns.length||new Set(columns).size!==columns.length)return {applicable:true,matched:false};
 const identifiable=rows=>rows.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&['string','number'].includes(typeof row.id)&&row.id!=='')&&new Set(rows.map(row=>row.id)).size===rows.length;
 if(!before.length||!identifiable(before))return {applicable:false};
 if(!identifiable(after)||before.length!==after.length||[...before,...after].some(row=>columns.some(c=>!Object.hasOwn(row,c))))return {applicable:true,matched:false};
 return {applicable:true,matched:before.every((row,index)=>equal(row.id,after[index].id)&&columns.every(column=>equal(row[column],after[index][column])))};
}
module.exports={unchangedRow,unchangedTable};
