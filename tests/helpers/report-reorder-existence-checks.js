'use strict';
const assert=require('node:assert/strict'),reports=require('../../src/reports/business-reports');
// Run in the caller's rollback boundary so the large qualification catalogue
// and its original reorder policies remain unchanged for later scenarios.
async function check(c,ctx){
 await c.query('DELETE FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId]);
 const counters=async()=> (await c.query("SELECT coalesce(sum(seq_tup_read+idx_tup_fetch),0)::text n FROM pg_stat_xact_user_tables WHERE relname IN('items','skus')")).rows[0].n;
 const before=await counters();assert.equal(await reports.hasReorderLevels(c,ctx),false);assert.equal(await counters(),before,'No reorder policies must mean no catalogue probes, regardless of catalogue size');
 const row=(await c.query('SELECT s.id,s.item_id FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 LIMIT 1',[ctx.workspaceId])).rows[0];assert(row);
 const location=(await c.query('SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1 LIMIT 1',[ctx.workspaceId])).rows[0];assert(location);
 await c.query("INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at) VALUES('bounded-report-policy',$1,$2,$3,1,2,'manual',now(),now())",[ctx.workspaceId,row.id,location.id]);
 assert.equal(await reports.hasReorderLevels(c,ctx),true);
 await c.query('UPDATE skus SET is_active=0 WHERE id=$1',[row.id]);assert.equal(await reports.hasReorderLevels(c,ctx),false);await c.query('UPDATE skus SET is_active=1 WHERE id=$1',[row.id]);
 await c.query('UPDATE items SET is_active=0 WHERE id=$1',[row.item_id]);assert.equal(await reports.hasReorderLevels(c,ctx),false);await c.query('UPDATE items SET is_active=1 WHERE id=$1',[row.item_id]);
 await c.query('UPDATE locations SET is_active=0 WHERE id=$1',[location.id]);assert.equal(await reports.hasReorderLevels(c,ctx),false);
 await c.query("UPDATE reorder_policies SET location_id=NULL WHERE id='bounded-report-policy'");assert.equal(await reports.hasReorderLevels(c,ctx),true,'A workspace-wide rule does not require an active warehouse');
 assert.equal(await reports.hasReorderLevels(c,{workspaceId:'another-workspace'}),false);
 return {emptyPoliciesCatalogueReads:0,archivedSkuExcluded:true,archivedProductExcluded:true,inactiveLocationExcluded:true,globalRuleIncluded:true,foreignScopeExcluded:true};
}
module.exports={check};
