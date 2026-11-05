'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 const tables=['balances','accounting_inventory_cost_balances'],controls=[];
 for(const table of tables){const column=table==='balances'?'on_hand':'total_cost_minor',control=(await db.query(`SELECT count(*)::int positions,sum(${column})::text total FROM ${table} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];assert(control.positions>=10000);await db.query('VACUUM (ANALYZE) '+table);controls.push({table,column,...control});}
 const started=(await db.query('SELECT clock_timestamp()::text at')).rows[0].at;
 for(const c of controls){const changed=Math.max(500,Math.ceil(c.positions*.03));await db.query(`UPDATE ${c.table} b SET updated_at=b.updated_at FROM(SELECT sku_id,location_id FROM ${c.table} WHERE workspace_id=$1 ORDER BY sku_id,location_id LIMIT $2) p WHERE b.workspace_id=$1 AND b.sku_id=p.sku_id AND b.location_id=p.location_id`,[ctx.workspaceId,changed]);c.updatedPositions=changed;}
 const begin=performance.now();let actual;
 for(;;){await db.query('SELECT pg_stat_clear_snapshot()');actual=(await db.query('SELECT s.relname,s.last_autovacuum,c.relpages,c.relallvisible FROM pg_stat_user_tables s JOIN pg_class c ON c.oid=s.relid WHERE s.relname=ANY($1::text[])',[tables])).rows;if(actual.length===2&&actual.every(r=>r.last_autovacuum&&new Date(r.last_autovacuum)>=new Date(started)&&r.relallvisible>=r.relpages*.98))break;assert(performance.now()-begin<100000,'Automatic maintenance must restore covered stock reads after a 3–5% update, without a manual vacuum');await new Promise(resolve=>setTimeout(resolve,1000));}
 for(const c of controls){const after=(await db.query(`SELECT count(*)::int positions,sum(${c.column})::text total FROM ${c.table} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];assert.equal(after.positions,c.positions);assert.equal(after.total,c.total);}
 return {stockPositions:controls[0].positions,modestUpdates:controls[0].updatedPositions,automaticVisibilityRestored:true,stockAndCostUnchanged:true,maintenanceMs:performance.now()-begin,tables:actual,paidCalls:0};
}
module.exports={check};
