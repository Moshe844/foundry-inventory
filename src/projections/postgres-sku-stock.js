'use strict';
function source(){return `WITH sku_stock_ready AS MATERIALIZED(SELECT coalesce((SELECT initialized FROM stockchief_runtime.sku_stock_state WHERE workspace_id=$1),false) ready)
 SELECT sku_id,sum(quantity)::numeric quantity FROM(
  SELECT sku_id,on_hand quantity FROM stockchief_runtime.sku_stock_totals WHERE workspace_id=$1 AND (SELECT ready FROM sku_stock_ready)
  UNION ALL SELECT sku_id,quantity_delta FROM stockchief_runtime.sku_stock_pending WHERE workspace_id=$1 AND (SELECT ready FROM sku_stock_ready)
  UNION ALL SELECT b.sku_id,b.on_hand FROM balances b WHERE b.workspace_id=$1 AND NOT(SELECT ready FROM sku_stock_ready)
 ) stock GROUP BY sku_id`;}
async function refreshBatch(db,workspaceId,{beforePublish,batchSize=5000}={}){
 if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>5000)throw new TypeError('Choose a bounded stock-summary batch.');
 return db.transaction(async c=>{
  const ready=(await c.query('SELECT initialized FROM stockchief_runtime.sku_stock_state WHERE workspace_id=$1',[workspaceId])).rows[0]?.initialized;
  if(!ready){
   const snapshot=(await c.query('SELECT pg_current_snapshot()::text snapshot')).rows[0].snapshot;
   await c.query('INSERT INTO stockchief_runtime.sku_stock_state(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspaceId]);
   await c.query('DELETE FROM stockchief_runtime.sku_stock_totals WHERE workspace_id=$1',[workspaceId]);
   await c.query('INSERT INTO stockchief_runtime.sku_stock_totals(workspace_id,sku_id,on_hand) SELECT workspace_id,sku_id,sum(on_hand) FROM balances WHERE workspace_id=$1 GROUP BY workspace_id,sku_id',[workspaceId]);
   await beforePublish?.();
   await c.query('DELETE FROM stockchief_runtime.sku_stock_pending WHERE workspace_id=$1 AND pg_visible_in_snapshot(change_xid,$2::pg_snapshot)',[workspaceId,snapshot]);
   await c.query('UPDATE stockchief_runtime.sku_stock_state SET initialized=true WHERE workspace_id=$1',[workspaceId]);
  }else{
   // Intermediate stored totals may be negative when an older transaction ID
   // commits an issue after a newer receipt. Readers always add the remaining
   // committed deltas in the same snapshot; that combined total stays exact.
   await c.query(`WITH selected AS(SELECT sku_id,change_xid FROM stockchief_runtime.sku_stock_pending WHERE workspace_id=$1 ORDER BY change_xid,sku_id LIMIT ${batchSize}),
    removed AS(DELETE FROM stockchief_runtime.sku_stock_pending p USING selected s WHERE p.workspace_id=$1 AND p.sku_id=s.sku_id AND p.change_xid=s.change_xid RETURNING p.sku_id,p.quantity_delta)
    INSERT INTO stockchief_runtime.sku_stock_totals(workspace_id,sku_id,on_hand) SELECT $1,sku_id,sum(quantity_delta) FROM removed GROUP BY sku_id
    ON CONFLICT(workspace_id,sku_id) DO UPDATE SET on_hand=stockchief_runtime.sku_stock_totals.on_hand+EXCLUDED.on_hand`,[workspaceId]);
   await beforePublish?.();
  }
  return {initialized:true,done:!(await c.query('SELECT 1 FROM stockchief_runtime.sku_stock_pending WHERE workspace_id=$1 LIMIT 1',[workspaceId])).rows.length};
 },{isolation:'REPEATABLE READ',retrySafe:!beforePublish,statementTimeoutMs:15000,lockTimeoutMs:1000,jit:false});
}
async function refresh(db,workspaceId){return db.withSessionLock('sku-stock:'+workspaceId,async session=>{for(const deadline=Date.now()+10000;Date.now()<deadline;){const result=await refreshBatch(session,workspaceId);if(result.done)return result;}return {initialized:true,done:false};});}
async function schedule(db,{now=Date.now()}={}){
 const rows=(await db.query(`SELECT w.id FROM workspaces w LEFT JOIN stockchief_runtime.sku_stock_state s ON s.workspace_id=w.id
  LEFT JOIN LATERAL(SELECT change_xid FROM stockchief_runtime.sku_stock_pending WHERE workspace_id=w.id ORDER BY change_xid,sku_id LIMIT 1)p ON true
  WHERE w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
  AND (NOT coalesce(s.initialized,false) AND (SELECT b.sku_id FROM balances b WHERE b.workspace_id=w.id ORDER BY b.sku_id,b.location_id LIMIT 1) IS NOT NULL OR p.change_xid IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM import_executions e WHERE e.workspace_id=w.id AND e.status='EXECUTING')
  AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=w.id AND j.kind='inventory.refresh-sku-stock' AND j.status IN('PENDING','RUNNING','RETRY'))
  ORDER BY coalesce(s.initialized,false),p.change_xid,w.id LIMIT 5`)).rows;
 for(const row of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId:row.id,kind:'inventory.refresh-sku-stock',idempotencyKey:'sku-stock:'+Math.floor(now/30000),priority:80,maxAttempts:5,now});return rows.length;
}
module.exports={source,refreshBatch,refresh,schedule};
