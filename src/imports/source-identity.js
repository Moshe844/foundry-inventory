'use strict';
const {codeKey}=require('../domain/catalog-identity');
const {codeSlug}=require('../domain/item-service');
const fields=require('./fields');
const text=(row,index)=>index===undefined?'':String(row.cells[index]??'').trim();
function options(row,mappings,proposal){
 const parts=proposal.variantColumns?.length?proposal.variantColumns.map(p=>({name:p.name,value:text(row,p.index)})):fields.VARIANT_FIELDS.map(field=>({name:proposal.axisNames?.[field]||fields.FIELD_LABEL[field],value:text(row,mappings[field])}));
 return parts.filter(p=>p.value).map(p=>{const match=p.value.match(/^([^:]{1,120}):\s*(\S[\s\S]*)$/);return match&&/^(?:variant(?:\s*\(\d+\))?|option)$/i.test(p.name)?{name:match[1].trim(),value:match[2].trim()}:p;});
}
function bases(sheet,mappings,proposal,input={}){
 const groups=new Map();if(mappings.code===undefined)return [];
 for(const row of sheet.rows){const code=Object.hasOwn(input.codeOverrides||{},row.sourceRow)?String(input.codeOverrides[row.sourceRow]).trim():text(row,mappings.code);if(!code)continue;
 const key=codeKey(code),group=groups.get(key)||{names:new Set(),options:new Set(),complete:true};
 const parts=options(row,mappings,proposal);group.names.add(codeKey(text(row,mappings.name)));group.complete&&=parts.length>0;
 group.options.add(JSON.stringify(parts.map(p=>[codeKey(p.name),codeKey(p.value)]).sort()));groups.set(key,group);}
 return [...groups].filter(([,g])=>g.complete&&g.names.size===1&&g.options.size>1).map(([key])=>key);
}
function derived(code,parts){return [code,...parts.map(p=>codeSlug(p.value))].filter(Boolean).join('-');}
module.exports={options,bases,derived};
