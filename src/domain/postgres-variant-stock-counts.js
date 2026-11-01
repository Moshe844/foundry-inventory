'use strict';
const counts=require('../operations/postgres-count-reviews'),exact=require('./exact-quantity'),{ValidationError}=require('./errors');
async function snapshots(db,ctx,skuIds,locations){const result={};for(const location of locations){for(const row of await counts.positions(db,ctx,location.id,skuIds))result[row.id+':'+location.id]={quantity:row.physical,hash:counts.snapshotHash(row)};}return result;}
async function prepare(client,ctx,rows){
 const byLocation=new Map();let total=0;
 for(const row of rows)for(const [locationId,raw] of Object.entries(row.stock||{})){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ValidationError('Use a stock count from the current variant grid.');
  const quantity=exact.safeNumber(raw.quantity,{label:'Counted stock'}),original=exact.safeNumber(raw.originalQuantity,{label:'Original stock count'});if(quantity<0)throw new ValidationError('Counted stock cannot be negative.');if(quantity===original)continue;
  if(++total>500)throw new ValidationError('Review at most 500 stock positions in one variant batch.');if(!byLocation.has(locationId))byLocation.set(locationId,[]);byLocation.get(locationId).push({skuId:row.skuId,quantity,expectedHash:String(raw.snapshot||''),unitCost:String(row.cost??'').trim()||undefined});
 }
 const prepared=new Map(),scoped={query:(...a)=>client.query(...a),transaction:fn=>fn(client)};
 for(const [locationId,lines] of [...byLocation].sort(([a],[b])=>a.localeCompare(b))){const current=await counts.positions(client,ctx,locationId,lines.map(r=>r.skuId));for(const line of lines)if(counts.snapshotHash(current.find(r=>r.id===line.skuId))!==line.expectedHash)throw new ValidationError('Stock or cost changed while this page was open. Reload the current counts before reviewing them.');
  const created=await counts.prepare(scoped,ctx,{locationId,lines,reference:'Variant stock count'}),review=await counts.get(scoped,ctx,created.id);
  for(const line of review.payload.lines){if(!prepared.has(line.skuId))prepared.set(line.skuId,[]);prepared.get(line.skuId).push({locationId,locationName:review.payload.location.name,quantity:line.quantity,beforeQuantity:line.before.physical,costDeltaMinor:line.costDeltaMinor,currency:review.payload.currency,reviewId:review.id,integrityHash:review.integrity_hash});}
 }
 return prepared;
}
async function approve(client,ctx,changes){const reviews=new Map();for(const change of changes)for(const count of change.after.stock||[])reviews.set(count.reviewId,count.integrityHash);const scoped={query:(...a)=>client.query(...a),transaction:fn=>fn(client)};for(const [id,hash] of reviews)await counts.approve(scoped,ctx,id,hash);}
module.exports={snapshots,prepare,approve};
