'use strict';const assert=require('node:assert/strict');
async function check(database,ctx){
 await require('../../src/purchasing/postgres-replenishment-cycle').lockStorageOwner(database,ctx.workspaceId);
 await database.query(`INSERT INTO work_items(id,workspace_id,category,source,recommended_action,execution_status,priority,idempotency_key,created_at)
  SELECT 'expiry-scale-'||s.id,$1,'replenishment_plan','postgres_autopilot',jsonb_build_object('skuId',s.id,'type','purchase','quantity',1)::text,
   'WAITING_FOR_APPROVAL',88,'expiry-scale-key-'||s.id,now() FROM skus s WHERE s.workspace_id=$1 ORDER BY s.id`,[ctx.workspaceId]);
 const ids=(await database.query('SELECT id FROM skus WHERE workspace_id=$1 ORDER BY id LIMIT 2000',[ctx.workspaceId])).rows.map(s=>s.id);assert.equal(ids.length,2000);
 const at=performance.now();await database.query("SELECT stockchief_expire_replenishment($1::jsonb,'stock_changed')",[JSON.stringify(ids.map(sku_id=>({workspace_id:ctx.workspaceId,sku_id})))]);
 const elapsedMs=Math.round(performance.now()-at);
 const states=(await database.query(`SELECT execution_status,count(*)::int n FROM work_items WHERE workspace_id=$1 AND id LIKE 'expiry-scale-%' GROUP BY execution_status ORDER BY execution_status`,[ctx.workspaceId])).rows;
 assert.deepEqual(states,[{execution_status:'CANCELLED',n:2000},{execution_status:'WAITING_FOR_APPROVAL',n:48000}]);
 assert.equal((await database.query("SELECT count(*)::int n FROM work_item_events WHERE workspace_id=$1 AND event='source_changed' AND work_item_id LIKE 'expiry-scale-%'",[ctx.workspaceId])).rows[0].n,2000);
 assert(elapsedMs<3000,'Expiring the affected 2,000 decisions exceeded its bounded batch budget: '+elapsedMs);
 await database.query("SELECT stockchief_expire_replenishment($1::jsonb,'stock_changed')",[JSON.stringify(ids.map(sku_id=>({workspace_id:ctx.workspaceId,sku_id})))]);
 assert.equal((await database.query("SELECT count(*)::int n FROM work_item_events WHERE workspace_id=$1 AND event='source_changed' AND work_item_id LIKE 'expiry-scale-%'",[ctx.workspaceId])).rows[0].n,2000,'A second stock change must not duplicate cancellation history');
 return {affected:2000,unaffected:48000,elapsedMs};
}module.exports={check};
