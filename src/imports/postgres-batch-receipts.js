'use strict';
const {createHash}=require('node:crypto'),exact=require('../domain/exact-quantity'),{ValidationError}=require('../domain/errors');
const invalid=()=>new ValidationError('Saved import verification does not match its approved batches. The recorded stock remains safe; review the saved import.');
const signed=value=>exact.canonical(value,{signed:true});
async function record(client,ctx,plan,{offset,rows,units,costRecords,valueMinor,totals}){
 if(!Number.isSafeInteger(offset)||offset<0||!rows.length||rows.length>2000||new Set(rows.map(r=>r.id)).size!==rows.length)throw invalid();
 if(!Number.isSafeInteger(costRecords)||costRecords<0||costRecords>rows.length||!Number.isSafeInteger(valueMinor)
  ||Number(totals.value.movements)!==costRecords||signed(totals.value.value)!==signed(valueMinor)
  ||signed(totals.posted.value)!==signed(valueMinor))throw invalid();
 const sourceHash=createHash('sha256').update(JSON.stringify(rows.map(r=>r.id))).digest('hex');
 const result=await client.query(`INSERT INTO import_batch_receipts(workspace_id,import_id,start_offset,end_offset,row_count,approval_hash,source_rows_hash,quantity_delta,cost_records,value_minor,asset_minor)
 SELECT $1,$2,$3::bigint,$3::bigint+$4::int,$4::int,$5,$6,$7,$8,$9,$10 FROM import_plans p
 WHERE p.workspace_id=$1 AND p.id=$2 AND p.integrity_hash=$5 AND p.approval_status='APPROVED'
  AND coalesce((p.apply_checkpoint->>'savedRows')::bigint,0)=$3`,
 [ctx.workspaceId,plan.id,offset,rows.length,plan.integrityHash,sourceHash,signed(units),costRecords,valueMinor,totals.posted.value]);
 if(result.rowCount!==1)throw invalid();
}
async function totals(client,ctx,plan){
 const row=(await client.query(`WITH receipts AS (
  SELECT r.*,lag(end_offset,1,0::bigint) OVER(ORDER BY start_offset) AS previous_end
  FROM import_batch_receipts r WHERE workspace_id=$1 AND import_id=$2)
 SELECT count(*)::int batches,coalesce(sum(row_count),0)::text rows,
  coalesce(sum(quantity_delta),0)::text units,coalesce(sum(cost_records),0)::text cost_records,
  coalesce(sum(value_minor),0)::text value,coalesce(sum(asset_minor),0)::text asset,
  count(*) FILTER(WHERE start_offset<>previous_end OR approval_hash<>$3)::int invalid
 FROM receipts`,[ctx.workspaceId,plan.id,plan.integrityHash])).rows[0];
 if(!row||Number(row.invalid))throw invalid();
 const number=value=>exact.safeNumber(value,{signed:true});
 const result={batches:Number(row.batches),rows:number(row.rows),units:number(row.units),costRecords:number(row.cost_records),value:number(row.value),asset:number(row.asset)};
 if(result.rows!==plan.recordsValid||result.batches<1||result.value!==result.asset)throw invalid();
 return result;
}
module.exports={record,totals};
