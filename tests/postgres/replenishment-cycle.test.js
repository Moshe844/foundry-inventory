'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('replenishment coalesces stock changes, defers imports and avoids the quota/source-version deadlock',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const auto=require('../../src/autopilot/postgres-service'),cycle=require('../../src/purchasing/postgres-replenishment-cycle');
 const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
 const item=await catalog.createItem(db,ctx,{name:'Cycle coffee',baseCode:'CYCLE',trackingMode:'quantity'}),skuId=item.skuIds[0];
 await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId,lastUnitCost:40,isPreferred:true});
 await db.transaction(c=>require('../../src/operations/postgres-reorder-policies').setManyInTransaction(c,ctx,[{skuId,locationId:f.location.id,reorderPoint:5,targetStock:10}]));
 await auto.plan(db,ctx.workspaceId);
 await t.test('a burst changes the inventory revision once while every affected approval expires immediately',async()=>{
  const at=Date.now();await receipt.receive(db,ctx,{skuId,locationId:f.location.id,quantity:1,unitCost:'40',idempotencyKey:'cycle-first'});
  const first=await auto.getState(db,ctx.workspaceId);
  for(let n=0;n<5;n++)await receipt.receive(db,ctx,{skuId,locationId:f.location.id,quantity:1,unitCost:'40',idempotencyKey:'cycle-burst-'+n});
  const last=await auto.getState(db,ctx.workspaceId);assert.equal(last.replenishmentRevision,first.replenishmentRevision);assert.equal(last.nextEvaluationAt,first.nextEvaluationAt);
  assert(new Date(first.nextEvaluationAt).getTime()>=at+290000,'At least five minutes between evaluations');
  assert.equal(Number((await db.query("SELECT count(*) n FROM work_items WHERE workspace_id=$1 AND execution_status IN('AUTHORIZED','WAITING_FOR_APPROVAL') AND recommended_action::jsonb->>'skuId'=$2",[ctx.workspaceId,skuId])).rows[0].n),0);
 });
 await t.test('the actual scheduled handler skips an active import before any planning or forecasting read',async()=>{
  const imports=require('../../src/imports/postgres-service'),plan=await imports.analyse(db,ctx,{text:'Product,SKU,Cost,Price\nCycle coffee,CYCLE,40,100',allowModel:false});await imports.approve(db,ctx,plan.id,plan.integrityHash);
  await db.query(`INSERT INTO import_executions(id,workspace_id,import_id,idempotency_key,executed_by_user_id,status,started_at) VALUES('cycle-import',$1,$2,'cycle-import',$3,'EXECUTING',$4)`,[ctx.workspaceId,plan.id,ctx.actorId,new Date().toISOString()]);
  await db.query("UPDATE import_executions SET started_at='2020-01-01T00:00:00.000Z' WHERE id='cycle-import'");
  await db.query('UPDATE import_plans SET apply_checkpoint=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id,JSON.stringify({updatedAt:new Date().toISOString()})]);
  let planning=0;const result=await db.transaction(c=>require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate({id:'cycle-active-job',workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId}}, {query:async(sql,args)=>{if(sql.includes('WITH demand_eligible')||sql.includes('INSERT INTO stockchief_runtime.replenishment_planning_demand'))planning++;return c.query(sql,args);}}));
  assert.equal(result.skipped,'import_in_progress');assert.equal(planning,0);
  await db.transaction(c=>require('../../src/operations/postgres-runtime-handlers').runtimeSweep({payload:{}},c));
  assert.equal((await db.query("SELECT status FROM import_executions WHERE id='cycle-import'")).rows[0].status,'EXECUTING','A fresh batch checkpoint survives stale-worker recovery even after 15 minutes');
  // Recovery will expire abandoned executions, and they must not hold planning.
  await db.query("UPDATE import_executions SET started_at='2020-01-01T00:00:00.000Z' WHERE id='cycle-import'");
  await db.query('UPDATE import_plans SET apply_checkpoint=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id,JSON.stringify({updatedAt:'2020-01-01T00:00:00.000Z'})]);
  const resumed=await db.transaction(c=>cycle.begin(c,ctx.workspaceId,'cycle-after-import'));assert(!resumed.skipped);
  const debounced=await db.transaction(c=>cycle.begin(c,ctx.workspaceId,'cycle-too-soon'));assert.equal(debounced.skipped,'planning_debounced');
  assert.equal((await db.transaction(c=>cycle.begin(c,ctx.workspaceId,'old-cycle',{continuation:true}))).skipped,'superseded_planning_cycle');
  const manual=await db.transaction(c=>cycle.begin(c,ctx.workspaceId,'manual-cycle',{requestedByUser:true}));assert(!manual.skipped,'An explicit user request bypasses automatic debounce after imports stop');
  await db.query("UPDATE import_executions SET status='CANCELLED' WHERE id='cycle-import'");
  const progress=require('../../src/operations/postgres-maintenance-progress'),queue=require('../../src/operations/postgres-job-queue');
  const requested=await progress.request(db,ctx),again=await progress.request(db,ctx);assert.equal(requested.id,again.id,'Repeated clicks coalesce');
  const requestedJob=await queue.get(db,requested.id,ctx.workspaceId);assert.equal(requestedJob.payload.requestedByUser,true);
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const finished=await queue.processOne(db,{'autopilot.evaluate':handlers['autopilot.evaluate']},{owner:'manual-review-regression'});
  assert.equal(finished.status,'COMPLETED');assert.equal(finished.result.skipped,undefined,'A manual request must actually plan, not report a throttled check as complete');
 });
 await t.test('a planner waiting on an account quota never holds the source-version lock needed by a stock writer',async()=>{
  await require('../../src/domain/postgres-inventory-engine').issue(db,ctx,{skuId,locationId:f.location.id,quantity:5,idempotencyKey:'cycle-before-lock-order'});
  await auto.plan(db,ctx.workspaceId); // Clear the dirty flag before this interleaving.
  let holdReady,persistReady;const holding=new Promise(r=>holdReady=r),persisting=new Promise(r=>persistReady=r);
  const stock=db.transaction(async c=>{await cycle.lockStorageOwner(c,ctx.workspaceId);holdReady();await persisting;
   await receipt.receive({query:c.query.bind(c),transaction:fn=>fn(c)},ctx,{skuId,locationId:f.location.id,quantity:1,unitCost:'40',idempotencyKey:'cycle-lock-order'});
  },{isolation:'READ COMMITTED',statementTimeoutMs:5000,lockTimeoutMs:3000});
  await holding;
  const wrapped={query:async(sql,args)=>{if(sql.includes('pg_advisory_xact_lock'))persistReady();return db.query(sql,args);},transaction:(fn,options)=>db.transaction(c=>fn({query:async(sql,args)=>{if(sql.includes('WITH quota_lock AS'))persistReady();return c.query(sql,args);}}),options)};
  const planning=auto.plan(wrapped,ctx.workspaceId);
  await Promise.all([stock,planning]);
  const live=(await db.query("SELECT recommended_action::jsonb action FROM work_items WHERE workspace_id=$1 AND execution_status IN('AUTHORIZED','WAITING_FOR_APPROVAL') AND recommended_action::jsonb->>'skuId'=$2",[ctx.workspaceId,skuId])).rows;
  assert.equal(live.length,1);assert.equal(live[0].action.quantity,8,'The new suggestion includes the concurrent receipt');
 });
 await t.test('typed demand timestamps include offset dates, exclude old/future issues and use a time-range index',async()=>{
  await receipt.receive(db,ctx,{skuId,locationId:f.location.id,quantity:6,unitCost:'40',idempotencyKey:'cycle-timed-stock'});
  const times=[new Date(Date.now()-91*86400000).toISOString(),new Date(Date.now()-3600000).toISOString().replace('Z','+00:00'),new Date(Date.now()-1800000).toISOString(),new Date(Date.now()+86400000).toISOString()];
  for(let n=0;n<times.length-1;n++)await require('../../src/domain/postgres-inventory-engine').issue(db,ctx,{skuId,locationId:f.location.id,quantity:1,occurredAt:times[n],idempotencyKey:'cycle-timed-'+n});
  await assert.rejects(require('../../src/domain/postgres-inventory-engine').issue(db,ctx,{skuId,locationId:f.location.id,quantity:1,occurredAt:times.at(-1),idempotencyKey:'cycle-timed-future'}),/cannot be in the future/);
  const rows=await require('../../src/purchasing/postgres-replenishment-state').rows(db,ctx.workspaceId,{onlySkuIds:[skuId]});
  // The earlier lock-order scenario also issued five units today.
  assert.equal(Number(rows[0].issue_events),3);assert.equal(Number(rows[0].issued),7);
  const plan=await db.transaction(async c=>{await c.query('SET LOCAL enable_seqscan=off');return (await c.query(`EXPLAIN (FORMAT JSON) SELECT sku_id FROM stockchief_runtime.replenishment_demand_events WHERE workspace_id=$1 AND occurred_at>=CURRENT_TIMESTAMP-interval '90 days' AND occurred_at<=CURRENT_TIMESTAMP`,[ctx.workspaceId])).rows;},{readOnly:true});
  const text=JSON.stringify(plan);assert.match(text,/replenishment_demand_window/);assert.match(text,/Index Cond.*occurred_at/);
 });
});
