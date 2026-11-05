'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 const module=require('../../src/projections/postgres-movement-buckets');let ready=false;for(let n=0;n<20&&!ready;n++)ready=(await module.refresh(db,ctx.workspaceId)).done;assert(ready);
 const reports=require('../../src/reports/postgres-service'),time=await require('../../src/lib/business-time').forWorkspace(db,ctx.workspaceId),period=require('../../src/accounting/customer-money').dates({},time.calendarDate),stats=(await db.query('SELECT count(*)::int rows,sum(quantity_delta)::text quantity FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 let executionMs=0;for(const zone of ['UTC','America/New_York','Asia/Kathmandu']){
  const config=reports.normalize({dataset:'movements',groups:['occurred_on'],aggregate:'sum',measure:'quantity_delta',filters:[{field:'occurred_on',operator:'after',value:period.from},{field:'occurred_on',operator:'before',value:period.to}],sort:'occurred_on',direction:'asc'},{role:'owner'}),q=reports.queryFor(config,ctx.workspaceId,{dateContext:{...time,timeZone:zone},limit:401,includeOverall:true});
  const actual=(await db.query(q.sql,q.values)).rows,expected=(await db.query("SELECT to_char(stockchief_movement_instant(occurred_at) AT TIME ZONE $4,'YYYY-MM-DD') AS day_key,sum(quantity_delta)::numeric total FROM movements WHERE workspace_id=$1 AND stockchief_movement_instant(occurred_at)>=($2::text::date::timestamp AT TIME ZONE $4) AND stockchief_movement_instant(occurred_at)<(($3::text::date+1)::timestamp AT TIME ZONE $4) GROUP BY 1 ORDER BY 1",[ctx.workspaceId,period.from,period.to,zone])).rows;
  assert.deepEqual(actual.map(r=>({day:r.occurred_on,total:Number(r.total)})),expected.map(r=>({day:r.day_key,total:Number(r.total)})));
  const plan=(await db.transaction(c=>c.query('EXPLAIN(ANALYZE,FORMAT JSON) '+q.sql,q.values),{readOnly:true,isolation:'READ COMMITTED',jit:false})).rows[0]['QUERY PLAN'][0],nodes=[];const visit=p=>{nodes.push(p);for(const child of p.Plans||[])visit(child);};visit(plan.Plan);assert(nodes.filter(p=>p['Relation Name']==='movements').every(p=>p['Actual Loops']===0),'An initialized ordinary-calendar chart must not revisit canonical movements');executionMs=Math.max(executionMs,plan['Execution Time']);assert(executionMs<1500);
 }
 return {movementBucketSourceRows:stats.rows,canonicalReadLoops:0,timeZones:['UTC','America/New_York','Asia/Kathmandu'],exactTotals:true,executionMs,sourceRowsChanged:0,paidCalls:0};
}
module.exports={check};
