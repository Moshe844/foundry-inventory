'use strict';
// Imported details arrive as one value per variant, location row and field.
// A file that lists each variant once per warehouse repeats every value per
// warehouse, and a product page of 25 variants printed thousands of lines.
// Show each distinct value once: fields every variant on the page shares,
// then each variant's own values, naming a location only when they differ.
function group(facts,skus=[]){
 const order=new Map(skus.map((sku,index)=>[sku.id,index])),bySku=new Map();
 for(const fact of facts||[]){
  let variant=bySku.get(fact.sku_id);
  if(!variant){variant={skuId:fact.sku_id,code:fact.code,fields:new Map(),sources:new Map()};bySku.set(fact.sku_id,variant);}
  const values=variant.fields.get(fact.name)||new Map();
  const where=fact.location_name||'';values.set(where,String(fact.value));variant.fields.set(fact.name,values);
  const rows=variant.sources.get(fact.source_import_id)||new Set();rows.add(Number(fact.source_row));variant.sources.set(fact.source_import_id,rows);
 }
 // One display value per variant and field: the value, or each location's value when they differ.
 const shown=values=>{const distinct=[...new Set(values.values())];
  return distinct.length===1?distinct[0]:[...values].sort(([a],[b])=>a.localeCompare(b)).map(([where,value])=>(where||'Everywhere')+': '+value).join(' · ');};
 const variants=[...bySku.values()].sort((a,b)=>(order.get(a.skuId)??1e9)-(order.get(b.skuId)??1e9)||String(a.code).localeCompare(String(b.code)));
 const names=[...new Set(variants.flatMap(v=>[...v.fields.keys()]))].sort((a,b)=>a.localeCompare(b));
 const shared=[],own=new Set();
 for(const name of names){const values=variants.map(v=>v.fields.has(name)?shown(v.fields.get(name)):null);
  if(variants.length>1&&values.every(value=>value!==null&&value===values[0]))shared.push({name,value:values[0]});else own.add(name);}
 return {shared,variants:variants.map(v=>({skuId:v.skuId,code:v.code,
  fields:[...v.fields.keys()].filter(name=>variants.length===1||own.has(name)).sort((a,b)=>a.localeCompare(b)).map(name=>({name,value:shown(v.fields.get(name))})),
  sources:[...v.sources].map(([importId,rows])=>({importId,rows:[...rows].sort((a,b)=>a-b)}))})),
  count:(facts||[]).length};
}
module.exports={group};
