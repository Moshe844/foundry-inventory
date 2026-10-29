'use strict';
const {ValidationError,InvariantError}=require('../domain/errors');

// Call within the same transaction as the inventory effect. A checkpoint never
// advances unless that effect and its receipt commit together.
async function admitSnapshot(client,auth,event,skuId,locationId,quantity){
 const rawVersion=event.version;
 const version=rawVersion==null?null:String(rawVersion);
 if(version!==null&&!/^\d{1,40}$/.test(version))throw new ValidationError('Absolute stock snapshots require a monotonic non-negative integer version, or a source timestamp without an opaque version.');
 const time=event.occurredAt?new Date(event.occurredAt):null;
 if(time&&!Number.isFinite(time.valueOf()))throw new ValidationError('The stock snapshot source timestamp is invalid.');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
  JSON.stringify(['source-position',auth.workspaceId,auth.connectorId,skuId,locationId])]);
 const prior=(await client.query(`SELECT * FROM stockchief_runtime.inventory_source_checkpoints
  WHERE workspace_id=$1 AND connector_id=$2 AND sku_id=$3 AND location_id=$4 FOR UPDATE`,
 [auth.workspaceId,auth.connectorId,skuId,locationId])).rows[0];
 // Even the first physical count needs ordering evidence: its delayed retry
 // must not replace a newer count delivered through a different event id.
 if(version===null&&!time){
  if(prior)throw new ValidationError('This source position is versioned. Include its source version or timestamp.');
  throw new ValidationError('Absolute stock snapshots require a source version or timestamp so delayed deliveries cannot overwrite newer stock.');
 }
 if(prior){
  if((prior.source_version!==null)!==(version!==null))throw new ValidationError('The source ordering method cannot change within a stock position.');
  const order=version!==null?(BigInt(version)>BigInt(prior.source_version)?1:BigInt(version)<BigInt(prior.source_version)?-1:0)
   :Math.sign(time.valueOf()-new Date(prior.source_time).valueOf());
  if(order<=0){
   if(order===0&&Number(prior.counted_quantity)!==quantity)throw new InvariantError('The same source position version has conflicting quantities.','source_version_conflict');
   return {stale:true};
  }
 }
 await client.query(`INSERT INTO stockchief_runtime.inventory_source_checkpoints
  (workspace_id,connector_id,sku_id,location_id,source_version,source_time,event_id,counted_quantity)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,connector_id,sku_id,location_id)
  DO UPDATE SET source_version=EXCLUDED.source_version,source_time=EXCLUDED.source_time,
    event_id=EXCLUDED.event_id,counted_quantity=EXCLUDED.counted_quantity,updated_at=now()`,
 [auth.workspaceId,auth.connectorId,skuId,locationId,version,time?.toISOString()||null,event.eventId,quantity]);
 return {stale:false};
}
module.exports={admitSnapshot};
