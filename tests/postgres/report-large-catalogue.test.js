'use strict';process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');

test('a 100,000-SKU report returns its first PostgreSQL page in under two seconds',
  {timeout:180000},async t=>{
    const {db,ctx}=await require('../helpers/postgres-shipping-fixture').fixture(t);
    const now=new Date().toISOString();
    await db.query(`INSERT INTO items(id,workspace_id,name,tracking_mode,unit_label,created_at,updated_at)
      SELECT 'report-scale-item-'||n,$1,'Independent item '||lpad(n::text,6,'0'),
        'quantity','unit',$2,$2 FROM generate_series(1,100000) AS n`,[ctx.workspaceId,now]);
    await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,position,created_at)
      SELECT 'report-scale-sku-'||n,$1,'report-scale-item-'||n,
        'SCALE-'||lpad(n::text,6,'0'),0,$2 FROM generate_series(1,100000) AS n`,[ctx.workspaceId,now]);
    await db.query('ANALYZE items');await db.query('ANALYZE skus');
    const actor=(await db.query(`SELECT u.role,u.permissions,a.email FROM users u
      JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2`,
      [ctx.workspaceId,ctx.actorId])).rows[0];
    const report=require('../../src/reports/postgres-service');
    const spec={dataset:'catalogue',columns:['product','sku','status'],sort:'sku',direction:'asc'};
    const start=performance.now();
    const result=await report.run(db,ctx,actor,spec,{limit:201});
    const elapsedMs=performance.now()-start;
    assert.equal(result.rows.length,200);assert.equal(result.hasMore,true);
    assert(elapsedMs<2000,`First report page took ${elapsedMs.toFixed(0)} ms`);
    const startNext=performance.now();
    const next=await report.run(db,ctx,actor,spec,{limit:201,offset:200});
    assert.equal(next.rows.length,200);assert.notEqual(next.rows[0].sku,result.rows[0].sku);
    assert(performance.now()-startNext<2000,'Next report page exceeded two seconds');
    const top=await report.run(db,ctx,actor,{...spec,topN:5},{limit:201});
    assert.equal(top.rows.length,5);assert.equal(top.hasMore,false);
    assert.equal(await report.countAtMost(db,ctx,actor,{...spec,topN:5},100000),5);
    const bottom=await report.run(db,ctx,actor,{...spec,topN:5,direction:'desc'},{limit:201});
    assert.equal(bottom.rows.length,5);assert.equal(bottom.hasMore,false);
    assert.notEqual(bottom.rows[0].sku,top.rows[0].sku);
    assert.throws(()=>report.normalize({...spec,topN:1001},actor),/between 1 and 1,000/);
    const categoryTop={dataset:'catalogue',groups:['status'],aggregate:'count',sort:'count',topN:1};
    const categoryResult=await report.run(db,ctx,actor,categoryTop,{limit:201});
    const sourceSpec=report.drilldownSpec(categoryResult.config,['active'],actor);
    assert.equal(sourceSpec.topN,null,'A source drilldown must not inherit the summary display cap');
  });
