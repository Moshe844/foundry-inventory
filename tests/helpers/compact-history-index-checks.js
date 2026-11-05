'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 const specs=[['idx_accounting_cost_movements_sku','accounting_inventory_cost_movements','workspace_id,sku_id,created_at,id'],['idx_movements_workspace_sku_location_time','movements','workspace_id,sku_id,location_id,occurred_at DESC,id']],indexes=[];
 for(const [name,table,columns]of specs){const wide='qualification_wide_'+name,control=(await db.query('SELECT count(*)::int rows FROM '+table+' WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].rows;assert(control>=3000);
  // Compare equally packed indexes, rather than comparing a freshly sorted
  // wide index against the fixture's randomly inserted compact index.
  try{await db.query('REINDEX INDEX '+name);await db.query('CREATE INDEX '+wide+' ON '+table+' ('+columns+')');const sizes=(await db.query('SELECT pg_relation_size($1::regclass)::text compact,pg_relation_size($2::regclass)::text wide',[name,wide])).rows[0];assert(Number(sizes.compact)<Number(sizes.wide)*.9,'History prefixes must use at least ten percent less index storage while preserving every row: '+JSON.stringify({name,...sizes}));indexes.push({name,rows:control,compactBytes:Number(sizes.compact),wideBytes:Number(sizes.wide)});}
  finally{await db.query('DROP INDEX IF EXISTS '+wide);}
 }
 const ids=(await db.query("SELECT s.id FROM skus s JOIN accounting_inventory_cost_movements c ON c.workspace_id=s.workspace_id AND c.sku_id=s.id WHERE s.workspace_id=$1 AND s.code LIKE 'R17-%' GROUP BY s.id HAVING count(*)>1 ORDER BY s.id LIMIT 1",[ctx.workspaceId])).rows.map(r=>r.id);assert.equal(ids.length,1);
 const all=(await db.query('SELECT id FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND sku_id=$2 ORDER BY created_at,id',[ctx.workspaceId,ids[0]])).rows.map(r=>r.id),pages=[];for(let offset=0;offset<all.length;offset+=2)pages.push(...(await db.query('SELECT id FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND sku_id=$2 ORDER BY created_at,id LIMIT 2 OFFSET $3',[ctx.workspaceId,ids[0],offset])).rows.map(r=>r.id));assert.deepEqual(pages,all,'Equal-timestamp history pages must keep the stable id tie-breaker');
 return {compactHistoryPrefixes:true,historyRowsPreserved:true,stableTimestampPages:true,indexes,paidCalls:0};
}
module.exports={check};
