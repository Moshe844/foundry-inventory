'use strict';
const assert=require('node:assert/strict');
async function check(db,ctx){
 const summaries=require('../../src/projections/postgres-cost-summaries');
 const canonical=async()=>(await db.query('SELECT coalesce(sum(quantity_units),0)::text units,coalesce(sum(total_cost_minor),0)::text cost FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 const expected=await canonical();let done=false;for(let n=0;n<20&&!done;n++)done=(await summaries.refresh(db,ctx.workspaceId)).done;assert(done,'Bounded worker jobs must finish summary initialization');
 const began=performance.now(),totals=(await summaries.totals(db,ctx.workspaceId)).rows[0],readMs=performance.now()-began;
 assert.equal(Number(totals.units),Number(expected.units));assert.equal(Number(totals.cost),Number(expected.cost));assert(readMs<1500,'Clean stock-cost totals must meet the existing page budget');
 const plan=(await db.query('EXPLAIN(ANALYZE,FORMAT JSON) SELECT sum(total_cost_minor) FROM ('+summaries.source()+') costs',[ctx.workspaceId])).rows[0]['QUERY PLAN'][0].Plan;
 const nodes=[];function visit(p){nodes.push(p);for(const child of p.Plans||[])visit(child);}visit(plan);
 const canonicalNodes=nodes.filter(p=>p['Relation Name']==='accounting_inventory_cost_balances');assert(canonicalNodes.every(p=>p['Actual Loops']===0),'Clean reads must never visit location-level cost balances');
 const counts=(await db.query('SELECT (SELECT count(*) FROM stockchief_runtime.sku_cost_totals WHERE workspace_id=$1)::int summaries,(SELECT count(*) FROM skus WHERE workspace_id=$1)::int skus',[ctx.workspaceId])).rows[0];assert(counts.summaries<=counts.skus);
 await db.transaction(async c=>{await c.query('UPDATE accounting_inventory_cost_balances SET total_cost_minor=total_cost_minor+1 WHERE workspace_id=$1 AND (sku_id,location_id)=(SELECT sku_id,location_id FROM accounting_inventory_cost_balances WHERE workspace_id=$1 ORDER BY sku_id,location_id LIMIT 1)',[ctx.workspaceId]);assert.equal(Number((await summaries.value(c,ctx.workspaceId)).minor),Number(expected.cost)+1,'Dirty reads fall back in the writing transaction');throw Object.assign(Error('rollback summary probe'),{probe:true});},{isolation:'READ COMMITTED'}).catch(e=>{if(!e.probe)throw e;});
 assert.deepEqual(await canonical(),expected);assert.equal(Number((await summaries.value(db,ctx.workspaceId)).minor),Number(expected.cost));
 return {skuCostSummaries:counts.summaries,catalogueSkus:counts.skus,readMs,canonicalCostBalanceReadLoops:canonicalNodes.reduce((n,p)=>n+p['Actual Loops'],0),exactCanonicalCosts:true,dirtyFallback:true,sourceRowsChanged:0,paidCalls:0};
}
module.exports={check};
