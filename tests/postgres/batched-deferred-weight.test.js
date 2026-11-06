'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('stock statements share one deferred position check and retain final measured-stock constraints',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
 const item=await catalog.createItem(db,ctx,{name:'Batch measured pieces',trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'}),sku=item.skuIds[0],location=f.location.id;
 const queued=async c=>Number((await c.query('SELECT count(*)::int n FROM stockchief_runtime.measured_check_transactions WHERE transaction_id=pg_current_xact_id()')).rows[0].n);
 await db.transaction(async c=>{
  await c.query('INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at) VALUES($1,$2,$3,1,now())',[ctx.workspaceId,sku,location]);
  await c.query('UPDATE balances SET secondary_on_hand=0.125 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku]);
  assert.equal(await queued(c),1);assert.equal((await c.query('SELECT count(*)::int n FROM pg_temp.stockchief_measured_positions')).rows[0].n,1);
 });
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.measured_check_transactions')).rows[0].n,0);
 await assert.rejects(db.query('UPDATE balances SET secondary_on_hand=0 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku]),/Pieces and actual weight/);
 await db.transaction(async c=>{await c.query('UPDATE balances SET on_hand=0 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku]);await c.query('UPDATE balances SET secondary_on_hand=0 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku]);assert.equal(await queued(c),1);});
 await assert.rejects(db.transaction(async c=>{await c.query('UPDATE balances SET on_hand=1 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku]);await c.query('SET CONSTRAINTS ALL IMMEDIATE');}),/Pieces and actual weight/);
 await db.transaction(async c=>{await c.query('SAVEPOINT weight_fixture');await c.query('UPDATE balances SET on_hand=1,secondary_on_hand=0.25 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku]);await c.query('ROLLBACK TO SAVEPOINT weight_fixture');assert.equal(await queued(c),0);});
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('batched-weight-fixture',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const definitions=Array.from({length:200},(_,p)=>({name:'Ordinary batch '+p,trackingMode:'quantity',variants:Array.from({length:10},(_,v)=>({code:'DEFERRED-'+p+'-'+v}))})),created=await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,definitions)),ids=created.flatMap(i=>i.skus.map(s=>s.skuId));
 await db.transaction(async c=>{
  await c.query('INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at) SELECT $1,s,$3,1,now() FROM unnest($2::text[])s',[ctx.workspaceId,ids,location]);
  await c.query('UPDATE balances SET on_hand=on_hand WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',[ctx.workspaceId,ids]);
  assert.equal(await queued(c),1);assert.equal((await c.query('SELECT count(*)::int n FROM pg_temp.stockchief_measured_positions')).rows[0].n,2000,'Repeated writes retain one key per stock position');
 });
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.measured_check_transactions')).rows[0].n,0);
 // An ordinary position still participates if the product changes to measured
 // stock later in the same transaction; batching cannot weaken that guard.
 await assert.rejects(db.transaction(async c=>{await c.query('UPDATE balances SET on_hand=on_hand WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,ids[0]]);await c.query("UPDATE items SET secondary_unit_label='kg',secondary_precision=3,secondary_increment=0.001 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,created[0].itemId]);}),/Pieces and actual weight/);
 const rowTriggers=(await db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='balances'::regclass AND tgfoid='stockchief_secondary_position_complete()'::regprocedure AND (tgtype & 1)=1")).rows[0].n;assert.equal(rowTriggers,0);
});
