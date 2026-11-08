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
 await totals.refresh(db,ctx.workspaceId);
 const scans=async c=>{const plan=(await c.query('EXPLAIN(ANALYZE,FORMAT JSON) '+totals.totalsSql,[ctx.workspaceId])).rows[0]['QUERY PLAN'][0],nodes=[];const visit=p=>{nodes.push(p);for(const child of p.Plans||[])visit(child);};visit(plan.Plan);return nodes.filter(n=>n['Relation Name']==='accounting_inventory_cost_balances').reduce((count,n)=>count+n['Actual Loops'],0);};
 assert.equal(await scans(db),0,'Clean global totals must not scan canonical positions');
 await assert.rejects(db.transaction(async c=>{
  await c.query("INSERT INTO stockchief_runtime.sku_cost_pending(workspace_id,sku_id) SELECT $1,'bounded-cost-backlog-'||n FROM generate_series(1,1100)n",[ctx.workspaceId]);
  assert.equal(Number((await totals.value(c,ctx.workspaceId)).minor),500);assert.equal(await scans(c),1,'A large backlog uses one canonical range scan');throw Error('Rollback pending queue probe');
 },{isolation:'READ COMMITTED'}),/Rollback pending queue probe/);
 assert.equal(Number((await totals.value(db,ctx.workspaceId)).minor),500);
});
