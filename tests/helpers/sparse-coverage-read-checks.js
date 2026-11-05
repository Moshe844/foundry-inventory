'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){return db.withSessionLock('qualification:sparse-cost-coverage',async c=>{
 try{
  await c.query(`CREATE TEMP TABLE sparse_cost_coverage(workspace_id text,sku_id text,location_id text,physical_units numeric,costed_units numeric,book_cost_minor bigint,missing_units numeric GENERATED ALWAYS AS(greatest(physical_units-costed_units,0)) STORED)`);
  await c.query("INSERT INTO sparse_cost_coverage(workspace_id,sku_id,location_id,physical_units,costed_units,book_cost_minor) SELECT s.workspace_id,s.id,'sparse-bin-'||n,1,1,100 FROM skus s CROSS JOIN generate_series(1,23)n WHERE s.workspace_id=$1 AND s.is_active=1",[ctx.workspaceId]);
  await c.query('UPDATE sparse_cost_coverage SET costed_units=0,book_cost_minor=0 WHERE ctid IN(SELECT ctid FROM sparse_cost_coverage LIMIT 5)');
  await c.query("INSERT INTO sparse_cost_coverage(workspace_id,sku_id,location_id,physical_units,costed_units,book_cost_minor) SELECT 'wsp_foreignsparsecoverage',sku_id,location_id,100,0,0 FROM sparse_cost_coverage LIMIT 5");
  await c.query('CREATE INDEX qualification_sparse_coverage ON sparse_cost_coverage(workspace_id,missing_units,physical_units,costed_units,book_cost_minor)');await c.query('VACUUM ANALYZE sparse_cost_coverage');
  let captured;const reader={query:(sql,values)=>{const text=sql.replaceAll('FROM inventory_cost_coverage_positions','FROM pg_temp.sparse_cost_coverage');assert.notEqual(text,sql);captured={sql:text,values};return c.query(text,values);}};
  const coverage=require('../../src/accounting/postgres-quantity-coverage'),actual=await coverage.read(reader,ctx.workspaceId),q=captured;
  assert.deepEqual(actual,{missingCostUnits:5});assert.deepEqual(await coverage.read(reader,'wsp_absentsparsecoverage'),{missingCostUnits:0});
  const control=(await c.query('SELECT sum(missing_units)::text total,count(*)::int positions FROM sparse_cost_coverage WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(Number(control.total),actual.missingCostUnits);
  const plan=(await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,q.values)).rows[0]['QUERY PLAN'][0],nodes=[];const visit=n=>{nodes.push(n);for(const child of n.Plans||[])visit(child);};visit(plan.Plan);
  if(control.positions>=10000){const reads=nodes.filter(n=>n['Relation Name']==='sparse_cost_coverage');assert(reads.length);assert(reads.every(n=>n['Node Type']==='Index Only Scan'&&n['Index Name']==='qualification_sparse_coverage'&&n['Index Cond'].includes('missing_units >')));assert(reads.reduce((n,p)=>n+p['Actual Rows']*p['Actual Loops'],0)<=5,'Fully costed stock must not be scanned to count missing costs');}
  assert(plan['Execution Time']<1500);return {coveragePositions:control.positions,missingCostUnits:actual.missingCostUnits,exactGeneratedTotal:true,foreignWorkspaceExcluded:true,indexedNonzeroRange:control.positions>=10000,executionMs:plan['Execution Time'],paidCalls:0};
 }finally{await c.query('DROP TABLE IF EXISTS pg_temp.sparse_cost_coverage');}
});}
module.exports={check};
