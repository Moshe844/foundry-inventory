'use strict';
const assert=require('node:assert/strict');
async function check(db,ctx,{historyRows=1700000}={}){
 const capacity=require('../../src/operations/postgres-capacity'),now=Date.parse('2026-11-05T12:00:00Z'),at=new Date(now).toISOString();
 return db.withSessionLock('qualification:capacity-history',async c=>{
  try{
   await c.query('CREATE TEMP TABLE qualification_capacity_history(runtime_kind text,operation text,started_at timestamptz,elapsed_microseconds bigint,outcome text)');
   await c.query("INSERT INTO qualification_capacity_history SELECT 'web','GET /reports','2025-01-01'::timestamptz,9000000,'500' FROM generate_series(1,$1::int)",[historyRows]);
   await c.query(`INSERT INTO qualification_capacity_history VALUES
    ('web','GET /reports',$1::timestamptz-interval '5 minutes',1000,'200'),
    ('web','GET /money',$1::timestamptz-interval '1 minute',2000,'ABORTED'),
    ('web','GET /',$1::timestamptz-interval '1 millisecond',3000,'503'),
    ('web','GET /inventory',$1::timestamptz,4000,'400'),
    ('web','GET /reports',$1::timestamptz+interval '1 millisecond',9000000,'500'),
    ('web','GET /reports',$1::timestamptz-interval '5 minutes 1 millisecond',9000000,'500'),
    ('web','GET /healthz',$1::timestamptz,9000000,'500'),
    ('web','GET /readyz',$1::timestamptz,9000000,'500'),
    ('web','GET unmatched-or-static',$1::timestamptz,9000000,'500'),
    ('worker','GET /reports',$1::timestamptz,9000000,'500')`,[at]);
   await c.query("CREATE INDEX qualification_capacity_recent ON qualification_capacity_history(started_at,elapsed_microseconds) WHERE runtime_kind='web'");await c.query('VACUUM ANALYZE qualification_capacity_history');
   let captured;const observed={query:(sql,values)=>{const bounded=sql.replaceAll('FROM commercial_resource_measurements','FROM pg_temp.qualification_capacity_history');assert.notEqual(bounded,sql);captured={sql:bounded,values};return c.query(bounded,values);}};
   const sample=await capacity.sample(observed,{now,role:'qualification',diskCapacityGb:50});assert.equal(sample.httpSamples5m,4);assert.equal(sample.httpErrors5m,2);assert(Math.abs(sample.httpP95Ms-3.85)<1e-9);assert.equal(sample.sampledAt,at);
   assert.doesNotMatch(captured.sql,/clock_timestamp/);assert.equal((captured.sql.match(/FROM pg_temp.qualification_capacity_history/g)||[]).length,1,'All HTTP metrics share one recent population');
   const explained=(await c.query('EXPLAIN(ANALYZE,FORMAT JSON) '+captured.sql,captured.values)).rows[0]['QUERY PLAN'][0],nodes=[];const visit=n=>{nodes.push(n);for(const child of n.Plans||[])visit(child);};visit(explained.Plan);
   assert(nodes.some(n=>n['Index Name']==='qualification_capacity_recent'));assert(!nodes.some(n=>n['Relation Name']==='qualification_capacity_history'&&n['Node Type']==='Seq Scan'));assert(explained['Execution Time']<1500);
   return {historyRows,recentSamples:sample.httpSamples5m,errors:sample.httpErrors5m,p95Ms:sample.httpP95Ms,executionMs:explained['Execution Time'],indexedRecentWindow:true,sharedPopulation:true,paidCalls:0};
  }finally{await c.query('DROP TABLE IF EXISTS pg_temp.qualification_capacity_history');}
 });
}
module.exports={check};
