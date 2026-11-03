'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('read-side totals remain exact without shared summary-row writes',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'growth','COMP','CUSTOM','OFFLINE_FIXTURE')",[randomUUID(),f.owner.accountId]);
 await t.test('shared summary triggers are gone and reads use security-invoker views',async()=>{
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal AND tgname=ANY($1::text[])",[['cost_coverage_insert','cost_coverage_update','daily_journal_totals','movement_second_totals']])).rows[0].n,0);
  const rows=(await db.query("SELECT relkind,reloptions FROM pg_class WHERE oid=ANY($1::regclass[])",[['inventory_cost_coverage_totals','accounting_daily_account_totals','inventory_movement_second_totals','stockchief_runtime.inventory_capacity']])).rows;
  assert.equal(rows.length,4);assert(rows.every(r=>r.relkind==='v'&&r.reloptions.includes('security_invoker=true')));
 });
 await t.test('stock cost, posted money and movement totals are immediately canonical',async()=>{
  const compare=async client=>{
   const cost=(await client.query('SELECT * FROM inventory_cost_coverage_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
   const source=(await client.query('SELECT sum(physical_units)::text physical_units,sum(costed_units)::text costed_units,sum(book_cost_minor)::text book_cost_minor,sum(missing_units)::text missing_units FROM inventory_cost_coverage_positions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
   for(const key of Object.keys(source))assert.equal(String(cost[key]),source[key]);
   const journal=(await client.query('SELECT sum(debit_minor)::text debit,sum(credit_minor)::text credit,sum(line_count)::text lines FROM accounting_daily_account_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
   const posted=(await client.query("SELECT sum(l.debit_minor)::text debit,sum(l.credit_minor)::text credit,count(*)::text lines FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id WHERE l.workspace_id=$1 AND e.status='POSTED'",[ctx.workspaceId])).rows[0];assert.deepEqual(journal,posted);
   const movement=(await client.query('SELECT sum(quantity_delta)::text quantity,sum(movement_count)::text count FROM inventory_movement_second_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
   const events=(await client.query('SELECT sum(quantity_delta)::text quantity,count(*)::text count FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.deepEqual(movement,events);
  };
  await compare(db);await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:3,unitCost:'2',idempotencyKey:'read-totals-stock'});await compare(db);
  await db.transaction(async c=>{await c.query('UPDATE balances SET on_hand=on_hand+1 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,f.item.skuIds[0]]);await compare(c);},{isolation:'READ COMMITTED'});
 });
 await t.test('concurrent catalogue growth cannot oversubscribe the plan at READ COMMITTED',async()=>{
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'active_skus',2,'OFFLINE concurrency fixture')",[randomUUID(),f.owner.accountId]);
  const attempts=await Promise.allSettled([1,2].map(n=>db.transaction(c=>c.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_active,created_at)
   SELECT $1,workspace_id,item_id,$2,1,created_at FROM skus WHERE id=$3 AND workspace_id=$4`,[randomUUID(),'RC-CAP-'+n,f.item.skuIds[0],ctx.workspaceId]),{isolation:'READ COMMITTED',retrySafe:true})));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.filter(r=>r.status==='rejected').length,1);
  assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'entitlement_required');
  assert.equal(Number((await db.query('SELECT active_skus FROM stockchief_runtime.inventory_capacity WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].active_skus),2);
 });
 await t.test('derived totals cannot expose another inventory through a restricted database role',async()=>{
  const foreign=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Other business',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
  const reader=await require('../../scripts/environment-agent-demo/inspection').inspectionDatabase(f.cluster,db,ctx);f.cleanup(()=>reader.close());
  assert.deepEqual((await reader.query('SELECT workspace_id FROM stockchief_runtime.inventory_capacity')).rows.map(r=>r.workspace_id),[ctx.workspaceId]);
  for(const relation of ['inventory_cost_coverage_totals','accounting_daily_account_totals','inventory_movement_second_totals']){
   const rows=(await reader.query('SELECT DISTINCT workspace_id FROM '+relation)).rows;assert(rows.every(r=>r.workspace_id===ctx.workspaceId));assert(!rows.some(r=>r.workspace_id===foreign.workspaceId));
  }
 });
});
