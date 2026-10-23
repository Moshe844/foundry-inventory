'use strict';
const jobs=require('../operations/postgres-job-queue'),{nowIso}=require('../lib/util');
const wrap=client=>({query:(...args)=>client.query(...args),transaction:operation=>operation(client)});
async function schedule(client,{now=Date.now()}={}){
 const at=new Date(now).toISOString();
 await client.query(`INSERT INTO shipping_tracking_checks(workspace_id,shipment_id,next_check_at)
   SELECT s.workspace_id,s.id,$1 FROM sales_shipments s JOIN workspaces w ON w.id=s.workspace_id
   WHERE w.deletion_requested_at IS NULL AND s.label_status='PURCHASED' AND s.tracking_number IS NOT NULL
    AND s.provider IN ('easypost','shipstation','shippo') AND s.status NOT IN ('CANCELLED','DELIVERED')
   ON CONFLICT DO NOTHING`,[at]);
 const due=(await client.query(`SELECT c.*,s.provider FROM shipping_tracking_checks c JOIN sales_shipments s
   ON s.workspace_id=c.workspace_id AND s.id=c.shipment_id JOIN workspaces w ON w.id=s.workspace_id
   WHERE c.next_check_at<=$1 AND s.label_status='PURCHASED' AND s.status NOT IN ('DELIVERED','CANCELLED')
   AND s.tracking_status NOT IN ('DELIVERED','CANCELLED') AND w.deletion_requested_at IS NULL
   ORDER BY c.next_check_at,c.shipment_id LIMIT 100 FOR UPDATE OF c SKIP LOCKED`,[at])).rows;
 for(const row of due){
  await jobs.enqueue(wrap(client),{workspaceId:row.workspace_id,kind:'shipping.tracking.check',idempotencyKey:row.shipment_id+':'+row.next_check_at,
   payload:{shipmentId:row.shipment_id},priority:90,maxAttempts:4});
  await client.query('UPDATE shipping_tracking_checks SET next_check_at=$3 WHERE workspace_id=$1 AND shipment_id=$2',
   [row.workspace_id,row.shipment_id,new Date(now+15*60000).toISOString()]);
 }return {queued:due.length};
}
async function check(database,job,options={}){
 const shipping=require('./postgres-service'),shipment=await shipping.requireShipment(database,job.workspaceId,job.payload.shipmentId);
 if(shipment.label_status!=='PURCHASED'||['DELIVERED','CANCELLED'].includes(shipment.status))return {skipped:true};
 try{
  const provider=options.providerResolver?options.providerResolver(shipment.provider):require('./provider').get(shipment.provider);
  const result=await shipping.refreshTracking(database,{workspaceId:job.workspaceId,actorId:shipment.created_by_user_id},shipment.id,{provider,essential:true,idempotencyKey:job.id});
  await database.query('UPDATE shipping_tracking_checks SET last_checked_at=$3,last_error=NULL,failures=0 WHERE workspace_id=$1 AND shipment_id=$2',[job.workspaceId,shipment.id,nowIso()]);return result;
 }catch(error){
  // Provider responses may contain account data. Persist only a controlled explanation.
  await database.query("UPDATE shipping_tracking_checks SET last_checked_at=$3,last_error='The carrier could not be checked. StockChief will retry automatically; reconnect the original account if this persists.',failures=failures+1 WHERE workspace_id=$1 AND shipment_id=$2",[job.workspaceId,shipment.id,nowIso()]);
  const retry=new Error('The saved carrier tracking could not be checked.');retry.retryable=error.retryable!==false;throw retry;
 }
}
module.exports={schedule,check};
