'use strict';
const readySql=`SELECT coalesce((SELECT initialized FROM stockchief_runtime.movement_bucket_state WHERE workspace_id=$1),false) AS ready`;
// Minute boundaries cover current business time zones, including 30/45-minute
// offsets. Historical zones with second offsets retain the exact raw fallback.
function rangeSource(start,end){
 const usable=`(SELECT ready FROM movement_bucket_ready) AND date_bin('1 minute',${start},'2000-01-01 00:00:00+00'::timestamptz)=${start} AND date_bin('1 minute',${end},'2000-01-01 00:00:00+00'::timestamptz)=${end}`;
 return `SELECT b.quantity_delta FROM stockchief_runtime.movement_buckets b WHERE b.workspace_id=$1 AND b.bucket_at>=${start} AND b.bucket_at<${end} AND (${usable})
 UNION ALL SELECT p.quantity_delta FROM stockchief_runtime.movement_bucket_pending p WHERE p.workspace_id=$1 AND p.bucket_at>=${start} AND p.bucket_at<${end} AND (${usable})
 UNION ALL SELECT m.quantity_delta FROM movements m WHERE m.workspace_id=$1 AND stockchief_movement_instant(m.occurred_at)>=${start} AND stockchief_movement_instant(m.occurred_at)<${end} AND NOT(${usable})`;
}
async function refreshBatch(db,workspaceId,{beforePublish}={}){
 return db.transaction(async c=>{
  const ready=(await c.query('SELECT initialized FROM stockchief_runtime.movement_bucket_state WHERE workspace_id=$1',[workspaceId])).rows[0]?.initialized;
  if(!ready){
   const snapshot=(await c.query('SELECT pg_current_snapshot()::text snapshot')).rows[0].snapshot;
   await c.query('INSERT INTO stockchief_runtime.movement_bucket_state(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspaceId]);
   await c.query('DELETE FROM stockchief_runtime.movement_buckets WHERE workspace_id=$1',[workspaceId]);
   await c.query(`INSERT INTO stockchief_runtime.movement_buckets(workspace_id,bucket_at,quantity_delta)
    WITH instants AS MATERIALIZED(SELECT occurred_at,sum(quantity_delta) quantity_delta FROM movements m WHERE workspace_id=$1 GROUP BY occurred_at)
    SELECT $1,date_bin('1 minute',stockchief_movement_instant(occurred_at),'2000-01-01 00:00:00+00'::timestamptz),sum(quantity_delta)
    FROM instants WHERE stockchief_movement_instant(occurred_at) IS NOT NULL GROUP BY 1,2`,[workspaceId]);
   await beforePublish?.();
   await c.query('DELETE FROM stockchief_runtime.movement_bucket_pending WHERE workspace_id=$1 AND pg_visible_in_snapshot(change_xid,$2::pg_snapshot)',[workspaceId,snapshot]);
   await c.query('UPDATE stockchief_runtime.movement_bucket_state SET initialized=true WHERE workspace_id=$1',[workspaceId]);
  }else{
   await c.query(`WITH selected AS(SELECT bucket_at,change_xid FROM stockchief_runtime.movement_bucket_pending WHERE workspace_id=$1 ORDER BY change_xid,bucket_at LIMIT 5000),
    removed AS(DELETE FROM stockchief_runtime.movement_bucket_pending p USING selected s WHERE p.workspace_id=$1 AND p.bucket_at=s.bucket_at AND p.change_xid=s.change_xid RETURNING p.bucket_at,p.quantity_delta)
    INSERT INTO stockchief_runtime.movement_buckets(workspace_id,bucket_at,quantity_delta)
    SELECT $1,bucket_at,sum(quantity_delta) FROM removed GROUP BY bucket_at
    ON CONFLICT(workspace_id,bucket_at) DO UPDATE SET quantity_delta=stockchief_runtime.movement_buckets.quantity_delta+EXCLUDED.quantity_delta`,[workspaceId]);
   await beforePublish?.();
  }
  const pending=(await c.query('SELECT 1 FROM stockchief_runtime.movement_bucket_pending WHERE workspace_id=$1 LIMIT 1',[workspaceId])).rows.length;
  return {initialized:true,done:!pending};
 },{isolation:'REPEATABLE READ',retrySafe:!beforePublish,statementTimeoutMs:30000,lockTimeoutMs:1000,jit:false});
}
async function refresh(db,workspaceId){return db.withSessionLock('movement-buckets:'+workspaceId,async session=>{
 for(const deadline=Date.now()+10000;Date.now()<deadline;){const result=await refreshBatch(session,workspaceId);if(result.done)return result;}return {initialized:true,done:false};
});}
async function schedule(db,{now=Date.now()}={}){
 const rows=(await db.query(`SELECT w.id FROM workspaces w LEFT JOIN stockchief_runtime.movement_bucket_state s ON s.workspace_id=w.id
  LEFT JOIN LATERAL(SELECT change_xid FROM stockchief_runtime.movement_bucket_pending WHERE workspace_id=w.id ORDER BY change_xid,bucket_at LIMIT 1) p ON true
  WHERE w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
  AND (NOT coalesce(s.initialized,false) AND (SELECT m.seq FROM movements m WHERE m.workspace_id=w.id ORDER BY m.occurred_at DESC,m.seq DESC LIMIT 1) IS NOT NULL OR p.change_xid IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM import_executions e WHERE e.workspace_id=w.id AND e.status='EXECUTING')
  AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=w.id AND j.kind='inventory.refresh-movement-buckets' AND j.status IN('PENDING','RUNNING','RETRY'))
  ORDER BY coalesce(s.initialized,false),p.change_xid,w.id LIMIT 5`)).rows;
 for(const row of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId:row.id,kind:'inventory.refresh-movement-buckets',idempotencyKey:'movement-buckets:'+Math.floor(now/30000),priority:80,maxAttempts:5,now});return rows.length;
}
module.exports={readySql,rangeSource,refreshBatch,refresh,schedule};
