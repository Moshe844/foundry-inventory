'use strict';
// Daily clean-up of working copies and logs once nobody needs them. Business
// records (stock, orders, accounts and their history) are never touched here.
//  - An import preview not approved within 14 days is cancelled, as the Cancel
//    button would, and the row copies of cancelled imports are removed after
//    14 days. Finished imports keep their rows: they recognise a file that was
//    already imported.
//  - The step-by-step events of background jobs that finished more than 30 days
//    ago. The jobs themselves stay, because other records point at them.
//  - Per-request resource measurements after 100 days (billing uses months).
// Work is done in small batches within a time budget; the next day continues.
const DAY=86_400_000,BATCH=5000;
const policy=Object.freeze({previewDays:14,cancelledImportDays:14,jobEventDays:30,measurementDays:100});
const before=(now,days)=>new Date(now-days*DAY).toISOString();

async function run(database,{now=Date.now(),budgetMs=10*60_000}={}){
 const deadline=Date.now()+budgetMs,more=()=>Date.now()<deadline;
 const out={previewsCancelled:0,importRows:0,jobEvents:0,measurements:0};

 const stale=(await database.query(`UPDATE import_plans SET status='CANCELLED',approval_status='CANCELLED'
  WHERE status='READY' AND approval_status='AWAITING_APPROVAL' AND created_at<$1 RETURNING workspace_id,id`,[before(now,policy.previewDays)])).rows;
 for(const plan of stale)await require('../commercial/storage-capacity').finish(database,plan.workspace_id,'import:'+plan.id);
 out.previewsCancelled=stale.length;

 const cancelled=(await database.query(`SELECT p.workspace_id,p.id FROM import_plans p
  WHERE p.status='CANCELLED' AND p.created_at<$1 AND EXISTS(SELECT 1 FROM import_rows r WHERE r.import_id=p.id) ORDER BY p.created_at,p.id`,[before(now,policy.cancelledImportDays)])).rows;
 for(const plan of cancelled){
  while(more()){const removed=await database.query(`DELETE FROM import_rows WHERE id=ANY(ARRAY(
    SELECT id FROM import_rows WHERE import_id=$1 AND workspace_id=$2 LIMIT ${BATCH}))`,[plan.id,plan.workspace_id]);
   out.importRows+=removed.rowCount;if(removed.rowCount<BATCH)break;}
  if(!more())break;
 }

 // Events are numbered in order, so old ones are walked by sequence windows.
 const eventsBefore=before(now,policy.jobEventDays);
 let from=(await database.query('SELECT min(seq)::text AS seq FROM stockchief_runtime.job_events')).rows[0].seq;
 while(from!==null&&more()){
  const window=(await database.query(`SELECT max(seq)::text AS last,bool_or(created_at>=$2) AS reached FROM (
    SELECT seq,created_at FROM stockchief_runtime.job_events WHERE seq>=$1::bigint ORDER BY seq LIMIT ${BATCH}) w`,[from,eventsBefore])).rows[0];
  if(window.last===null)break;
  const removed=await database.query(`DELETE FROM stockchief_runtime.job_events e USING stockchief_runtime.jobs j
   WHERE e.seq>=$1::bigint AND e.seq<=$2::bigint AND e.created_at<$3 AND j.id=e.job_id AND j.status IN ('COMPLETED','CANCELLED')`,[from,window.last,eventsBefore]);
  out.jobEvents+=removed.rowCount;if(window.reached)break;from=(BigInt(window.last)+1n).toString();
 }

 // One short index walk per resource (service) instead of reading every measurement.
 const resources=(await database.query(`WITH RECURSIVE r AS (SELECT min(resource_id) AS id FROM commercial_resource_measurements
  UNION ALL SELECT (SELECT min(resource_id) FROM commercial_resource_measurements WHERE resource_id>r.id) FROM r WHERE r.id IS NOT NULL)
  SELECT id FROM r WHERE id IS NOT NULL`)).rows.map(row=>row.id);
 for(const resource of resources){
  while(more()){const removed=await database.query(`DELETE FROM commercial_resource_measurements WHERE id=ANY(ARRAY(
    SELECT id FROM commercial_resource_measurements WHERE resource_id=$1 AND started_at<$2::timestamptz LIMIT ${BATCH}))`,[resource,before(now,policy.measurementDays)]);
   out.measurements+=removed.rowCount;if(removed.rowCount<BATCH)break;}
  if(!more())break;
 }
 return out;
}

// Once a day; the idempotency key makes every later minute of that day a no-op.
async function schedule(database,{now=Date.now()}={}){
 return require('./postgres-job-queue').enqueue(database,{kind:'system.retention',idempotencyKey:'retention:'+Math.floor(now/DAY),payload:{now},priority:200,maxAttempts:3,now});
}
module.exports={policy,run,schedule};
