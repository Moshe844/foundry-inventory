'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Ask reads live reorder thresholds from the canonical report even without a purchase recommendation',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:2}),{db,ctx}=f;
 const quiet=await require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'needs_you'});assert.equal(quiet.rows.length,0);assert.equal(quiet.handoff,null,'An empty read must not manufacture an unrelated Home action');
 await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,created_at,updated_at) VALUES('low-stock-test',$1,$2,$3,3,8,now(),now())`,[ctx.workspaceId,f.item.skuIds[0],f.location.id]);
 const actor=(await db.query('SELECT role,permissions FROM users WHERE id=$1',[ctx.actorId])).rows[0],canonical=await require('../../src/reports/postgres-service').run(db,ctx,actor,{dataset:'low_stock',columns:['sku','product','location','on_hand','reorder_point','target_stock']});
 const actual=await require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'replenishment'});
 assert.equal(actual.rows.length,1);assert.equal(actual.rows[0].sku,canonical.rows[0].sku);assert.equal(Number(actual.rows[0].on_hand),2);assert.equal(Number(actual.rows[0].reorder_point),3);assert.match(actual.answer,/at or below/);assert.equal(actual.handoff.href,'/reports/builder?dataset=low_stock');
 await db.query('UPDATE reorder_policies SET reorder_point=1 WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal((await require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'replenishment'})).rows.length,0);
 await db.query(`INSERT INTO stockchief_runtime.stock_threshold_rules(id,workspace_id,sku_id,threshold,metric,comparator,armed,stated_as,approved_by_user_id,created_at,updated_at) VALUES('low-stock-warning',$1,$2,3,'on_hand','at_or_below',true,'Isolated warning parity fixture',$3,now(),now())`,[ctx.workspaceId,f.item.skuIds[0],ctx.actorId]);
 await require('../../src/manager/postgres-stock-threshold-alerts').evaluate(db,{workspaceId:ctx.workspaceId});
 const warnings=(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(x=>x.kind==='inventory'),read=await require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'replenishment'});assert.equal(read.rows.length,0);assert.equal(read.inventoryWarnings.length,1);assert.equal(read.inventoryWarnings[0].id,warnings[0].sourceId);assert.equal(read.inventoryWarnings[0].href,warnings[0].href);
 assert.equal(await f.balance(),2);t.diagnostic('Actual PostgreSQL; no model, provider or stock writes except isolated fixture setup.');
});
