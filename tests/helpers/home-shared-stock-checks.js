'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 let stockScans=0,locationScans=0;const measured={...db,query:(sql,...values)=>{if(sql.includes('sum(total_cost_minor),0)::bigint AS minor'))stockScans++;if(sql.includes('SELECT l.id,l.name,COALESCE(SUM(b.on_hand)'))locationScans++;return db.query(sql,...values);}},home=require('../../src/projections/postgres-home-summary'),expected=Number((await db.query('SELECT coalesce(sum(total_cost_minor),0)::text total FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].total);
 const calls=await Promise.all(Array.from({length:50},()=>home.read(measured,ctx.workspaceId,{seesMoney:true,sales:{minor:0,currency:'USD'}})));assert(calls.every(c=>c.stockValue.minor===expected));assert.equal(stockScans,1,'Fifty Home summaries share one exact committed stock-value scan');
 const hidden=await home.read(measured,ctx.workspaceId,{seesMoney:false,sales:{minor:0,currency:'USD'}});assert.equal(hidden.stockValue,null);assert.equal(stockScans,1,'Financial visibility is checked before any shared stock-value read');
 const brief=await require('../../src/projections/postgres-service').brief(measured,ctx.workspaceId,ctx.actorId,{includeLocationStock:false});assert.equal(locationScans,0,'Home must not aggregate unused per-location quantities');assert.equal(brief.locations.length,0);assert(brief.stats.locationCount>0);
 return {homeReaders:50,stockValueScans:stockScans,exactStockValueMinor:expected,unusedLocationStockScans:locationScans,financialVisibilityPreserved:true,paidCalls:0};
}
module.exports={check};
