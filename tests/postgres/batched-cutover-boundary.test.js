'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('batched operating guards retain cutover isolation, atomic refusal and concurrent workspace locking',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,cutover=require('../../src/onboarding/postgres-cutover');
 const pkg=await cutover.create(db,ctx,{sourceNamespace:'boundary:fixture',sourceLabel:'Boundary fixture',snapshotHash:'c'.repeat(64),manifest:{counts:Object.fromEntries(Object.keys(cutover.TYPES).map(type=>[type,0]))}});
 const engine=require('../../src/domain/postgres-inventory-engine'),sku=f.item.skuIds[0];
 const inputs=Array.from({length:2000},(_,n)=>({skuId:sku,locationId:f.location.id,quantity:1,idempotencyKey:'batched-boundary-'+n}));
 const rollback=Error('rollback measured guard'),plans=[];
 await assert.rejects(db.transaction(async c=>{
  const measured={...c,query:async(sql,values)=>{
   if(!sql.startsWith('INSERT INTO movements('))return c.query(sql,values);
   const explained=(await c.query('EXPLAIN(ANALYZE,FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0];
   const guard=explained.Triggers.filter(p=>p['Trigger Name'].startsWith('cutover_write_guard'));
   assert.equal(guard.length,1);assert.equal(guard[0].Calls,1,'A 2,000-row write checks its inventory once');plans.push({ms:explained['Execution Time'],guardMs:guard[0].Time,rows:2000});
   return {rowCount:2000};
  }};
  assert.equal((await engine.receiveManyInTransaction(measured,ctx,inputs)).length,2000);throw rollback;
 },{isolation:'READ COMMITTED'}),e=>e===rollback);
 const before=(await db.query('SELECT sum(on_hand)::text n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Other inventory',email:require('node:crypto').randomUUID()+'@example.test',password:'Other-fixture!'+require('node:crypto').randomUUID()});
 await db.query("INSERT INTO customers(id,workspace_id,name,record_state,created_by_user_id,created_at,updated_at) VALUES('other-boundary-customer',$1,'Other customer','ACTIVE',$2,now(),now())",[other.workspaceId,other.userId]);
 await db.query('UPDATE workspaces SET active_cutover_id=$2 WHERE id=$1',[ctx.workspaceId,pkg.id]);
 await assert.rejects(db.transaction(c=>engine.receiveManyInTransaction(c,ctx,inputs),{isolation:'READ COMMITTED'}),/completing its ERP cutover/);
 assert.equal((await db.query('SELECT sum(on_hand)::text n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before,'A refused statement preserves all stock');
 await assert.rejects(db.query('UPDATE items SET name=$2 WHERE id=$1',[f.item.itemId,'Blocked name']),/completing its ERP cutover/);
 await assert.rejects(db.query('DELETE FROM customers WHERE workspace_id=$1',[ctx.workspaceId]),/completing its ERP cutover/);
 await assert.rejects(db.query("UPDATE customers SET name='Cross-inventory change' WHERE workspace_id=ANY($1::text[])",[[ctx.workspaceId,other.workspaceId]]),/completing its ERP cutover/);
 assert.equal((await db.query("SELECT name FROM customers WHERE id='other-boundary-customer'")).rows[0].name,'Other customer','A mixed-inventory statement is refused atomically');
 await db.transaction(async c=>{await c.query("SELECT set_config('stockchief.cutover_package_id',$1,true)",[pkg.id]);assert.equal((await c.query('UPDATE items SET name=$2 WHERE id=$1',[f.item.itemId,'Approved cutover name'])).rowCount,1);});
 // An in-flight ordinary writer retains a shared inventory lock through commit,
 // so a cutover cannot start and take its snapshot between the write and commit.
 await db.query('UPDATE workspaces SET active_cutover_id=NULL WHERE id=$1',[ctx.workspaceId]);
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),started=Promise.withResolvers();
 const writer=db.transaction(async c=>{assert.equal((await c.query('UPDATE items SET name=$2 WHERE id=$1',[f.item.itemId,'Concurrent writer'])).rowCount,1);entered.resolve();await release.promise;},{isolation:'READ COMMITTED'});let activating;
 try{await entered.promise;activating=db.transaction(async c=>{started.resolve((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);await c.query('UPDATE workspaces SET active_cutover_id=$2 WHERE id=$1',[ctx.workspaceId,pkg.id]);},{isolation:'READ COMMITTED',lockTimeoutMs:10000});
  const pid=await started.promise;let blocked=false;for(let n=0;n<100&&!blocked;n++){blocked=(await db.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked;if(!blocked)await new Promise(r=>setTimeout(r,10));}assert(blocked,'Cutover waits for the operating writer');
 }finally{release.resolve();await writer;if(activating)await activating;}
 await assert.rejects(db.transaction(c=>engine.receiveManyInTransaction(c,ctx,inputs),{isolation:'READ COMMITTED'}),/completing its ERP cutover/);
 await db.query('UPDATE workspaces SET active_cutover_id=NULL WHERE id=$1',[ctx.workspaceId]);
 assert.equal((await db.query("SELECT count(*)::int n FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.proname='stockchief_batch_cutover_write_guard' AND (t.tgtype&1)=0")).rows[0].n,78);
 t.diagnostic(JSON.stringify({plans,atomicRefusal:true,cutoverAuthorizationPreserved:true,concurrentBoundaryPreserved:true}));
});
