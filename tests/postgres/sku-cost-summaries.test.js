'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const summaries=require('../../src/projections/postgres-cost-summaries');

test('SKU cost summaries retain exact committed costs through concurrent receipts, rollback, deletion and single-connection refresh',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,sku=f.item.skuIds[0];
 await t.test('installing the migration seeds existing canonical costs without rewriting them',async()=>{
  const before=(await db.query('SELECT * FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows;
  await db.transaction(async c=>{
   await c.query('DROP TRIGGER zz_sku_cost_summary_insert ON accounting_inventory_cost_balances; DROP TRIGGER zz_sku_cost_summary_update ON accounting_inventory_cost_balances; DROP TRIGGER zz_sku_cost_summary_delete ON accounting_inventory_cost_balances; DROP FUNCTION stockchief_queue_sku_cost_summary(); DROP TABLE stockchief_runtime.sku_cost_pending,stockchief_runtime.sku_cost_totals');
   await c.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../src/db/postgres-migrations/212-sku-cost-read-model.sql'),'utf8'));
  },{isolation:'READ COMMITTED'});
  assert.deepEqual((await db.query('SELECT * FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows,before);
 });
 const value=async()=>Number((await summaries.value(db,ctx.workspaceId)).minor);
 const pending=async()=>Number((await db.query('SELECT count(*)::int n FROM stockchief_runtime.sku_cost_pending WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 assert(await pending()>0);assert.equal(await value(),400,'Uninitialized summaries read canonical receipts');
 await db.query("INSERT INTO stockchief_runtime.sku_cost_pending(workspace_id,sku_id) SELECT $1,'a-newer-'||n FROM generate_series(1,500)n",[ctx.workspaceId]);
 await summaries.refreshBatch(db,ctx.workspaceId);
 assert.equal(Number((await db.query('SELECT total_cost_minor FROM stockchief_runtime.sku_cost_totals WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0]?.total_cost_minor),400,'An older change is served before 500 newer alphabetically earlier SKUs');
 const single=require('../../src/db/postgres').openPostgres(f.cluster.connectionString,{max:1,connectionTimeoutMillis:1000});
 try{assert.equal((await summaries.refresh(single,ctx.workspaceId)).done,true);}finally{await single.close();}
 assert.equal(await pending(),0);assert.equal(await value(),400);
 await db.query('UPDATE accounting_inventory_cost_balances SET updated_at=now() WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal(await pending(),0,'Timestamp-only writes do not dirty totals');
 await assert.rejects(db.transaction(async c=>{await c.query('UPDATE accounting_inventory_cost_balances SET total_cost_minor=total_cost_minor+100 WHERE workspace_id=$1',[ctx.workspaceId]);throw Error('rollback fixture');},{isolation:'READ COMMITTED'}),/rollback fixture/);
 assert.equal(await pending(),0);assert.equal(await value(),400);
 const receive=key=>require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:1,unitCost:'1.00',idempotencyKey:key});
 await receive('summary-first-receipt');assert.equal(await value(),500);
 let concurrentReceiptMs;
 await summaries.refreshBatch(db,ctx.workspaceId,{beforePublish:async()=>{const started=performance.now();await receive('summary-concurrent-receipt');concurrentReceiptMs=performance.now()-started;assert(concurrentReceiptMs<1500,'Summary refresh must not hold a lock that stalls receipts');assert.equal(await value(),600,'Readers see the new receipt before summary publication');}});
 assert(await pending()>0,'A receipt committed after the refresh snapshot keeps its independent pending key');assert.equal(await value(),600,'An older refresh cannot hide a newer receipt');
 await summaries.refresh(db,ctx.workspaceId);assert.equal(await pending(),0);assert.equal(await value(),600);
 t.diagnostic(JSON.stringify(await require('../helpers/sku-cost-summary-checks').check(db,ctx)));
 await db.query('UPDATE skus SET is_active=0 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,sku]);assert.equal(await value(),600,'Archival retains historical stock value');
 await db.query('UPDATE accounting_inventory_cost_balances SET quantity_units=3.75,total_cost_minor=375 WHERE workspace_id=$1',[ctx.workspaceId]);
 await summaries.refresh(db,ctx.workspaceId);const fractional=(await summaries.totals(db,ctx.workspaceId)).rows[0];assert.equal(Number(fractional.units),3.75);assert.equal(Number(fractional.cost),375);
 assert.equal(Number((await summaries.value(db,'foreign-workspace')).minor),0,'No cross-inventory cost disclosure');
 await db.query('DELETE FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal(await value(),0);await summaries.refresh(db,ctx.workspaceId);assert.equal(await value(),0);assert.equal((await db.query('SELECT * FROM stockchief_runtime.sku_cost_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows.length,0);
 t.diagnostic(JSON.stringify({costSummarySnapshotRace:true,concurrentReceiptMs,rollbackSafe:true,fractionalUnits:true,archivedValue:true,singleConnection:true,sourceWriterBlocked:false,paidCalls:0}));
});

test('bounded summary jobs continue after a completed partial job without duplicating a scheduler bucket',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,now=180000;
 await summaries.schedule(db,{now});await summaries.schedule(db,{now});
 const jobs=async()=>(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='inventory.refresh-cost-summary' ORDER BY created_at",[ctx.workspaceId])).rows;
 assert.equal((await jobs()).length,1);await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED' WHERE id=$1",[(await jobs())[0].id]);
 await summaries.schedule(db,{now:now+30000});assert.equal((await jobs()).length,2,'Remaining work gets a new job even when its first pending key is unchanged');
 const handlers=require('../../src/operations/postgres-runtime-handlers').create({});assert.equal(typeof handlers['inventory.refresh-cost-summary'],'function');
 const done=await require('../../src/operations/postgres-job-queue').processOne(db,handlers,{owner:'cost-summary-fixture',kinds:['inventory.refresh-cost-summary'],now:now+30000});assert.equal(done.status,'COMPLETED',JSON.stringify(done.lastError));assert.equal(Number((await summaries.value(db,ctx.workspaceId)).minor),400);
});
