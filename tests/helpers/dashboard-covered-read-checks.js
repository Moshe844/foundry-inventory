'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 const reports=require('../../src/reports/postgres-service'),calendar=await require('../../src/lib/business-time').forWorkspace(db,ctx.workspaceId);
 let balanceQuery;const capture={query:async(sql,values)=>{if(sql.includes('WITH scoped_accounts AS MATERIALIZED'))balanceQuery={sql,values};return db.query(sql,values);}};
 const balance=await require('../../src/accounting/postgres-reports').balanceSheet(capture,ctx.workspaceId,{asOf:calendar.calendarDate});assert.equal(balance.balanced,true);assert(balanceQuery);
 const config=reports.normalize({dataset:'inventory_valuation',groups:['sku'],aggregate:'sum',measure:'book_cost_minor',filters:[{field:'currency',operator:'equals',value:balance.currency}],sort:'total',direction:'desc'},{role:'owner'}),stockQuery=reports.queryFor(config,ctx.workspaceId,{limit:14,dateContext:calendar}),plans=[];
 // An older snapshot may keep recent pages from being marked all-visible.
 // Require the covering access path and record any MVCC visibility rechecks.
 await db.query('VACUUM (ANALYZE) accounting_journal_lines');await db.query('VACUUM (ANALYZE) accounting_inventory_cost_balances');await db.query('VACUUM (ANALYZE) inventory_cost_coverage_positions');await db.query('VACUUM (ANALYZE) balances');await db.query('VACUUM (ANALYZE) skus');
 await db.transaction(async c=>{await c.query('SET LOCAL enable_seqscan=off');await c.query('SET LOCAL enable_bitmapscan=off');
  for(const [kind,q,relation,index]of [['money',balanceQuery,'accounting_journal_lines','idx_accounting_lines_account_covering'],['stock-value',stockQuery,'accounting_inventory_cost_balances','idx_inventory_cost_balances_covering'],['cost-coverage',{sql:'SELECT * FROM inventory_cost_coverage_totals WHERE workspace_id=$1',values:[ctx.workspaceId]},'inventory_cost_coverage_positions','idx_inventory_cost_coverage_values'],['physical-stock',{sql:'SELECT sku_id,location_id,on_hand FROM balances WHERE workspace_id=$1',values:[ctx.workspaceId]},'balances','idx_balances_workspace_covering'],['sku-summary',{sql:'SELECT id,item_id,is_active FROM skus WHERE workspace_id=$1',values:[ctx.workspaceId]},'skus','idx_skus_workspace_summary_covering']]){
   const plan=(await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,q.values)).rows[0]['QUERY PLAN'][0],nodes=[];const visit=n=>{nodes.push(n);for(const child of n.Plans||[])visit(child);};visit(plan.Plan);
   const source=nodes.filter(n=>n['Relation Name']===relation);assert(source.length,kind+' must read its canonical source');assert(source.every(n=>n['Node Type']==='Index Only Scan'&&n['Index Name']===index),kind+' must support a covered source read');
   plans.push({kind,index,heapFetches:source.reduce((sum,n)=>sum+Number(n['Heap Fetches']||0),0),executionMs:plan['Execution Time']});
  }
 },{isolation:'READ COMMITTED',readOnly:true,jit:false,statementTimeoutMs:5000});
 const rows=(await reports.run(db,ctx,{role:'owner'},config,{limit:14})).rows;
 const expected=(await db.query('SELECT s.code,sum(b.total_cost_minor)::text amount FROM accounting_inventory_cost_balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id WHERE b.workspace_id=$1 AND s.code=ANY($2::text[]) GROUP BY s.code',[ctx.workspaceId,rows.map(r=>r.sku)])).rows;
 for(const row of rows)assert.equal(String(row.total),expected.find(r=>r.code===row.sku)?.amount,'Stock-value preview retains the exact per-variant amount');
 return {balanced:true,previewRows:rows.length,plans};
}
module.exports={check};
