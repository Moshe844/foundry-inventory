'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('stock-only staff keep stock access while costs and margins are denied in pages, Ask and reports',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe}=f;
 const prices=require('../../src/pricing/postgres-service');await db.transaction(c=>prices.setPurchaseCostsInTransaction(c,ctx,[{skuId:f.item.skuIds[0],amountMinor:6791,currency:'USD'}]));
 await db.transaction(c=>prices.setPricesInTransaction(c,ctx,[{skuId:f.item.skuIds[0],amountMinor:9900,currency:'USD'}]));
 const reports=require('../../src/reports/postgres-service'),assistant=require('../../src/assistant/postgres-service'),registry=require('../../src/reports/postgres-registry');
 const restricted={role:'staff',permissions:'["VIEW"]'};
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);await db.query("UPDATE users SET role='staff',permissions='[\"VIEW\"]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
  const schema=reports.queryContract('stock',restricted);assert(!schema.schema.properties.columns.items.enum.includes('recorded_cost_minor'));
  assert(!registry.list(restricted).some(d=>d.key==='inventory_valuation'));
  await reports.run(db,ctx,restricted,{dataset:'stock',columns:['sku','on_hand']},{limit:20});
  for(const spec of [{dataset:'stock',columns:['sku','recorded_cost_minor']},{dataset:'stock',summary:true,aggregate:'sum',measure:'recorded_cost_minor'},
   {dataset:'stock',columns:['sku'],filters:[{field:'recorded_cost_minor',operator:'greater_than',value:0}]},{dataset:'inventory_valuation',columns:['sku','book_cost_minor']}])
   await assert.rejects(reports.run(db,ctx,restricted,spec),e=>['validation_error','forbidden'].includes(e.code));
  for(const view of ['inventory_valuation','inventory_cost_movements','purchase_costs','business_analysis','sales_activity'])
   await assert.rejects(assistant.lookup(db,ctx,{view,timeframe:'all_time'}),e=>e.code==='forbidden');
  assert((await assistant.lookup(db,ctx,{view:'inventory_positions',timeframe:'all_time'})).rows.length);
  const page=await browser.get('/inventory/'+f.item.itemId).expect(200);assert(!page.text.includes('$67.91'));assert(!page.text.includes('Profit per'));
  await browser.get('/inventory/'+f.item.itemId+'?tab=suppliers').expect(403);
  await browser.get('/imports').expect(403);
 }
 await db.query("UPDATE users SET role='owner',permissions=NULL WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 const allowed=await browser.get('/inventory/'+f.item.itemId).expect(200);assert(allowed.text.includes('$67.91'));assert(allowed.text.includes('Profit per'));
 const reviews=require('../../src/autopilot/job-reviews');await subscribe('starter');await assert.rejects(reviews.run(db,ctx,'financial-permissions'),e=>e.code==='entitlement_required');
 for(const tier of ['growth','pro','enterprise']){await subscribe(tier);assert.equal((await reviews.run(db,ctx,'financial-permissions')).rows[0]['Purchase costs'],'Allowed');}
 assert.equal(await f.balance(),4);
});
