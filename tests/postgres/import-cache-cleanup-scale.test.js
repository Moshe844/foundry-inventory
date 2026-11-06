'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('verified import cache cleanup stays bounded at 150000 identities with stale statistics',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const imports=require('../../src/imports/postgres-service'),cache=require('../../src/imports/postgres-execution-cache');
 const plan=await imports.analyse(db,ctx,{text:'Product,SKU\nCache scale,CACHE-SCALE',allowModel:false});
 await imports.approve(db,ctx,plan.id,plan.integrityHash);const result=await imports.execute(db,ctx,plan.id);assert(result.verified);
 const other=await imports.analyse(db,ctx,{text:'Product,SKU\nOther source,CACHE-OTHER',allowModel:false});
 await db.query('ANALYZE import_execution_identities');
 await db.query(`INSERT INTO import_rows(id,workspace_id,import_id,row_number,raw,parsed,status,problems,created_at)
  SELECT 'cache-scale-'||n,$1,$2,n,'{}','{}','IMPORTED','[]',now() FROM generate_series(100,150099)n`,[ctx.workspaceId,plan.id]);
 await db.query(`INSERT INTO import_execution_identities(workspace_id,import_id,row_id,row_number,product_key,variant_key)
  SELECT $1,$2,'cache-scale-'||n,n,'product','variant' FROM generate_series(100,150099)n`,[ctx.workspaceId,plan.id]);
 const count=async id=>Number((await db.query('SELECT count(*) n FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,id])).rows[0].n);
 const timings=[];
 for(const mode of ['force_generic_plan','force_custom_plan']){
  const rollback=Error('rollback cache cleanup probe');
  await assert.rejects(db.transaction(async c=>{
   await c.query('SET LOCAL plan_cache_mode='+mode);
   const measured={transaction:async fn=>fn({query:async(sql,values)=>{
    if(!sql.startsWith('WITH targets'))return c.query(sql,values);
    const explained=(await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0];
    const nodes=[];const walk=p=>{nodes.push(p);for(const child of p.Plans||[])walk(child);};walk(explained.Plan);
    const scans=nodes.filter(p=>p['Relation Name']==='import_execution_identities'&&p['Node Type']!=='ModifyTable');
    assert(scans.every(p=>p['Actual Rows']<=5000&&p['Actual Loops']===1),'Every cleanup scan is bounded to its selected page');
    assert(nodes.some(p=>p['Index Name']==='import_execution_identities_pkey'&&p['Index Cond']?.includes('row_id = ANY')),'Deletes resolve the stable primary keys');
    assert(!scans.some(p=>p['Node Type']==='Seq Scan'));
    timings.push({mode,ms:explained['Execution Time']});return {rows:[{n:5000}]};
   }})};
   assert.deepEqual(await cache.releaseCompleted(measured,ctx,plan.id),{removed:5000,done:false,eligible:true});
   assert.equal(Number((await c.query('SELECT count(*) n FROM import_execution_identities WHERE import_id=$1',[plan.id])).rows[0].n),145000);
   throw rollback;
  },{isolation:'READ COMMITTED',statementTimeoutMs:15000}),e=>e===rollback);
 }
 assert.equal(await count(plan.id),150000);
 assert.equal((await cache.releaseCompleted(db,{workspaceId:'another-workspace'},plan.id)).eligible,false);
 assert.equal((await cache.releaseCompleted(db,ctx,other.id)).eligible,false);
 const cleanupStart=performance.now(),finished=await cache.finish(db,ctx,plan.id),cleanupMs=performance.now()-cleanupStart;assert.deepEqual(finished,{state:'RELEASED',removed:150000});
 assert.equal(await count(plan.id),0);assert.equal(await count(other.id),1);
 assert.equal((await db.query('SELECT count(*)::int n FROM import_rows WHERE import_id=$1',[plan.id])).rows[0].n,150001,'Source evidence is retained');
 assert.equal((await imports.report(db,ctx.workspaceId,plan.id)).verified,true);
 assert((await imports.execute(db,ctx,plan.id)).duplicate);
 t.diagnostic(JSON.stringify({identities:150000,sourceAndReceiptPreserved:true,otherSourcePreserved:true,timings,cleanupMs}));
});
