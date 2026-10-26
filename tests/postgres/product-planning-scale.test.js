'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('large catalogs do not expand irrelevant planning positions and reconciliation remains exact',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:7}),{db,ctx}=f;
 const root=process.env.STOCKCHIEF_TEST_SOURCE||path.resolve(__dirname,'../..');
 const inventory=require(root+'/src/domain/postgres-inventory-engine'),locations=require(root+'/src/domain/postgres-location-service');
 const destination=await locations.createLocation(db,ctx,{name:'Neutral destination',kind:'store'});
 await inventory.issue(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,idempotencyKey:'scale-demand-a'});
 await inventory.issue(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,idempotencyKey:'scale-demand-b'});
 await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,position,is_active,created_at)
   SELECT 'scale-'||n,$1,$2,'OTHER-'||n,n+100,1,$3 FROM generate_series(1,30000)n`,[ctx.workspaceId,f.item.itemId,new Date().toISOString()]);
 await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,created_at,updated_at)
   VALUES('policy-scale',$1,$2,$3,2,4,0,$4,$4)`,[ctx.workspaceId,f.item.skuIds[0],destination.id,new Date().toISOString()]);
 const observed={planning:0,forecast:0},wrapped={...db,query:async(sql,args)=>{const result=await db.query(sql,args);if(sql.includes('rp.default_order_quantity'))observed.planning=result.rows.length;if(sql.includes('sold_90')&&sql.includes('CROSS JOIN locations'))observed.forecast=result.rows.length;return result;}};
 const snapshot=(await db.query('SELECT sum(on_hand)::text stock FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 await t.test('only eligible SKUs enter the all-location planner without losing a spare-stock source',async()=>{
   const result=await require(root+'/src/autopilot/postgres-service').plan(wrapped,ctx.workspaceId);
   assert(observed.planning<=4,'Irrelevant SKU/location positions expanded: '+observed.planning);
   const candidate=result.considered.find(x=>x.skuId===f.item.skuIds[0]&&x.destinationLocationId===destination.id);
   assert(candidate);assert.equal(candidate.type,'transfer');assert.equal(candidate.quantity,4);assert.equal(candidate.sourceLocationId,f.location.id);
 });
 await t.test('scheduled forecast recommendations read only the positive-demand positions they can use',async()=>{
   await require(root+'/src/forecasting/postgres-planning-service').refreshRecommendations(wrapped,ctx.workspaceId);
   assert.equal(observed.forecast,1);
 });
 await t.test('balance and journal checks still inspect all scoped records and catch a late stock mismatch',async()=>{
   const checks=require(root+'/src/operations/postgres-reconciliation').INVARIANTS;
   for(const check of checks)assert.equal((await db.query(check.query,[ctx.workspaceId])).rows.length,0,check.key);
   await db.query('UPDATE balances SET on_hand=on_hand+3 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],f.location.id]);
   const mismatch=(await db.query(checks[0].query,[ctx.workspaceId])).rows;assert.equal(mismatch.length,1);assert.equal(mismatch[0].sku_id,f.item.skuIds[0]);assert.equal(Number(mismatch[0].actual_quantity)-Number(mismatch[0].expected_quantity),3);
   await db.query('UPDATE balances SET on_hand=on_hand-3 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],f.location.id]);
 });
 assert.deepEqual((await db.query('SELECT sum(on_hand)::text stock FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],snapshot);
});
