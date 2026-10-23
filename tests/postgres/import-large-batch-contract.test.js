'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('five thousand unfamiliar products use bounded canonical batches and reconcile stock, value, identity and replay',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Batch owner',businessName:'Randomized catalog',email:randomUUID()+'@example.test',password:randomUUID()+'!A'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const salt=randomUUID().slice(0,8),csv=['Name,SKU,Location,Qty,Cost,Selling price,Supplier,Lead time days,Category,Reorder level,Target stock,Source tag',...Array.from({length:5000},(_,i)=>`Product ${salt} ${i},${salt}-${i},Count room,${i%7+1},1.25,${i%2?'0':'3.75'},Supplier ${salt} ${i%5},14,Unfamiliar group,2,10,${salt} detail ${i}`)].join('\n');
 const service=require('../../src/imports/postgres-service');const plan=await service.analyse(db,ctx,{text:csv,allowModel:false});assert.equal(plan.recordsValid,5000);await service.approve(db,ctx,plan.id,plan.integrityHash);
 let queries=0;const transaction=db.transaction.bind(db);const measured={...db,transaction:(fn,options)=>transaction(c=>fn({query:(...args)=>{queries++;return c.query(...args);}}),options)};
 const started=performance.now(),result=await service.execute(measured,ctx,plan.id);const elapsed=performance.now()-started;
 assert(result.verified);assert.equal(result.itemsCreated,5000);assert.equal(result.skusCreated,5000);assert.equal(result.rowsImported,5000);
 assert(queries<1500,`Expected bounded operations, observed ${queries} database round trips`);
 const state=(await db.query(`SELECT (SELECT count(*) FROM items WHERE workspace_id=$1 AND base_code IS NOT NULL)::int AS codes,
   (SELECT sum(on_hand) FROM balances WHERE workspace_id=$1)::bigint AS units,
   (SELECT sum(total_cost_minor) FROM accounting_inventory_cost_balances WHERE workspace_id=$1)::bigint AS value`,[ctx.workspaceId])).rows[0];
 assert.equal(state.codes,5000);assert.equal(Number(state.units),result.units);assert.equal(Number(state.value),result.units*125);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM supplier_items WHERE workspace_id=$1 AND lead_time_days=14',[ctx.workspaceId])).rows[0].n,5000);assert.equal((await db.query('SELECT count(*)::int AS n FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,5000);assert.equal((await require('../../src/domain/postgres-catalog-facts').exportRows(db,ctx.workspaceId)).filter(f=>f.name==='Source tag').length,5000);
 assert((await service.execute(db,ctx,plan.id)).duplicate);
 t.diagnostic(JSON.stringify({products:5000,executionMilliseconds:Math.round(elapsed),databaseRoundTrips:queries,units:result.units,valueMinor:Number(state.value),verified:true,provider:'none',paidCalls:0}));
});
