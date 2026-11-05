'use strict';
// One bounded existence check on a cache miss, never a revision scan on every
// cached read. A dirty or uninitialized workspace reads canonical balances.
function source(){return `WITH cost_summary_state AS MATERIALIZED(
 SELECT EXISTS(SELECT 1 FROM stockchief_runtime.sku_cost_pending WHERE workspace_id=$1 LIMIT 1) AS dirty
) SELECT sku_id,quantity_units,total_cost_minor FROM stockchief_runtime.sku_cost_totals
 WHERE workspace_id=$1 AND NOT(SELECT dirty FROM cost_summary_state)
 UNION ALL SELECT sku_id,sum(quantity_units)::numeric AS quantity_units,sum(total_cost_minor) AS total_cost_minor
 FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND (SELECT dirty FROM cost_summary_state)
 GROUP BY sku_id`;}
async function totals(db,workspaceId){return db.query('SELECT coalesce(sum(quantity_units),0)::numeric AS units,coalesce(sum(total_cost_minor),0)::bigint AS cost FROM ('+source()+') costs',[workspaceId]);}
async function value(db,workspaceId){return (await db.query('SELECT coalesce(sum(total_cost_minor),0)::bigint AS minor FROM ('+source()+') costs',[workspaceId])).rows[0];}
async function refreshBatch(db,workspaceId,{beforePublish}={}){
 return db.transaction(async c=>{
  const snapshot=(await c.query('SELECT pg_current_snapshot()::text snapshot')).rows[0].snapshot;
  // Bound each queue read, and take the oldest changes first. Continuous
  // writes to alphabetically early SKUs must not starve the rest of a catalogue.
  const ids=(await c.query(`SELECT sku_id FROM(
   SELECT DISTINCT ON(sku_id) sku_id,change_xid FROM(
    SELECT sku_id,change_xid FROM stockchief_runtime.sku_cost_pending WHERE workspace_id=$1
    ORDER BY change_xid,sku_id LIMIT 4000) oldest
   ORDER BY sku_id,change_xid) queued ORDER BY change_xid,sku_id LIMIT 500`,[workspaceId])).rows.map(r=>r.sku_id);
  if(!ids.length)return {done:true,refreshed:0,cleared:0};
  await c.query(`INSERT INTO stockchief_runtime.sku_cost_totals(workspace_id,sku_id,quantity_units,total_cost_minor)
   SELECT workspace_id,sku_id,sum(quantity_units),sum(total_cost_minor) FROM accounting_inventory_cost_balances
   WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) GROUP BY workspace_id,sku_id
   ON CONFLICT(workspace_id,sku_id) DO UPDATE SET quantity_units=EXCLUDED.quantity_units,total_cost_minor=EXCLUDED.total_cost_minor`,[workspaceId,ids]);
  await c.query(`DELETE FROM stockchief_runtime.sku_cost_totals s WHERE s.workspace_id=$1 AND s.sku_id=ANY($2::text[])
   AND NOT EXISTS(SELECT 1 FROM accounting_inventory_cost_balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.sku_id)`,[workspaceId,ids]);
  await beforePublish?.();
  const cleared=await c.query(`WITH selected AS(SELECT sku_id,change_xid FROM stockchief_runtime.sku_cost_pending
   WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND pg_visible_in_snapshot(change_xid,$3::pg_snapshot)
   ORDER BY sku_id,change_xid LIMIT 10000)
   DELETE FROM stockchief_runtime.sku_cost_pending p USING selected s WHERE p.workspace_id=$1 AND p.sku_id=s.sku_id AND p.change_xid=s.change_xid`,[workspaceId,ids,snapshot]);
  const remaining=(await c.query('SELECT 1 FROM stockchief_runtime.sku_cost_pending WHERE workspace_id=$1 LIMIT 1',[workspaceId])).rows.length;
  return {done:!remaining,refreshed:ids.length,cleared:cleared.rowCount};
 },{isolation:'REPEATABLE READ',retrySafe:!beforePublish,statementTimeoutMs:5000,lockTimeoutMs:500,jit:false});
}
async function refresh(db,workspaceId,options={}){
 return db.withSessionLock('sku-cost-summary:'+workspaceId,async session=>{
  let refreshed=0,cleared=0;for(const deadline=Date.now()+10000;Date.now()<deadline;){const result=await refreshBatch(session,workspaceId,options);refreshed+=result.refreshed;cleared+=result.cleared;if(result.done)return {done:true,refreshed,cleared};}
  return {done:false,refreshed,cleared};
 });
}
async function schedule(db,{now=Date.now()}={}){
 const rows=(await db.query(`SELECT w.id,p.sku_id,p.change_xid::text FROM workspaces w
  CROSS JOIN LATERAL(SELECT sku_id,change_xid FROM stockchief_runtime.sku_cost_pending WHERE workspace_id=w.id ORDER BY change_xid,sku_id LIMIT 1)p
  WHERE w.deletion_requested_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM import_executions e WHERE e.workspace_id=w.id AND e.status='EXECUTING')
  AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=w.id AND j.kind='inventory.refresh-cost-summary' AND j.status IN('PENDING','RUNNING','RETRY'))
  ORDER BY p.change_xid,w.id LIMIT 5`)).rows;
 // A bounded run can leave the same first pending key behind. A new time
 // bucket permits its continuation instead of resolving forever to a completed
 // job. Concurrent scheduler passes in the same bucket remain idempotent.
 for(const row of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId:row.id,kind:'inventory.refresh-cost-summary',idempotencyKey:'sku-cost:'+row.sku_id+':'+row.change_xid+':'+Math.floor(now/30000),priority:80,maxAttempts:5,now});
 return rows.length;
}
module.exports={source,totals,value,refreshBatch,refresh,schedule};
