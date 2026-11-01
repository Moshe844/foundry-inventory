'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('stock report keeps variant, warehouse, physical quantity and recorded cost together without hiding uncosted stock',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const reports=require('../../src/reports/postgres-service'),inventory=require('../../src/domain/postgres-inventory-engine');
 await db.query("UPDATE skus SET variant_label='Blue / Large' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.item.skuIds[0]]);
 const other=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Uncosted warehouse',kind:'warehouse'});
 await inventory.receive(db,ctx,{skuId:f.item.skuIds[0],locationId:other.id,quantity:2,idempotencyKey:'uncosted-stock'});
 const definition={dataset:'stock',title:'Stock and recorded cost',columns:['product','variant','location','on_hand','recorded_cost_minor','cost_status'],groups:[],aggregate:'count',measure:'',filters:[],sort:'product',direction:'asc',chart:'table'};
 const full=await reports.run(db,ctx,{role:'owner'},definition);assert.equal(full.rows.length,2);
 const valued=full.rows.find(r=>r.location==='Dispatch'),unknown=full.rows.find(r=>r.location==='Uncosted warehouse');
 assert.equal(valued.variant,'Blue / Large');assert.equal(Number(valued.on_hand),4);assert.equal(Number(valued.recorded_cost_minor),400);assert.equal(valued.cost_status,'complete');
 assert.equal(Number(unknown.on_hand),2);assert.equal(unknown.recorded_cost_minor,null);assert.equal(unknown.cost_status,'missing');
 assert.equal(full.displayRows.find(r=>r.location==='Dispatch').recorded_cost_minor,'$4.00');assert(full.columns.includes('currency'));
 await inventory.receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,idempotencyKey:'partly-uncosted-stock'});
 const partial=await reports.run(db,ctx,{role:'owner'},definition);assert.equal(partial.rows.find(r=>r.location==='Dispatch').cost_status,'partial');assert.equal(Number(partial.rows.find(r=>r.location==='Dispatch').recorded_cost_minor),400);
 assert.throws(()=>reports.normalize({...definition,groups:['currency'],aggregate:'sum',measure:'recorded_cost_minor',sort:'total'},{role:'owner'}),/not known for every record/);
 const quantity=await reports.run(db,ctx,{role:'owner'},{...definition,groups:['location'],aggregate:'sum',measure:'on_hand',sort:'total'});assert.equal(quantity.rows.reduce((n,r)=>n+Number(r.total),0),7);
 assert.equal((await reports.run(db,{...ctx,workspaceId:'another-inventory'},{role:'owner'},definition)).rows.length,0);
 const proposed=await require('../../src/reports/postgres-ask').prepare(db,ctx,'Show stock by warehouse with product, variant, on-hand quantity and recorded inventory cost.',{provider:{async complete(request){
  if(request.schemaName==='stockchief_governed_report_fit')return {data:{aligned:true,reason:''}};
  assert.match(request.system,/For a detail list/);const stock=JSON.parse(request.prompt).catalogue.find(r=>r.dataset==='stock');assert.equal(stock.fields.recorded_cost_minor,'money_minor');assert.equal(stock.fields.variant,'text');return {data:definition};
 }}});assert(proposed.reportConfig);assert.equal(proposed.rows.length,2);
 const weighed=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Weighed product',trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
 await require('../../src/domain/postgres-opening-stock').receive(db,ctx,{skuId:weighed.skuIds[0],locationId:f.location.id,quantity:2,secondaryQuantity:4.5,unitCost:'1.00',currency:'USD',idempotencyKey:'weighted-report'});
 const completeWeight=await reports.run(db,ctx,{role:'owner'},definition);assert.equal(completeWeight.rows.find(r=>r.product==='Weighed product').cost_status,'complete');
 // A legacy weight discrepancy must remain visible even when piece counts match.
 await db.query('UPDATE accounting_inventory_cost_balances SET secondary_quantity_units=4 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,weighed.skuIds[0]]);
 const partialWeight=await reports.run(db,ctx,{role:'owner'},definition);assert.equal(partialWeight.rows.find(r=>r.product==='Weighed product').cost_status,'partial');
});
