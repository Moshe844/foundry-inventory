'use strict';
// Prove simple relational sources from the complete workbook before asking a
// model. This produces only the existing typed source contract: compile(), row
// validation, source coverage, tracking and business approval stay authoritative.
const fields=require('./fields'),relations=require('./workbook-relations');
const key=value=>String(value??'').normalize('NFKC').trim();
const ref=(sheet,column)=>({sheet,column});
function unique(sheet,column){const values=new Map();for(const row of sheet.rows){const value=key(row.cells[column]);if(!value||values.has(value))return null;values.set(value,row);}return values;}
function infer(workbook){
 const sheets=workbook.sheets,profiles=sheets.map(s=>fields.guessMappings(s.columns,s.rows));
 const stock=sheets.map((sheet,index)=>({sheet,index,profile:profiles[index]})).filter(({sheet,profile:p})=>sheet.rows.length&&p.confident.includes('code')&&p.confident.includes('quantity')&&
  /\b(?:on\s*hand|onhand|physical|counted|stock\s*(?:count|level))\b/.test(fields.normalise(sheet.columns.find(c=>c.index===p.mappings.quantity).name))&&unique(sheet,p.mappings.code));
 if(!stock.length)return null;stock.sort((a,b)=>b.sheet.rows.length-a.sheet.rows.length);
 if(stock[1]?.sheet.rows.length===stock[0].sheet.rows.length)return null;
 const baseSheet=stock[0].index,base=sheets[baseSheet],baseProfile=profiles[baseSheet],used=new Set([baseSheet]),joined=base.rows.map(row=>new Map([[baseSheet,row]])),joins=[];
 let changed=true;
 while(changed){changed=false;
  for(let target=0;target<sheets.length;target++){
   const sheet=sheets[target];if(used.has(target)||!sheet.rows.length||profiles[target].mappings.quantity!==undefined)continue;
   const candidates=[];
   for(const from of used)for(const sourceColumn of sheets[from].columns){
    const name=fields.normalise(sourceColumn.name);
    if(sourceColumn.index!==profiles[from].mappings.code&&!/\b(?:id|identifier|key)$/.test(name))continue;
    for(const targetColumn of sheet.columns){
     if(fields.normalise(targetColumn.name)!==name)continue;
     const lookup=unique(sheet,targetColumn.index);if(!lookup)continue;
     const matches=joined.map(rows=>lookup.get(key(rows.get(from)?.cells[sourceColumn.index])));
     if(matches.some(row=>!row))continue;
     candidates.push({join:{sheet:target,fromSheet:from,fromColumn:sourceColumn.index,toColumn:targetColumn.index},matches});
    }
   }
   if(!candidates.length)continue;
   if(candidates.some(c=>c.matches.some((row,i)=>row!==candidates[0].matches[i])))return null;
   const chosen=candidates[0];joins.push(chosen.join);used.add(target);chosen.matches.forEach((row,i)=>joined[i].set(target,row));changed=true;
  }
 }
 if(!joins.length)return null;
 const chosenFields=[];
 for(const field of fields.FIELD_IDS.filter(f=>!fields.VARIANT_FIELDS.includes(f))){
  const candidates=[...used].filter(s=>profiles[s].confident.includes(field)||field==='name'&&profiles[s].mappings.name!==undefined).map(s=>ref(s,profiles[s].mappings[field]));
  if(!candidates.length)continue;
  // A field already explicit in the stock source keeps that authority. Other
  // duplicate sources must agree for EVERY source row, not just a sample.
  const preferred=candidates.find(r=>r.sheet===baseSheet)||candidates[0];
  if(!candidates.some(r=>r.sheet===baseSheet)&&candidates.some(r=>joined.some(rows=>key(rows.get(r.sheet).cells[r.column])!==key(rows.get(preferred.sheet).cells[preferred.column]))))return null;
  chosenFields.push({field,source:preferred});
 }
 if(!chosenFields.some(f=>f.field==='name'))return null;
 const locationNames=new Set();
 for(const[s,sheet]of sheets.entries())for(const column of sheet.columns){
  if(!fields.bestFieldScores(column.name).some(score=>score.field==='location'&&!score.weak))continue;
  for(const row of sheet.rows){const value=key(row.cells[column.index]);if(value)locationNames.add(fields.normalise(value));}
 }
 const mapped=new Set(Object.values(baseProfile.mappings));
 const numericComponents=base.columns.filter(c=>!mapped.has(c.index)&&!fields.isStockSummary(c.name)&&!fields.ignorableAs(c.name)&&baseProfile.profiles.find(p=>p.index===c.index)?.numericRate===1);
 const namedComponents=base.columns.filter(c=>c.index!==baseProfile.mappings.quantity&&locationNames.has(fields.normalise(c.name))&&!fields.isStockSummary(c.name));
 // Accept the entire set of possible components only. Never search for a
 // convenient subset that happens to equal a total on the sampled rows.
 const components=(numericComponents.length>=2?numericComponents:namedComponents).map(c=>ref(baseSheet,c.index));
 if(components.length){
  const read=require('./row-validator').readQuantity;
  for(const row of base.rows){const total=read(row.cells[baseProfile.mappings.quantity]),parts=components.map(r=>read(row.cells[r.column]));
   if(!total.ok||total.value===null||parts.some(p=>!p.ok||p.value===null)||parts.reduce((n,p)=>n+p.value,0)!==total.value)return null;}
 }
 // An unrecognized numeric stock component cannot silently become a raw custom
 // field. Without an evidenced location list, leave the relationship to review.
 const accounted=new Set([...Object.values(baseProfile.mappings),...components.map(r=>r.column)]);
 if(!components.length)for(const column of base.columns)if(!accounted.has(column.index)&&!fields.isStockSummary(column.name)&&!fields.ignorableAs(column.name)&&baseProfile.profiles.find(p=>p.index===column.index)?.numericRate>=.8)return null;
 const variants=[];for(const s of used)for(const field of fields.VARIANT_FIELDS){const column=profiles[s].mappings[field];if(column===undefined)continue;const name=fields.normalise(sheets[s].columns.find(c=>c.index===column).name);const same=variants.find(r=>fields.normalise(sheets[r.sheet].columns.find(c=>c.index===r.column).name)===name);if(same){if(joined.some(rows=>key(rows.get(s).cells[column])!==key(rows.get(same.sheet).cells[same.column])))return null;}else variants.push(ref(s,column));}
 // Some catalogues explicitly list their configuration axes in source data.
 // Resolve those declarations to actual columns, without choosing axes from
 // low-cardinality values or naming a fixed set of product characteristics.
 const headers=new Map();for(const s of used)for(const column of sheets[s].columns){const name=fields.normalise(column.name),list=headers.get(name)||[];list.push(ref(s,column.index));headers.set(name,list);}
 for(const s of used)for(const column of sheets[s].columns){
  const declarations=new Set(sheets[s].rows.map(row=>key(row.cells[column.index])));
  for(const declaration of declarations){
   const names=declaration.split(/\s*[,;|/]\s*/).map(fields.normalise);if(names.length<2||names.some(name=>!headers.has(name)))continue;
   const selected=[];let usable=true;
   for(const name of names){const candidates=headers.get(name).filter(r=>!Object.entries(profiles[r.sheet].mappings).some(([field,c])=>c===r.column&&!fields.VARIANT_FIELDS.includes(field)));if(!candidates.length){usable=false;break;}
    const first=candidates[0];if(candidates.some(r=>joined.some(rows=>key(rows.get(r.sheet).cells[r.column])!==key(rows.get(first.sheet).cells[first.column]))))return null;selected.push(first);}
   if(!usable)continue;
   for(const r of selected)if(!variants.some(v=>v.sheet===r.sheet&&v.column===r.column))variants.push(r);
  }
 }
 const contract={baseSheet,joins,fields:chosenFields.filter(f=>!components.length||!['quantity','location'].includes(f.field)),variants,
  stock:{total:components.length?ref(baseSheet,baseProfile.mappings.quantity):null,locations:components},
  coverage:sheets.map((sheet,s)=>({sheet:s,role:s===baseSheet?'inventory':used.has(s)?'reference':'not_imported',reason:s===baseSheet?'Current physical stock source.':used.has(s)?'Unique identifiers match every stock record; complementary fields are retained.':'No complete, unique stock-source relationship was proved; retained in the original source for separate review.'}))};
 let result;
 try{result=relations.compile(workbook,contract);}catch(error){if(error instanceof require('../domain/errors').ValidationError)return null;throw error;}
 if(result.issueCount)return null;
 return {...result,aiUsed:false,reconciliations:[...result.reconciliations,'Worksheet links were verified against every source identifier. No sampled or incomplete join was used.']};
}
module.exports={infer};
