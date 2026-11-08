'use strict';
const ledger=require('../accounting/postgres-ledger'),{createHash}=require('node:crypto');
// Large quantity and lot receipts share a balanced journal header, retaining
// an exact asset line, movement and source row for every receipt. Lot identity
// remains on the canonical stock movement. Counts/serials/measured receipts
// retain their individual posting contract.
async function post(client,ctx,plan,values,options={}){
 const valued=values.filter(v=>v.totalCostMinor>0),groups=[],ordinary=[];
 const canBatch=plan.recordsValid>=5000&&plan.transformations.importMode!=='set';
 function individual(v){return {values:[v],input:{postingDate:v.postingDate,sourceKey:`import:${plan.id}:row:${v.row.id}:opening-value`,sourceType:v.count?'import_stock_count':'opening_inventory',sourceRecordType:'import_row',sourceRecordId:v.row.id,
  description:`Opening inventory from ${plan.sourceName}, row ${v.row.rowNumber}`,currency:v.row.parsed.currency,
  lines:[{accountKey:'INVENTORY_ASSET',debitMinor:v.totalCostMinor,skuId:v.skuId,locationId:v.row.parsed.locationId},{accountKey:v.count&&!v.opening?'INVENTORY_ADJUSTMENTS':'OPENING_BALANCE_EQUITY',creditMinor:v.totalCostMinor}]}};}
 for(const v of valued){if(canBatch&&!v.count&&['quantity','lot'].includes(v.row.parsed.trackingMode)&&!v.row.parsed.secondaryUnitLabel&&Number.isSafeInteger(v.row.parsed.quantity))ordinary.push(v);else groups.push(individual(v));}
 const compatible=new Map();for(const v of ordinary){const key=JSON.stringify([v.postingDate,v.row.parsed.currency]);if(!compatible.has(key))compatible.set(key,[]);compatible.get(key).push(v);}
 for(const rows of compatible.values()){
  const total=rows.reduce((n,v)=>n+v.totalCostMinor,0);if(!Number.isSafeInteger(total)){groups.push(...rows.map(individual));continue;}
  const hash=createHash('sha256').update(JSON.stringify(rows.map(v=>v.row.id))).digest('hex'),first=rows[0];
  groups.push({values:rows,input:{postingDate:first.postingDate,sourceKey:`import:${plan.id}:batch:${hash}:opening-value`,sourceType:'opening_inventory',sourceRecordType:'import_batch',sourceRecordId:plan.id,
   description:`Stock received from ${plan.sourceName} (${rows.length} source rows)`,currency:first.row.parsed.currency,
   metadata:{importId:plan.id,integrityHash:plan.integrityHash,importRows:rows.length,sourceRowsHash:hash},
   lines:[...rows.map(v=>({accountKey:'INVENTORY_ASSET',debitMinor:v.totalCostMinor,skuId:v.skuId,locationId:v.row.parsed.locationId,metadata:{importId:plan.id,importRowId:v.row.id,sourceRow:v.row.rowNumber,movementId:v.movementId,...(v.row.parsed.lotCode?{lotCode:v.row.parsed.lotCode}:{})}})),{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:total}]}});
 }
 const posted=await ledger.postManyInTransaction(client,ctx,groups.map(g=>g.input),options),byRow=new Map();groups.forEach((g,i)=>{for(const v of g.values)byRow.set(v.row.id,posted[i].entry.id);});return byRow;
}
module.exports={post};
