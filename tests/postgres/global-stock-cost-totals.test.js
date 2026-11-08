'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('global stock value follows canonical costs during projection rebuild, concurrent receipt and rollback',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,totals=require('../../src/projections/postgres-cost-summaries');
 await db.query('DELETE FROM stockchief_runtime.sku_cost_totals WHERE workspace_id=$1',[ctx.workspaceId]);
 assert.equal(Number((await totals.value(db,ctx.workspaceId)).minor),400);
 await db.transaction(async c=>{
  assert.equal(Number((await totals.value(c,ctx.workspaceId)).minor),400);
  await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,unitCost:'1.00',idempotencyKey:'global-value-concurrent'});
  assert.equal(Number((await totals.value(c,ctx.workspaceId)).minor),400,'A repeatable-read page retains its own exact committed snapshot');
 },{isolation:'REPEATABLE READ',readOnly:true});
 assert.equal(Number((await totals.value(db,ctx.workspaceId)).minor),500);
 await assert.rejects(db.transaction(async c=>{await c.query('UPDATE accounting_inventory_cost_balances SET total_cost_minor=total_cost_minor+7 WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal(Number((await totals.value(c,ctx.workspaceId)).minor),507);throw Error('Abort cost change');}),/Abort cost change/);
 const actual=(await totals.totals(db,ctx.workspaceId)).rows[0];assert.equal(Number(actual.units),5);assert.equal(Number(actual.cost),500);assert.equal(Number((await totals.value(db,'foreign-inventory')).minor),0);
});
