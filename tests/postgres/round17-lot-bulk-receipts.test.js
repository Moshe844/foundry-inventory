'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('lot receipts batch identities and movements while preserving metadata, replay, isolation and rollback',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),inventory=require('../../src/domain/postgres-inventory-engine');
 const item=await catalog.createItem(db,ctx,{name:'Food batch fixture',baseCode:'BULK-FOOD',trackingMode:'lot'});
 const inputs=Array.from({length:1000},(_,n)=>({skuId:item.skuIds[0],locationId:f.location.id,quantity:2,lotCode:'BATCH-'+Math.floor(n/2),expiresAt:'2027-12-31',idempotencyKey:'batch-lot-'+n}));
 const statements=[],run=commands=>db.transaction(c=>inventory.receiveManyInTransaction({query:(sql,...args)=>{statements.push(sql);return c.query(sql,...args);}},ctx,commands),{isolation:'SERIALIZABLE',retrySafe:true});
 const result=await run(inputs),initialQueries=statements.length;assert.equal(result.length,1000);assert.equal(new Set(result.map(r=>r.lotId)).size,500);assert(result.every(r=>r.lotId));assert.equal(result.at(-1).balanceAfter,2000);
 assert(statements.length<45,`Lot receipt queries must stay bounded: ${statements.length}`);assert.equal(statements.filter(s=>s.startsWith('INSERT INTO movements(')).length,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM lots WHERE workspace_id=$1 AND sku_id=$2 AND expires_at=$3',[ctx.workspaceId,item.skuIds[0],'2027-12-31'])).rows[0].n,500);
 assert.equal((await db.query('SELECT sum(quantity)::text n FROM lot_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'2000');
 const replay=await run(inputs);assert(replay.every(r=>r.replayed));assert.deepEqual(replay.map(r=>r.movementId),result.map(r=>r.movementId));
 await run([{...inputs[0],quantity:1,expiresAt:'2028-01-01',idempotencyKey:'batch-existing-metadata'}]);assert.equal((await db.query('SELECT expires_at FROM lots WHERE id=$1',[result[0].lotId])).rows[0].expires_at,'2027-12-31');
 const before=await f.balance();await assert.rejects(run([{...inputs[0],lotCode:'ROLLBACK-BATCH',idempotencyKey:'lot-rollback-first'},{...inputs[1],lotId:'foreign-lot',idempotencyKey:'lot-rollback-invalid'}]),/not in this inventory item/);assert.equal(await f.balance(),before);assert.equal((await db.query("SELECT count(*)::int n FROM lots WHERE workspace_id=$1 AND code='ROLLBACK-BATCH'",[ctx.workspaceId])).rows[0].n,0);
 await assert.rejects(run([{...inputs[0],lotCode:null,idempotencyKey:'lot-required'}]),/Lot or batch number is required/);
 await assert.rejects(run([{...inputs[0],lotCode:'BAD-DATE',expiresAt:'2026-02-30',idempotencyKey:'lot-invalid-date'}]),/real calendar date/);
 t.diagnostic(JSON.stringify({rows:1000,uniqueLots:500,initialQueries,paidCalls:0}));
});
