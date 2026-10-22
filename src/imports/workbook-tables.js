'use strict';

const fields=require('./fields'),mapping=require('./mapping-service'),money=require('./source-money'),{codeKey}=require('../domain/catalog-identity');
const normalized=value=>String(value??'').normalize('NFKC').trim().toLowerCase();

// Combine disjoint product tables only when their registered field meanings,
// variant axes and monetary units agree. Related/overlapping tables still use
// the existing relationship interpreter or require a visible scope decision.
async function combine(workbook){
 const tables=[];
 for(const [index,sheet]of workbook.sheets.entries()){
  if(!sheet.rows.length)continue;
  const proposal=await mapping.proposeMappings(sheet,{allowModel:false});
  if(['code','name','quantity'].some(field=>proposal.mappings[field]===undefined))return null;
  const assigned=new Map(Object.entries(proposal.mappings).map(([field,column])=>[column,field]));
  const keys=new Map(sheet.columns.map(column=>{const field=assigned.get(column.index);return [column.index,field?'field:'+field:'column:'+normalized(column.name)];}));
  if(new Set(keys.values()).size!==keys.size)return null;
  const signature=JSON.stringify(Object.entries(proposal.mappings).sort(([a],[b])=>a.localeCompare(b)).map(([field,column])=>[field,
   fields.VARIANT_FIELDS.includes(field)?normalized(proposal.axisNames?.[field]||sheet.columns.find(c=>c.index===column).name):null,
   ['unitCost','sellingPrice'].includes(field)?money.codes(sheet.columns.find(c=>c.index===column).name).sort():null]));
  if(tables.length&&signature!==tables[0].signature)return null;
  tables.push({index,sheet,proposal,keys,signature});
 }
 if(tables.length<2)return null;
 const identities=new Set();
 for(const table of tables){let products=0;for(const row of table.sheet.rows){const code=codeKey(row.cells[table.proposal.mappings.code]),name=String(row.cells[table.proposal.mappings.name]??'').trim();if(!code||!name)continue;
   if(identities.has(code))return null;identities.add(code);products++;}if(!products)return null;}
 const columns=[],indexes=new Map();
 for(const table of tables)for(const column of table.sheet.columns){const key=table.keys.get(column.index);if(!indexes.has(key)){indexes.set(key,columns.length);columns.push({index:columns.length,name:column.name});}}
 if(columns.length>require('./parser').LIMITS.maxColumns)return null;
 const mappings=Object.fromEntries(Object.keys(tables[0].proposal.mappings).map(field=>[field,indexes.get('field:'+field)])),provenanceIndex=columns.length;columns.push({index:provenanceIndex,name:'Source worksheet rows'});
 const problemsIndex=columns.length;columns.push({index:problemsIndex,name:'Workbook reconciliation checks'});
 const rows=[];let physicalUnits=0;
 for(const table of tables)for(const source of table.sheet.rows){const cells=new Array(columns.length).fill('');for(const column of table.sheet.columns)cells[indexes.get(table.keys.get(column.index))]=source.cells[column.index]??'';
  cells[provenanceIndex]=JSON.stringify({[table.sheet.name]:source.sourceRow});cells[problemsIndex]='[]';rows.push({sourceRow:rows.length+1,cells});
  if(rows.length>require('./parser').LIMITS.maxRows)throw new (require('../domain/errors').ValidationError)('The combined workbook exceeds the import row capacity. No rows were truncated.');
  const quantity=require('./row-validator').readQuantity(cells[mappings.quantity]);if(cells[mappings.code]&&cells[mappings.name]&&quantity.ok&&quantity.value!==null)physicalUnits+=quantity.value;
 }
 const included=new Set(tables.map(table=>table.index));
 return {sheet:{name:'Combined product tables',columns,rows},mappings,axisNames:tables[0].proposal.axisNames,variantColumns:[],provenanceIndex,problemsIndex,aiUsed:false,
  contract:{kind:'independent_tables',sources:tables.map(table=>({sheet:table.index,columns:table.sheet.columns,mappings:table.proposal.mappings,axisNames:table.proposal.axisNames}))},
  coverage:workbook.sheets.map((sheet,index)=>({sheet:index,name:sheet.name,rows:sheet.rows.length,role:included.has(index)?'inventory':'not_imported',combined:included.has(index),reason:included.has(index)?'Independent product table with compatible fields and distinct SKUs.':'Empty worksheet.'})),
  sourceRows:rows.length,outputRows:rows.length,physicalUnits,issues:[],issueCount:0,reconciliations:['Combined '+tables.length+' independent product tables after checking their field meanings, monetary units and distinct SKUs.']};
}
module.exports={combine};
