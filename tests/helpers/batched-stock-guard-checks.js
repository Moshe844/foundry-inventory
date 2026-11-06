'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 let proof;try{await db.transaction(async c=>{
  const rows=(await c.query('SELECT sku_id,location_id,on_hand::text quantity FROM balances WHERE workspace_id=$1 ORDER BY location_id,sku_id LIMIT 2000',[ctx.workspaceId])).rows;assert.equal(rows.length,2000);
  const payload=JSON.stringify(rows),locations=[...new Set(rows.map(r=>r.location_id))],skus=rows.map(r=>r.sku_id);
  for(let n=0;n<2;n++)await c.query(`UPDATE balances b SET on_hand=b.on_hand FROM jsonb_to_recordset($2::jsonb)x(sku_id text,location_id text)
   WHERE b.workspace_id=$1 AND b.location_id=ANY($3::text[]) AND b.sku_id=ANY($4::text[]) AND b.sku_id=x.sku_id AND b.location_id=x.location_id`,[ctx.workspaceId,payload,locations,skus]);
  const queued=(await c.query('SELECT count(*)::int n FROM stockchief_runtime.measured_check_transactions WHERE transaction_id=pg_current_xact_id()')).rows[0].n,keys=(await c.query('SELECT count(*)::int n FROM pg_temp.stockchief_measured_positions')).rows[0].n;assert.equal(queued,1);assert.equal(keys,2000);
  const triggers=(await c.query(`SELECT p.proname,(g.tgtype & 1)=1 AS row_trigger FROM pg_trigger g JOIN pg_proc p ON p.oid=g.tgfoid WHERE NOT g.tgisinternal
   AND p.proname IN('stockchief_search_items_batch','stockchief_search_skus_batch','stockchief_search_supplier_items_batch','stockchief_sku_rollup_batch','stockchief_collect_secondary_positions')`)).rows;
  assert.equal(triggers.length,14);assert(triggers.every(g=>!g.row_trigger));
  proof={stockGuardPositions:2000,repeatedBalanceStatements:2,deferredChecksQueued:queued,deduplicatedPositions:keys,statementProjectionTriggers:12,secondaryStatementTriggers:2,sourceRowsChanged:0,paidCalls:0};
  throw Object.assign(Error('Rollback batched guard fixture'),{qualificationRollback:true});
 },{isolation:'READ COMMITTED'});}catch(e){if(!e.qualificationRollback)throw e;}
 assert(proof);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.measured_check_transactions')).rows[0].n,0);return proof;
}
module.exports={check};
