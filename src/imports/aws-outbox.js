'use strict';

async function publish(db,transport) {
  return db.transaction(async client=>{
    const rows=(await client.query(`SELECT o.job_id FROM stockchief_runtime.import_transport_outbox o
      ORDER BY o.created_at,o.job_id LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
    const deadline=performance.now()+1000;
    for(const row of rows){
      if(performance.now()>=deadline)break;
      await transport.notify(row.job_id);
      await client.query('DELETE FROM stockchief_runtime.import_transport_outbox WHERE job_id=$1',[row.job_id]);
    }
    return rows.length;
  },{isolation:'READ COMMITTED',statementTimeoutMs:10000});
}

function start(db,transport,{onError=()=>{},intervalMs=1000}={}){
  let stopped=false,timer,pending,nextCleanup=0;
  const tick=async()=>{
    if(stopped)return;
    pending=(async()=>{
      if(Date.now()>=nextCleanup){await cleanupExpired(db);nextCleanup=Date.now()+60000;}
      return publish(db,transport);
    })();
    try{await pending;}catch(error){onError(error);}
    finally{pending=null;if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref();}}
  };
  tick();
  return {async stop(){stopped=true;clearTimeout(timer);await pending?.catch(()=>{});}};
}
async function cleanupExpired(db){
 return db.query(`WITH expired AS MATERIALIZED (
   SELECT e.id,e.workspace_id FROM import_external_uploads e WHERE e.expires_at<=now()
   AND NOT EXISTS(SELECT 1 FROM import_source_uploads u JOIN stockchief_runtime.jobs j ON j.id=u.job_id
     WHERE u.id=e.id AND u.workspace_id=e.workspace_id AND j.status='RUNNING'
       AND j.lease_expires_at>floor(extract(epoch FROM statement_timestamp())*1000))
   ORDER BY e.expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
 ), released AS (
   DELETE FROM commercial_storage_reservations r USING expired e
   WHERE r.workspace_id=e.workspace_id AND r.reservation_key='upload:'||e.id
     AND NOT EXISTS(SELECT 1 FROM import_source_uploads u WHERE u.id=e.id AND u.workspace_id=e.workspace_id AND u.plan_id IS NOT NULL)
 ) DELETE FROM import_external_uploads e USING expired x WHERE e.id=x.id AND e.workspace_id=x.workspace_id`);
}
module.exports={publish,start,cleanupExpired};
