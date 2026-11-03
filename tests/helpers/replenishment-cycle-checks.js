'use strict';
const assert=require('node:assert/strict');
async function check(database,ctx){
 const auto=require('../../src/autopilot/postgres-service'),cycle=require('../../src/purchasing/postgres-replenishment-cycle');
 await auto.plan(database,ctx.workspaceId,{limitSkus:1});
 let aggregates=0,pages=0;
 const measured={query:async(sql,args)=>{
  if(sql.includes('INSERT INTO stockchief_runtime.replenishment_planning_demand'))aggregates++;
  if(sql.includes('WITH demand_eligible AS')){pages++;assert(!sql.includes('replenishment_demand_events'),'A planning page must never recompute inventory-wide demand');assert(!sql.includes('occurred_at::timestamptz'),'A timestamp cast must not hide the time index');}
  return database.query(sql,args);
 },transaction:fn=>fn(measured)};
 const started=performance.now(),prepared=await cycle.begin(measured,ctx.workspaceId,'large-cycle');
 assert(!prepared.skipped);assert.equal(aggregates,1);
 const first=await auto.plan(measured,ctx.workspaceId,{limitSkus:250,cycleId:'large-cycle',planningRevision:prepared.planningRevision});
 assert(first.partial);assert.equal(first.processedSkus,250);
 assert(!(await cycle.begin(measured,ctx.workspaceId,'large-cycle',{continuation:true})).skipped);
 const second=await auto.plan(measured,ctx.workspaceId,{limitSkus:250,afterSkuId:first.nextAfterSkuId,cycleId:'large-cycle',planningRevision:prepared.planningRevision,processedSkus:first.processedSkus});
 assert(second.partial);assert.equal(second.processedSkus,500);assert(second.nextAfterSkuId>first.nextAfterSkuId);
 await require('../../src/forecasting/postgres-planning-service').refreshRecommendations(measured,ctx.workspaceId,{limitSkus:250,cycleId:'large-cycle'});
 assert.equal(aggregates,1,'Forecast and every continuation share one demand aggregation');assert.equal(pages,3);
 assert.equal(Number((await database.query('SELECT count(*) n FROM stockchief_runtime.replenishment_planning_eligible WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),50000);
 assert.equal((await cycle.begin(measured,ctx.workspaceId,'duplicate-new-cycle')).skipped,'planning_debounced');
 const foreign=await require('../../src/purchasing/postgres-replenishment-state').rows(measured,'foreign-inventory',{cycleId:'large-cycle',eligibleOnly:true,limitSkus:250});assert.equal(foreign.length,0);
 return {aggregates,pages,elapsedMs:Math.round(performance.now()-started)};
}
module.exports={check};
