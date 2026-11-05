'use strict';
const assert=require('node:assert/strict');
// Staging's history has 1.7M events and 121,643 distinct timestamps. Keep this
// reader fixture temporary: it must not create stock, journals or customer data.
async function check(db,ctx){
 const reports=require('../../src/reports/postgres-service'),actor={role:'owner'},dateContext={timeZone:'America/New_York',calendarDate:'2026-11-04'};
 return db.withSessionLock('qualification:movement-history-shape',async c=>{
  try{
   await c.query('CREATE TEMP TABLE qualification_movement_history(workspace_id text NOT NULL,occurred_at text NOT NULL,quantity_delta numeric NOT NULL)');
   await c.query(`INSERT INTO qualification_movement_history
    SELECT $1,to_char('2026-11-01 00:00:00'::timestamp+((n-1)%121643)*interval '3 seconds','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),CASE WHEN n%2=0 THEN 1.25 ELSE -1.25 END
    FROM generate_series(1,1700000) n`,[ctx.workspaceId]);
   await c.query(`INSERT INTO qualification_movement_history VALUES('another-workspace','2026-11-02T12:00:00.000Z',999999999)`);
   await c.query('CREATE INDEX qualification_movement_time_covering ON qualification_movement_history(workspace_id,stockchief_movement_instant(occurred_at)) INCLUDE(occurred_at,quantity_delta)');
   await c.query('VACUUM ANALYZE qualification_movement_history');
   const expected=(await c.query(`SELECT to_char(occurred_at::timestamptz AT TIME ZONE 'America/New_York','YYYY-MM-DD') day,sum(quantity_delta)::text total
    FROM qualification_movement_history WHERE workspace_id=$1 AND occurred_at::timestamptz>='2026-11-01T04:00:00Z' AND occurred_at::timestamptz<'2026-11-05T05:00:00Z' GROUP BY 1 ORDER BY 1`,[ctx.workspaceId])).rows;
   const filters=[{field:'occurred_on',operator:'at_least',value:'2026-11-01'},{field:'occurred_on',operator:'at_most',value:'2026-11-04'}],timings={};
   for(const summary of [true,false]){
    const config=reports.normalize({dataset:'movements',groups:summary?[]:['occurred_on'],summary,aggregate:'sum',measure:'quantity_delta',filters,sort:summary?'total':'occurred_on',direction:'asc'},actor),compiled=reports.queryFor(config,ctx.workspaceId,{dateContext});
    const sql=compiled.sql.replaceAll('FROM movements m','FROM pg_temp.qualification_movement_history m');
    assert.notEqual(sql,compiled.sql,'Exercise the real movement compiler against the isolated history relation');
    await c.transaction(async tx=>{
     const result=(await tx.query(sql,compiled.values)).rows;
     if(summary)assert.equal(Number(result[0].total),expected.reduce((n,row)=>n+Number(row.total),0));
     else assert.deepEqual(result.map(row=>({day:row.occurred_on,total:row.total})),expected);
     const plan=(await tx.query('EXPLAIN (ANALYZE,FORMAT JSON) '+sql,compiled.values)).rows[0]['QUERY PLAN'][0];
     timings[summary?'summaryMs':'trendMs']=plan['Execution Time'];assert(plan['Execution Time']<1500,'Movement history read must finish below 1.5 seconds');
     const nodes=[];const visit=n=>{nodes.push(n);for(const child of n.Plans||[])visit(child);};visit(plan.Plan);
     assert(!nodes.some(n=>n['Node Type']==='InitPlan'),'The business zone must not be re-read by an unknown planning-time subquery');
    },{readOnly:true,isolation:'READ COMMITTED',jit:false,statementTimeoutMs:1500});
   }
   return {movementRows:1700000,distinctTimestamps:121643,...timings,exactTotals:true,tenantIsolation:true,paidCalls:0};
  }finally{await c.query('DROP TABLE IF EXISTS pg_temp.qualification_movement_history');}
 });
}
module.exports={check};
