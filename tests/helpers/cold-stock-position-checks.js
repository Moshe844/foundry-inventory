'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){return db.withSessionLock('qualification:cold-stock-positions',async c=>{
 const prior=(await c.query("SELECT current_setting('work_mem') work_mem,current_setting('jit') jit")).rows[0];
 const shadow=sql=>sql.replace(/\b(FROM|JOIN) balances\b/g,'$1 pg_temp.cold_balances').replace(/\b(FROM|JOIN) locations\b/g,'$1 pg_temp.cold_locations').replace(/\b(FROM|JOIN) accounting_inventory_cost_balances\b/g,'$1 pg_temp.cold_cost_balances');
 try{
  await c.query("SELECT set_config('work_mem','4MB',false),set_config('jit','off',false)");
  await c.query('CREATE TEMP TABLE cold_locations AS SELECT * FROM locations WHERE workspace_id=$1',[ctx.workspaceId]);
  await c.query(`INSERT INTO cold_locations SELECT (jsonb_populate_record(NULL::public.locations,to_jsonb(l)||jsonb_build_object('id','cold-loc-'||n,'name','Cold read bin '||n,'kind','bin','parent_location_id',l.id,'custody_agreement_id',NULL,'is_active',1))).* FROM (SELECT * FROM locations WHERE workspace_id=$1 AND is_active=1 LIMIT 1)l CROSS JOIN generate_series(1,23)n`,[ctx.workspaceId]);
  await c.query("CREATE TEMP TABLE cold_balances AS SELECT s.workspace_id,s.id sku_id,'cold-loc-'||n location_id,1::numeric on_hand FROM skus s CROSS JOIN generate_series(1,23)n WHERE s.workspace_id=$1 AND s.is_active=1",[ctx.workspaceId]);
  await c.query("INSERT INTO cold_balances SELECT 'wsp_foreigncold',sku_id,'foreign-'||location_id,on_hand*7 FROM cold_balances");
  await c.query('CREATE UNIQUE INDEX cold_positions ON cold_balances(workspace_id,sku_id,location_id) INCLUDE(on_hand)');
  await c.query('CREATE INDEX cold_positions_location ON cold_balances(location_id)');await c.query('CREATE INDEX cold_positions_workspace ON cold_balances(workspace_id)');
  await c.query('CREATE TEMP TABLE cold_cost_balances AS SELECT workspace_id,sku_id,location_id,on_hand AS quantity_units,on_hand*200 AS total_cost_minor FROM cold_balances');await c.query('CREATE INDEX cold_cost_values ON cold_cost_balances(workspace_id,sku_id) INCLUDE(quantity_units,total_cost_minor)');
  await c.query('CREATE INDEX cold_locations_scope ON cold_locations(workspace_id,id)');await c.query('VACUUM ANALYZE cold_balances');await c.query('VACUUM ANALYZE cold_cost_balances');await c.query('ANALYZE cold_locations');
  const positions=(await c.query('SELECT count(*)::int n FROM cold_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;let availability;
  const reader={query:(sql,values)=>{const text=shadow(sql);if(sql.includes('physical AS NOT MATERIALIZED'))availability={sql:text,values};return c.query(text,values);}};
  const actual=await require('../../src/domain/postgres-stock-availability').total(reader,ctx.workspaceId);assert(availability);
  const reference=(await c.query(availability.sql.replace('physical AS NOT MATERIALIZED','physical AS MATERIALIZED'),availability.values)).rows[0];assert.equal(actual,Number(reference.quantity));
  const source=shadow(require('../../src/reports/low-stock-source').source()),low={sql:'SELECT count(*)::int n,coalesce(sum(on_hand),0)::text quantity FROM ('+source+') source',values:[ctx.workspaceId]};
  const current=(await c.query(low.sql,low.values)).rows[0],legacy=(await c.query(low.sql.replace('stock_positions AS NOT MATERIALIZED','stock_positions AS MATERIALIZED'),low.values)).rows[0];assert.deepEqual(current,legacy);
  const reports=require('../../src/reports/postgres-service'),config=reports.normalize({dataset:'inventory_valuation',groups:['sku'],aggregate:'sum',measure:'book_cost_minor',filters:[{field:'currency',operator:'equals',value:'USD'}],sort:'total',direction:'desc'},{role:'owner'}),stockValue=reports.queryFor(config,ctx.workspaceId,{limit:13,includeOverall:true}),stock={...stockValue,sql:shadow(stockValue.sql)},valueRows=(await c.query(stock.sql,stock.values)).rows;assert(valueRows.length);assert.equal(Number(valueRows[0].total),4600);assert.equal(Number(valueRows[0].__report_overall),positions*200);
  const plans=[];for(const [kind,q,forbidden]of [['availability',availability,'physical'],['low-stock',low,'stock_positions'],['stock-value',stock,'complete_position_population']]){
   const plan=(await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,q.values)).rows[0]['QUERY PLAN'][0],nodes=[];const visit=n=>{nodes.push(n);for(const p of n.Plans||[])visit(p);};visit(plan.Plan);
   assert(!nodes.some(n=>n['Node Type']==='CTE Scan'&&n['CTE Name']===forbidden),'The complete position population must not be written to an intermediate table');
   if(kind==='low-stock')assert(nodes.filter(n=>n['Relation Name']==='cold_balances'&&!String(n['Index Cond']||'').includes('p.sku_id')).every(n=>n['Actual Loops']<=1),'Stock totals must not rescan the heap separately for every warehouse');
   if(kind==='stock-value')assert(nodes.filter(n=>/Join|Nested Loop/.test(n['Node Type'])).every(n=>n['Actual Rows']<=positions/23),'Join item identities after grouping stock positions by SKU');
   assert(plan['Execution Time']<1500,kind+' cold read exceeded 1.5 seconds: '+plan['Execution Time']);plans.push({kind,executionMs:plan['Execution Time'],tempBlocksWritten:plan.Plan['Temp Written Blocks']||0,positionMaterialization:false});
  }
  return {positions,foreignPositions:positions,skus:positions/23,availability:actual,lowStockRows:current.n,stockValueMinor:positions*200,canonicalValuesUnchanged:true,plans,paidCalls:0};
 }finally{await c.query('DROP TABLE IF EXISTS pg_temp.cold_balances,pg_temp.cold_locations,pg_temp.cold_cost_balances');await c.query("SELECT set_config('work_mem',$1,false),set_config('jit',$2,false)",[prior.work_mem,prior.jit]);}
});}
module.exports={check};
