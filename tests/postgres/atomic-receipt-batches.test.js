'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

test('atomic receipt batches retain every movement with one durable idempotency receipt, exact replay and rollback',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,inventory=require('../../src/domain/postgres-inventory-engine');
 const inputs=Array.from({length:20},(_,n)=>({skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,idempotencyKey:'atomic-source-'+n}));
 const before=await f.balance();let reach,release;const reached=new Promise(r=>reach=r),held=new Promise(r=>release=r);
 const running=db.transaction(async c=>{const result=await inventory.receiveBatchInTransaction(c,ctx,inputs,'atomic-first');reach();await held;return result;},{isolation:'READ COMMITTED'});
 try{await Promise.race([reached,running.then(()=>{throw Error('Receipt committed before the held boundary');})]);assert.equal(await f.balance(),before);assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key='atomic-first'",[ctx.workspaceId])).rows[0].n,0);}finally{release();}
 const result=await running;assert.equal(await f.balance(),before+20);assert.equal(new Set(result.map(r=>r.movementId)).size,20);
 const saved=(await db.query("SELECT kind,status,result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key='atomic-first'",[ctx.workspaceId])).rows;assert.equal(saved.length,1);assert.equal(saved[0].kind,'inventory.receive-batch');assert.equal(saved[0].status,'COMPLETED');assert.deepEqual(saved[0].result.receipts,result);assert.match(saved[0].result.fingerprint,/^[a-f0-9]{64}$/);
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key LIKE 'atomic-source-%'",[ctx.workspaceId])).rows[0].n,0);
 const reordered=inputs.map(i=>({quantity:'1',locationId:i.locationId,skuId:i.skuId,idempotencyKey:i.idempotencyKey}));
 const replay=await db.transaction(c=>inventory.receiveBatchInTransaction(c,ctx,reordered,'atomic-first'),{isolation:'READ COMMITTED'});assert(replay.every(r=>r.replayed));assert.deepEqual(replay.map(r=>r.movementId),result.map(r=>r.movementId));assert.equal(await f.balance(),before+20);
 await assert.rejects(db.transaction(c=>inventory.receiveBatchInTransaction(c,ctx,inputs.map((i,n)=>n?i:{...i,quantity:2}),'atomic-first'),{isolation:'READ COMMITTED'}),/different rows/);assert.equal(await f.balance(),before+20);
 const concurrentInputs=inputs.map((i,n)=>({...i,idempotencyKey:'atomic-concurrent-source-'+n}));
 const concurrent=await Promise.all([0,1].map(()=>db.transaction(c=>inventory.receiveBatchInTransaction(c,ctx,concurrentInputs,'atomic-concurrent'),{isolation:'READ COMMITTED'})));assert.equal(await f.balance(),before+40);assert.deepEqual(concurrent[0].map(r=>r.movementId),concurrent[1].map(r=>r.movementId));assert.equal(concurrent.filter(rows=>rows.every(r=>r.replayed)).length,1);
 await assert.rejects(db.transaction(async c=>{await inventory.receiveBatchInTransaction(c,ctx,inputs.map((i,n)=>({...i,idempotencyKey:'atomic-rollback-source-'+n})),'atomic-rollback');throw Error('Later journal failed');},{isolation:'READ COMMITTED'}),/Later journal failed/);assert.equal(await f.balance(),before+40);assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key='atomic-rollback'",[ctx.workspaceId])).rows[0].n,0);
 await assert.rejects(db.transaction(c=>inventory.receiveBatchInTransaction(c,ctx,[{...inputs[0],skuId:'missing-sku'}],'atomic-invalid-target'),{isolation:'READ COMMITTED'}),/not in this inventory/);
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key='atomic-invalid-target'",[ctx.workspaceId])).rows[0].n,0);assert.equal(await f.balance(),before+40);
});

test('batch receipts preserve legacy row replays and private batch authority cannot be forged',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,inventory=require('../../src/domain/postgres-inventory-engine'),before=await f.balance();
 const inputs=[0,1].map(n=>({skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,idempotencyKey:'legacy-mixed-'+n}));
 const prior=await db.transaction(c=>inventory.receiveManyInTransaction(c,ctx,[inputs[0]]));
 const mixed=await db.transaction(c=>inventory.receiveBatchInTransaction(c,ctx,inputs,'legacy-mixed-batch'));assert.equal(await f.balance(),before+2);assert.equal(mixed[0].movementId,prior[0].movementId);assert.equal(mixed[0].replayed,true);
 const forged=inputs.map((i,n)=>({...i,idempotencyKey:'forged-source-'+n}));await db.transaction(c=>inventory.receiveManyInTransaction(c,ctx,forged,Symbol('atomic inventory receipt batch')));assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key LIKE 'forged-source-%'",[ctx.workspaceId])).rows[0].n,2);
 await assert.rejects(db.transaction(c=>inventory.receiveBatchInTransaction(c,{...ctx,actorId:'other-actor'},inputs,'legacy-mixed-batch')),error=>error.name==='AuthorizationError');
});
