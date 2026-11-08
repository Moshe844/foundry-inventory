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

test('summary rollback probes preserve zero-value empty positions even when they sort first',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,emptySku='000-empty-cost-summary';
 await db.query("INSERT INTO skus(id,workspace_id,item_id,code,created_at) SELECT $3,workspace_id,item_id,'EMPTY-COST-SUMMARY',created_at FROM skus WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.item.skuIds[0],emptySku]);
 await db.query('INSERT INTO accounting_inventory_cost_balances(workspace_id,sku_id,location_id,quantity_units,total_cost_minor,updated_at) VALUES($1,$2,$3,0,0,$4)',[ctx.workspaceId,emptySku,f.location.id,new Date().toISOString()]);
 assert.equal((await db.query('SELECT sku_id FROM accounting_inventory_cost_balances WHERE workspace_id=$1 ORDER BY sku_id,location_id LIMIT 1',[ctx.workspaceId])).rows[0].sku_id,emptySku);
 await assert.rejects(db.query('UPDATE accounting_inventory_cost_balances SET total_cost_minor=1 WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,emptySku]),{code:'23514'});
 const result=await require('../helpers/sku-cost-summary-checks').check(db,ctx);assert(result.dirtyFallback&&result.exactCanonicalCosts);
 const empty=(await db.query('SELECT quantity_units,total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,emptySku])).rows[0];assert.equal(Number(empty.quantity_units),0);assert.equal(Number(empty.total_cost_minor),0);
 assert.equal(Number((await summaries.value(db,ctx.workspaceId)).minor),400);
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

test('cost summary reads stay within the inventory through 500000 unrelated summary rows',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Unrelated summary history',email:require('node:crypto').randomUUID()+'@example.test',password:'Other!'+require('node:crypto').randomUUID()});
 await summaries.refresh(db,ctx.workspaceId);
 // Place this inventory's summary physically behind the unrelated rows. A
 // probabilistic EXISTS startup plan then has to walk the foreign heap first.
 await db.query('DELETE FROM stockchief_runtime.sku_cost_totals WHERE workspace_id=$1',[ctx.workspaceId]);
 await db.query(`INSERT INTO stockchief_runtime.sku_cost_totals(workspace_id,sku_id,quantity_units,total_cost_minor)
  SELECT $1,'foreign-summary-'||n,1,100 FROM generate_series(1,500000)n`,[other.workspaceId]);
 await db.query(`INSERT INTO stockchief_runtime.sku_cost_totals(workspace_id,sku_id,quantity_units,total_cost_minor)
  SELECT $1,'empty-summary-'||n,0,0 FROM generate_series(1,49999)n
  UNION ALL SELECT $1,$2,4,400`,[ctx.workspaceId,f.item.skuIds[0]]);
 await db.query('ANALYZE stockchief_runtime.sku_cost_totals');
 const observations=[];
 function nodes(plan,out=[]){out.push(plan);for(const child of plan.Plans||[])nodes(child,out);return out;}
 for(const mode of ['force_generic_plan','force_custom_plan'])await db.transaction(async c=>{
  await c.query("SELECT set_config('plan_cache_mode',$1,true)",[mode]);
  const actual=(await c.query(summaries.totalsSql,[ctx.workspaceId])).rows[0];assert.equal(Number(actual.units),4);assert.equal(Number(actual.cost),400);
  const plan=(await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+summaries.totalsSql,[ctx.workspaceId])).rows[0]['QUERY PLAN'][0];
  const discarded=nodes(plan.Plan).filter(n=>n['Relation Name']==='sku_cost_totals'&&n['Actual Loops']>0)
   .reduce((sum,n)=>sum+Number(n['Rows Removed by Filter']||0)*n['Actual Loops'],0);
  t.diagnostic(JSON.stringify({mode,relations:nodes(plan.Plan).filter(n=>n['Relation Name']==='sku_cost_totals').map(n=>({node:n['Node Type'],index:n['Index Name'],rows:n['Actual Rows'],loops:n['Actual Loops'],filtered:n['Rows Removed by Filter']}))}));
  assert(discarded<100,'A tenant summary must not search unrelated summary rows for its first match: '+discarded);
  observations.push({mode,discardedForeignRows:discarded,executionMs:plan['Execution Time']});
 },{readOnly:true,jit:false});
 assert.equal(Number((await summaries.value(db,'missing-summary-inventory')).minor),0);
 t.diagnostic(JSON.stringify({foreignSummaryRows:500000,ownSummaryRows:50000,observations,sourceStockUnchanged:await f.balance()===4,paidCalls:0}));
});
