'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Ask counts retain archived variants, stock positions and all filters without unnecessary price or cost joins',{timeout:180000},async t=>{
 const {db,ctx,item,location}=await require('../helpers/postgres-shipping-fixture').fixture(t),reports=require('../../src/reports/postgres-service'),registry=require('../../src/reports/postgres-registry'),catalog=require('../../src/domain/postgres-catalog-service'),actor={role:'owner'};
 const extra=await catalog.createItem(db,ctx,{name:'Count fixture',baseCode:'COUNT-EXTRA',trackingMode:'quantity',sellingPrice:'5',purchaseCost:'2'});
 await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:extra.skuIds[0],locationId:location.id,quantity:2,idempotencyKey:'count-extra'});
 await db.query('UPDATE skus SET is_active=0 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,extra.skuIds[0]]);
 await db.query('UPDATE items SET is_active=0 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,item.itemId]);
 const cases=[
  {dataset:'catalogue',summary:true,aggregate:'count'},
  {dataset:'catalogue',groups:['status'],aggregate:'count'},
  {dataset:'catalogue',groups:['product_status','variant_status'],aggregate:'count'},
  {dataset:'catalogue',summary:true,aggregate:'count_distinct',measure:'sku'},
  {dataset:'catalogue',summary:true,aggregate:'count',filters:[{field:'status',operator:'equals',value:'inactive'}]},
  {dataset:'catalogue',summary:true,aggregate:'count',filters:[{field:'selling_price_recorded',operator:'equals',value:'yes'}]},
  {dataset:'stock',summary:true,aggregate:'count'},
  {dataset:'stock',groups:['location','stock_unit'],aggregate:'count'},
  {dataset:'stock',summary:true,aggregate:'count_distinct',measure:'sku'},
  {dataset:'stock',summary:true,aggregate:'count',filters:[{field:'on_hand',operator:'greater_than',value:2}]},
  {dataset:'stock',summary:true,aggregate:'count',filters:[{field:'cost_status',operator:'equals',value:'complete'}]}
 ];
 for(const spec of cases){
  const config=reports.normalize(spec,actor),dataset=registry.get(spec.dataset),query=reports.queryFor(config,ctx.workspaceId),projection=dataset.aggregateProjections[0];
  const actual=(await db.query(query.sql,query.values)).rows,expected=(await db.query(query.sql.replace(projection.source,dataset.source),query.values)).rows;
  assert.deepEqual(actual,expected,JSON.stringify(spec));
  assert.deepEqual((await reports.run(db,ctx,actor,spec)).rows.map(({href,...r})=>r),expected);
 }
 for(const dataset of ['catalogue','stock']){
  const sql=reports.queryFor(reports.normalize({dataset,summary:true,aggregate:'count'},actor),ctx.workspaceId).sql;
  assert.doesNotMatch(sql,/sku_prices|accounting_inventory_cost_balances|accounting_settings/);
  assert.equal(Number((await reports.run(db,ctx,actor,{dataset,summary:true,aggregate:'count'})).rows[0].count),2);
 }
 const price=reports.queryFor(reports.normalize(cases[5],actor),ctx.workspaceId).sql,cost=reports.queryFor(reports.normalize(cases.at(-1),actor),ctx.workspaceId).sql;
 assert.match(price,/sku_prices/);assert.match(cost,/accounting_inventory_cost_balances/);
});
