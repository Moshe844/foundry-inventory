'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 const sources=[['balances','on_hand','updated_at','sku_id,location_id'],['accounting_inventory_cost_balances','total_cost_minor','updated_at','sku_id,location_id'],['inventory_cost_coverage_positions','missing_units','physical_units','sku_id,location_id'],['movements','quantity_delta','notes','id']],tables=sources.map(s=>s[0]),controls=[];
 for(const [table,column,write,keys]of sources){const control=(await db.query(`SELECT count(*)::int positions,sum(${column})::text total FROM ${table} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];assert(control.positions>=10000);await db.query('VACUUM (ANALYZE) '+table);controls.push({table,column,write,keys,...control});}
 const started=(await db.query('SELECT clock_timestamp()::text at')).rows[0].at;
 for(const c of controls){const changed=Math.max(500,Math.ceil(c.positions*.03));c.updatedPositions=changed;
  if(c.table==='movements'){
   // Movement history is immutable. Exercise its append maintenance using
   // canonical receipts into existing ordinary positions, never UPDATE it.
   const positions=(await db.query(`SELECT b.sku_id,b.location_id FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id WHERE b.workspace_id=$1 AND i.tracking_mode='quantity' AND i.secondary_unit_label IS NULL AND s.is_active=1 AND i.is_active=1 ORDER BY b.sku_id,b.location_id LIMIT $2`,[ctx.workspaceId,changed])).rows;assert.equal(positions.length,changed);
   for(let start=0;start<positions.length;start+=1000)await db.transaction(client=>require('../../src/domain/postgres-inventory-engine').receiveManyInTransaction(client,ctx,positions.slice(start,start+1000).map(p=>({skuId:p.sku_id,locationId:p.location_id,quantity:1,idempotencyKey:'visibility-append:'+p.sku_id+':'+p.location_id}))));
   c.positions+=changed;for(const control of controls.filter(v=>['balances','inventory_cost_coverage_positions','movements'].includes(v.table)))control.total=require('../../src/domain/exact-quantity').add(control.total,changed);
  }else{const join=c.keys.split(',').map(k=>`b.${k}=p.${k}`).join(' AND ');await db.query(`UPDATE ${c.table} b SET ${c.write}=b.${c.write} FROM(SELECT ${c.keys} FROM ${c.table} WHERE workspace_id=$1 ORDER BY ${c.keys} LIMIT $2) p WHERE b.workspace_id=$1 AND ${join}`,[ctx.workspaceId,changed]);}
 }
 const begin=performance.now();let actual;
 for(;;){await db.query('SELECT pg_stat_clear_snapshot()');actual=(await db.query('SELECT s.relname,s.last_autovacuum,c.relpages,c.relallvisible FROM pg_stat_user_tables s JOIN pg_class c ON c.oid=s.relid WHERE s.relname=ANY($1::text[])',[tables])).rows;if(actual.length===tables.length&&actual.every(r=>r.last_autovacuum&&new Date(r.last_autovacuum)>=new Date(started)&&r.relallvisible>=r.relpages*.98))break;assert(performance.now()-begin<100000,'Automatic maintenance must restore every covered report input after a 3–5% update, without a manual vacuum');await new Promise(resolve=>setTimeout(resolve,1000));}
 for(const c of controls){const after=(await db.query(`SELECT count(*)::int positions,sum(${c.column})::text total FROM ${c.table} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];assert.equal(after.positions,c.positions);assert.equal(after.total,c.total);}
 return {stockPositions:controls[0].positions,modestUpdates:controls[0].updatedPositions,controlledReceiptUnitsAdded:controls.find(c=>c.table==='movements').updatedPositions,automaticVisibilityRestored:true,stockAndCostUnchangedByMaintenance:true,maintenanceMs:performance.now()-begin,tables:actual,paidCalls:0};
}
module.exports={check};
