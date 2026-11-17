'use strict';
const {workingCopy}=require('./personal-data');
const DAYS=30,BATCH=250;
async function run(database,{now=Date.now(),budgetMs=30000}={}){
 const cutoff=new Date(now-DAYS*86400000).toISOString(),deadline=Date.now()+budgetMs;
 const out={webhookPayloads:0,eventPayloads:0,privacyExports:0};
 // Keep small delivery/hash/effect receipts for idempotency. Never expire pending
 // work or source evidence still referenced by an unresolved reconciliation.
 while(Date.now()<deadline){
  const result=await database.query(`WITH expired AS (SELECT r.id FROM connection_webhook_receipts r
   WHERE r.status='COMPLETED' AND r.payload_purged_at IS NULL AND r.updated_at<$1
   AND NOT EXISTS(SELECT 1 FROM connection_issues i WHERE i.workspace_id=r.workspace_id AND i.connector_id=r.connector_id AND i.status='OPEN')
   AND NOT EXISTS(SELECT 1 FROM shopify_privacy_work p WHERE p.workspace_id=r.workspace_id AND p.connector_id=r.connector_id AND p.status<>'COMPLETED')
   ORDER BY r.updated_at,r.id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
   UPDATE connection_webhook_receipts r SET ciphertext='',iv='',auth_tag='',error_message=NULL,payload_purged_at=$2
   FROM expired e WHERE r.id=e.id RETURNING r.id`,[cutoff,new Date(now).toISOString()]);
  out.webhookPayloads+=result.rowCount;if(result.rowCount<BATCH)break;
 }
 while(Date.now()<deadline){
  const rows=(await database.query(`SELECT e.id,e.payload,e.normalized_payload FROM connector_feed_events e
   WHERE e.status='COMPLETED' AND e.personal_data_purged_at IS NULL AND e.processed_at::timestamptz<$1
   AND NOT EXISTS(SELECT 1 FROM connection_issues i WHERE i.workspace_id=e.workspace_id AND i.connector_id=e.connector_id AND i.status='OPEN')
   AND NOT EXISTS(SELECT 1 FROM shopify_privacy_work p WHERE p.workspace_id=e.workspace_id AND p.connector_id=e.connector_id AND p.status<>'COMPLETED')
   ORDER BY e.processed_at,e.id LIMIT ${BATCH}`,[cutoff])).rows;
  for(const row of rows){const parse=value=>typeof value==='string'?JSON.parse(value):value;
   await database.query(`UPDATE connector_feed_events SET payload=$2,normalized_payload=$3,error_message=NULL,personal_data_purged_at=$4
    WHERE id=$1 AND status='COMPLETED' AND personal_data_purged_at IS NULL`,[row.id,JSON.stringify(workingCopy(parse(row.payload))),JSON.stringify(workingCopy(parse(row.normalized_payload))),new Date(now).toISOString()]);out.eventPayloads++;
  }if(rows.length<BATCH)break;
 }
 out.privacyExports=(await database.query(`UPDATE shopify_privacy_work SET export_ciphertext=NULL,export_iv=NULL,export_auth_tag=NULL
  WHERE status='COMPLETED' AND completed_at<$1 AND export_ciphertext IS NOT NULL`,[cutoff])).rowCount;
 await database.query(`UPDATE shopify_privacy_requests r SET ciphertext=NULL,iv=NULL,auth_tag=NULL
  WHERE r.received_at<$1 AND r.ciphertext IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shopify_privacy_work w WHERE w.request_id=r.id AND w.status<>'COMPLETED')`,[cutoff]);
 return out;
}
module.exports={run,days:DAYS};
