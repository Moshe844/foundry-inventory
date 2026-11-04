'use strict';
const assert=require('node:assert/strict');
async function check(db,ctx){
 const reports=require('../../src/reports/postgres-service'),actor={role:'owner'},source=(await db.query('SELECT count(*)::int records,count(DISTINCT occurred_at)::int instants,sum(quantity_delta)::text total FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 const config=reports.normalize({dataset:'movements',groups:['occurred_on'],aggregate:'sum',measure:'quantity_delta',sort:'occurred_on',direction:'asc'},actor),query=reports.queryFor(config,ctx.workspaceId,{limit:201});
 const plan=await db.transaction(async c=>(await c.query('EXPLAIN (ANALYZE,FORMAT JSON) '+query.sql,query.values)).rows[0]['QUERY PLAN'][0],{isolation:'READ COMMITTED',readOnly:true,jit:false,statementTimeoutMs:1500});
 const nodes=[];const visit=node=>{nodes.push(node);for(const child of node.Plans||[])visit(child);};visit(plan.Plan);
 const rollup=nodes.find(n=>n['Subplan Name']==='CTE movement_instants');assert(rollup,'Convert dates after the materialized timestamp rollup');
 assert.equal(Number(rollup['Actual Rows']),source.instants,'The date-conversion stage receives distinct timestamps, never individual SKU movements');
 if(source.records>=10000)assert(source.instants<source.records/2,'The realistic bulk import must exercise shared timestamps');
 const [trend,summary]=await Promise.all([reports.run(db,ctx,actor,config,{limit:201}),reports.run(db,ctx,actor,{...config,groups:[],summary:true,sort:'total'},{limit:2})]);
 assert.equal(trend.hasMore,false);assert.equal(trend.rows.reduce((n,row)=>n+Number(row.total),0),Number(source.total));assert.equal(Number(summary.rows[0].total),Number(source.total));
 return {movementRows:source.records,convertedInstants:source.instants,chartRows:trend.rows.length,executionMs:plan['Execution Time'],exactTotals:true};
}
module.exports={check};
