'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('large catalogs do not expand irrelevant planning positions and reconciliation remains exact',{timeout:300000},async t=>{
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
 const observed={planning:0,forecast:0},wrapped={...db,query:async(sql,args)=>{const result=await db.query(sql,args);if(sql.includes('rp.default_order_quantity')){observed.planning=result.rows.length;observed.forecast=result.rows.length;}return result;}};
 const snapshot=(await db.query('SELECT sum(on_hand)::text stock FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 await t.test('only eligible SKUs enter the all-location planner without losing a spare-stock source',async()=>{
   const result=await require(root+'/src/autopilot/postgres-service').plan(wrapped,ctx.workspaceId);
   assert(observed.planning<=4,'Irrelevant SKU/location positions expanded: '+observed.planning);
   const candidate=result.considered.find(x=>x.skuId===f.item.skuIds[0]&&x.destinationLocationId===destination.id);
   // Five remain after the two issues. Keep one lead-time unit plus one safety
   // unit at the source; transferring four would violate its measured reserve.
   assert(candidate);assert.equal(candidate.type,'transfer');assert.equal(candidate.quantity,3);assert.equal(candidate.sourceLocationId,f.location.id);
 });
 await t.test('scheduled forecast recommendations read only eligible demand and policy positions',async()=>{
   await require(root+'/src/forecasting/postgres-planning-service').refreshRecommendations(wrapped,ctx.workspaceId);
   assert.equal(observed.forecast,2);
 });
 await t.test('balance and journal checks still inspect all scoped records and catch a late stock mismatch',async()=>{
   const checks=require(root+'/src/operations/postgres-reconciliation').INVARIANTS;
   for(const check of checks)assert.equal((await db.query(check.query,[ctx.workspaceId])).rows.length,0,check.key);
   await db.query('UPDATE balances SET on_hand=on_hand+3 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],f.location.id]);
   const mismatch=(await db.query(checks[0].query,[ctx.workspaceId])).rows;assert.equal(mismatch.length,1);assert.equal(mismatch[0].sku_id,f.item.skuIds[0]);assert.equal(Number(mismatch[0].actual_quantity)-Number(mismatch[0].expected_quantity),3);
   await db.query('UPDATE balances SET on_hand=on_hand-3 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],f.location.id]);
 });
 await t.test('catalog-wide rules without suppliers do not perform one database read per stock position',async()=>{
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,created_at,updated_at)
   SELECT 'many-policy-'||n,$1,'scale-'||n,$2,0,4,0,$3,$3 FROM generate_series(1,1200)n`,[ctx.workspaceId,destination.id,new Date().toISOString()]);
  let queries=0;const measured={...db,query:async(sql,args)=>{queries++;return db.query(sql,args);}};
  const result=await require(root+'/src/autopilot/postgres-service').plan(measured,ctx.workspaceId);
  assert(result.considered.filter(c=>c.reason==='no_supplier').length>=1200);assert(queries<20,'Planner performs one read per position: '+queries);
  await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,purchase_unit,units_per_purchase_unit,last_unit_cost,lead_time_days,minimum_order_quantity,order_multiple,is_preferred,is_active,created_at,updated_at)
   SELECT 'many-link-'||n,$1,'fixture-supplier','scale-'||n,'SUPPLIER-'||n,'unit',1,1,7,1,1,1,1,$2,$2 FROM generate_series(1,1200)n`,[ctx.workspaceId,new Date().toISOString()]);
  queries=0;const linked=await require(root+'/src/autopilot/postgres-service').plan(measured,ctx.workspaceId);assert.equal(linked.created.length,1200);assert(queries<20,'Suggestion/audit persistence performs one write per position: '+queries);assert.equal((await db.query("SELECT count(*)::int n FROM work_item_events WHERE workspace_id=$1 AND event='planned'",[ctx.workspaceId])).rows[0].n,1201);assert.equal((await require(root+'/src/autopilot/postgres-service').plan(measured,ctx.workspaceId)).created.length,0,'A retry cannot duplicate suggestions or their audit records');
 });
 await t.test('thousands of empty locations do not multiply paged SKU results or hide late global rules',async()=>{
  await db.query(`INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at)
   SELECT 'empty-location-'||n,$1,'Empty location '||n,'warehouse',1,$2 FROM generate_series(1,1000)n`,[ctx.workspaceId,new Date().toISOString()]);
  const planner=require(root+'/src/forecasting/postgres-planning-service');
  const first=await planner.position(db,ctx.workspaceId,{limitSkus:250});assert.equal(first.coverage.scanned,250);assert(first.coverage.partial);assert(first.length<=500);
  const next=await planner.position(db,ctx.workspaceId,{limitSkus:250,afterSkuId:first.coverage.nextAfterSkuId});assert.equal(next.coverage.scanned,250);assert(next.every(r=>!first.some(p=>p.sku_id===r.sku_id)));
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,created_at,updated_at)
   VALUES('late-global',$1,'scale-9999',NULL,1,2,0,$2,$2)`,[ctx.workspaceId,new Date().toISOString()]);
  const tail=await planner.position(db,ctx.workspaceId,{limitSkus:1,afterSkuId:'scale-9998'}),global=tail.find(r=>r.scope==='workspace');
  assert.equal(global.sku_id,'scale-9999');assert.equal(global.onHand,0);assert(global.shortage);assert(global.receivingOptions.length>=1000);assert.equal(tail.length,2);
 });
 assert.deepEqual((await db.query('SELECT sum(on_hand)::text stock FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],snapshot);
});
