'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('bulk receipt results commit with their stock once, remain invisible before commit, and roll back after a later failure',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,inventory=require('../../src/domain/postgres-inventory-engine');
 const inputs=Array.from({length:20},(_,n)=>({skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,idempotencyKey:'one-write-'+n})),before=await f.balance();
 let reach,release;const reached=new Promise(r=>reach=r),held=new Promise(r=>release=r),statements=[];
 const running=db.transaction(client=>inventory.receiveManyInTransaction({query:async(sql,...args)=>{statements.push(sql);if(sql.startsWith('UPDATE balances b SET on_hand=')){reach();await held;}return client.query(sql,...args);}},ctx,inputs),{isolation:'SERIALIZABLE',retrySafe:false});
 try{await Promise.race([reached,running.then(()=>{throw Error('Receipt finished before its held stock update.');})]);assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key LIKE 'one-write-%'",[ctx.workspaceId])).rows[0].n,0);assert.equal(await f.balance(),before);}finally{release();}
 const results=await running;assert.equal(await f.balance(),before+20);const saved=(await db.query("SELECT idempotency_key,status,result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key LIKE 'one-write-%' ORDER BY idempotency_key",[ctx.workspaceId])).rows;assert.equal(saved.length,20);
 for(const row of saved){assert.equal(row.status,'COMPLETED');assert.deepEqual(row.result,(({replayed,...result})=>result)(results[Number(row.idempotency_key.slice('one-write-'.length))]));}
 assert.equal(statements.filter(s=>s.startsWith('INSERT INTO stockchief_runtime.business_operations')).length,1);assert.equal(statements.filter(s=>s.startsWith('UPDATE stockchief_runtime.business_operations')).length,0);
 const replay=await db.transaction(c=>inventory.receiveManyInTransaction(c,ctx,inputs),{retrySafe:true});assert(replay.every(r=>r.replayed));assert.deepEqual(replay.map(r=>r.movementId),results.map(r=>r.movementId));assert.equal(await f.balance(),before+20);
 const failure=Error('Disposable failure after saving operation receipts');await assert.rejects(db.transaction(client=>inventory.receiveManyInTransaction({query:(sql,...args)=>{if(sql.startsWith('INSERT INTO movements('))throw failure;return client.query(sql,...args);}},ctx,inputs.map((v,n)=>({...v,idempotencyKey:'one-write-failed-'+n}))),{retrySafe:false}),error=>error===failure);
 assert.equal(await f.balance(),before+20);assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key LIKE 'one-write-failed-%'",[ctx.workspaceId])).rows[0].n,0);
});
