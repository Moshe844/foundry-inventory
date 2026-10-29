'use strict';
const {codeKey}=require('../domain/catalog-identity');
const {codeSlug}=require('../domain/item-service');
const fields=require('./fields');
const text=(row,index)=>index===undefined?'':String(row.cells[index]??'').trim();
function options(row,mappings,proposal){
 const parts=proposal.variantColumns?.length?proposal.variantColumns.map(p=>({name:p.name,value:text(row,p.index)})):fields.VARIANT_FIELDS.map(field=>({name:proposal.axisNames?.[field]||fields.FIELD_LABEL[field],value:text(row,mappings[field])}));
 return parts.filter(p=>p.value).map(p=>{const match=p.value.match(/^([^:]{1,120}):\s*(\S[\s\S]*)$/);return match&&/^(?:variant(?:\s*\(\d+\))?|option)$/i.test(p.name)?{name:match[1].trim(),value:match[2].trim()}:p;});
}
function accumulator(mappings,proposal,input={}){
 // Flat catalogues cannot contain variant families. Avoid retaining an entry
 // and two sets for every code in a million-row quantity inventory.
 if(!proposal.variantColumns?.length&&!fields.VARIANT_FIELDS.some(field=>mappings[field]!==undefined))
  return {add(){},finish(){return [];}};
 const scratch=input.boundedIdentity?require('./validation-scratch').create():null;
 const groups=scratch?scratch.map('variant-families'):new Map();
 return {add(rows){if(mappings.code===undefined)return;
 for(const row of rows){const code=Object.hasOwn(input.codeOverrides||{},row.sourceRow)?String(input.codeOverrides[row.sourceRow]).trim():text(row,mappings.code);if(!code)continue;
 const key=codeKey(code),parts=options(row,mappings,proposal),name=codeKey(text(row,mappings.name)),signature=JSON.stringify(parts.map(p=>[codeKey(p.name),codeKey(p.value)]).sort());
 const group=groups.get(key)||{name,signature,complete:true,ambiguousName:false,multipleOptions:false};
 group.ambiguousName||=group.name!==name;group.multipleOptions||=group.signature!==signature;group.complete&&=parts.length>0;groups.set(key,group);}
 },finish(){const result=[];for(const [key,g] of groups)if(g.complete&&!g.ambiguousName&&g.multipleOptions)result.push(key);return result.sort();},close(){scratch?.close();}};
}
function bases(sheet,mappings,proposal,input={}){const state=accumulator(mappings,proposal,{...input,boundedIdentity:sheet.rows.length>5000});try{state.add(sheet.rows);return state.finish();}finally{state.close?.();}}
function derived(code,parts){return [code,...parts.map(p=>codeSlug(p.value))].filter(Boolean).join('-');}
module.exports={options,bases,accumulator,derived};
