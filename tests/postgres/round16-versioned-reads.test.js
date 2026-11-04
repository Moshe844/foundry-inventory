'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('shared summaries coalesce concurrent reads, invalidate on committed stock changes, and never cache authorization',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,cache=require('../../src/lib/versioned-read-model'),requestCache=require('../../src/lib/request-read-cache');let computations=0;
 const read=()=>requestCache.run(()=>cache.read(db,ctx.workspaceId,['test-stock'],async()=>{computations++;await new Promise(r=>setTimeout(r,20));return {units:Number((await db.query('SELECT sum(on_hand) n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),rows:[{name:'Canonical'}]};}));
 const many=await Promise.all(Array.from({length:50},read));assert.equal(computations,1);assert(many.every(r=>r.units===4));many[0].rows[0].name='Changed locally';assert.equal((await read()).rows[0].name,'Canonical');
 await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:3,unitCost:'1',idempotencyKey:'cached-restock'});assert.equal((await read()).units,7);assert.equal(computations,2);
 await assert.rejects(db.transaction(async c=>{await c.query('UPDATE balances SET on_hand=100 WHERE workspace_id=$1',[ctx.workspaceId]);throw Error('Roll back the fixture transaction');}),/Roll back/);assert.equal((await read()).units,7);assert.equal(computations,2,'A rolled-back source update must not invalidate a committed summary');
 const reports=require('../../src/reports/postgres-service'),spec={dataset:'stock',groups:['sku'],aggregate:'sum',measure:'on_hand'};await reports.run(db,ctx,{role:'owner'},spec);await assert.rejects(reports.run(db,ctx,{role:'viewer',permissions:'[]'},spec),/permission|allowed|access/i);
 const original=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);await db.query("UPDATE users SET role='viewer',permissions='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);const restricted=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);assert(restricted.every(r=>!['accounting','purchase','approval'].includes(r.kind)));await db.query('UPDATE users SET role=$3,permissions=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId,original.role,original.permissions]);
 const clock=await require('../../src/lib/business-time').today(db,ctx.workspaceId),money=require('../../src/accounting/customer-money');const first=await money.snapshot(db,ctx.workspaceId,{summary:true,from:clock,to:clock});first.revenueMinor=-1;const again=await money.snapshot(db,ctx.workspaceId,{summary:true,from:clock,to:clock});assert.notEqual(again.revenueMinor,-1);await require('../../src/accounting/postgres-ledger').post(db,ctx,{postingDate:clock,sourceKey:'cache-expense',sourceType:'manual_expense',description:'Test committed summary invalidation',currency:'USD',lines:[{accountKey:'RENT_EXPENSE',debitMinor:100},{accountKey:'CASH',creditMinor:100}]});const after=await money.snapshot(db,ctx.workspaceId,{summary:true,from:clock,to:clock});assert.equal(after.pnl.netIncomeMinor,again.pnl.netIncomeMinor-100);
 await t.test('business writes do not wait for the workspace cache revision row',async()=>{
  await cache.foldChanges(db);let unlock,ready;
  const release=new Promise(r=>unlock=r),locked=new Promise(r=>ready=r);
  const holder=db.transaction(async c=>{await c.query('SELECT workspace_id FROM stockchief_runtime.read_model_versions WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId]);ready();await release;},{isolation:'READ COMMITTED'});
  await locked;try{await db.transaction(c=>c.query('UPDATE skus SET code=code WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.skuIds[0]]),{isolation:'READ COMMITTED',lockTimeoutMs:500});}finally{unlock();await holder;}
 });
 await t.test('late commits with older sequence IDs still invalidate after background folding',async()=>{
  const other=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Independent cache writer',baseCode:'CACHE-OTHER',trackingMode:'quantity'});
  await cache.foldChanges(db);let unlock,ready;
  const release=new Promise(r=>unlock=r),pending=new Promise(r=>ready=r),skuId=f.item.skuIds[0];
  const value=()=>requestCache.run(()=>cache.read(db,ctx.workspaceId,['late-commit'],async()=>(await db.query('SELECT code FROM skus WHERE id=$1 AND workspace_id=$2',[skuId,ctx.workspaceId])).rows[0].code));
  const before=await value();
  const late=db.transaction(async c=>{await c.query('UPDATE skus SET code=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId,'CACHE-LATE']);ready();await release;},{isolation:'READ COMMITTED'});
  await pending;try{
   await db.transaction(c=>c.query('UPDATE skus SET code=code WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,other.skuIds[0]]),{isolation:'READ COMMITTED'});
   await cache.foldChanges(db);assert.equal(await value(),before);
  }finally{unlock();await late;}
  assert.equal(await value(),'CACHE-LATE');await cache.foldChanges(db);assert.equal(await value(),'CACHE-LATE');
 });
});
