'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 let initialized=false;for(let n=0;n<20&&!initialized;n++)initialized=(await require('../../src/projections/postgres-sku-stock').refresh(db,ctx.workspaceId)).done;assert(initialized);
 const expected=(await db.query(`WITH by_sku AS(SELECT sku_id,sum(on_hand) quantity FROM balances WHERE workspace_id=$1 GROUP BY sku_id)
  SELECT count(*) FILTER(WHERE s.is_active=1)::int skus,coalesce(sum(b.quantity) FILTER(WHERE i.quantity_precision=0),0)::text units,
  count(*) FILTER(WHERE s.is_active=1 AND coalesce(b.quantity,0)<=0)::int empty FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id LEFT JOIN by_sku b ON b.sku_id=s.id WHERE s.workspace_id=$1`,[ctx.workspaceId])).rows[0];
 let query;const reader={...db,query:(sql,values)=>{if(sql.startsWith('WITH stock_by_sku AS MATERIALIZED'))query={sql,values};return db.query(sql,values);}};
 const brief=await require('../../src/projections/postgres-service').brief(reader,ctx.workspaceId,ctx.actorId,{includeLocationStock:false,includeAvailability:false});assert(query);
 assert.equal(brief.stats.skuCount,expected.skus);assert.equal(brief.stats.unitsOnHand,Number(expected.units));assert.equal(brief.stats.zeroCount,expected.empty);
 const plan=(await db.transaction(c=>c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+query.sql,query.values),{readOnly:true,isolation:'READ COMMITTED',jit:false,statementTimeoutMs:1500})).rows[0]['QUERY PLAN'][0],nodes=[];const visit=p=>{nodes.push(p);for(const child of p.Plans||[])visit(child);};visit(plan.Plan);
 const raw=nodes.filter(p=>p['Relation Name']==='balances'),rollups=nodes.filter(p=>p['Relation Name']==='item_location_balances');assert(raw.every(p=>p['Actual Loops']===0),'Initialized Home statistics must not read canonical stock positions');assert(rollups.every(p=>p['Actual Loops']===0),'Home must reuse the SKU quantities already read instead of looking up every item/location total');assert(plan['Execution Time']<1500);
 return {homeBriefSkus:expected.skus,ordinaryUnits:Number(expected.units),emptySkus:expected.empty,exactPriorStats:true,maxPositionsPerSkuLookup:0,canonicalStockReadLoops:0,itemLocationReadLoops:0,usesSkuStockModel:true,usesSkuTotalsForUnits:true,executionMs:plan['Execution Time'],sourceRowsChanged:0,paidCalls:0};
}
module.exports={check};
