'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('shared summaries coalesce concurrent reads, invalidate on committed stock changes, and never cache authorization',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,cache=require('../../src/lib/versioned-read-model'),requestCache=require('../../src/lib/request-read-cache');let computations=0;
 const subscribers=new Map(),subscribe=db.subscribe;db.subscribe=(channel,callback,options)=>subscribe(channel,message=>{callback(message);const token=JSON.parse(message.payload).barrier;subscribers.get(token)?.();},options);
 const settleCommittedNotifications=async()=>{const token=require('node:crypto').randomUUID();let resolve;const delivered=new Promise(r=>resolve=r);subscribers.set(token,resolve);await db.query("SELECT pg_notify('stockchief_read_models',$1)",[JSON.stringify({workspace:'wsp_cachetestbarrier',business:false,barrier:token})]);let timer;try{await Promise.race([delivered,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Commit notification barrier was not delivered')),2000);})]);}finally{clearTimeout(timer);subscribers.delete(token);}};
 const read=()=>requestCache.run(()=>cache.read(db,ctx.workspaceId,['test-stock'],async()=>{computations++;await new Promise(r=>setTimeout(r,20));return {units:Number((await db.query('SELECT sum(on_hand) n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),rows:[{name:'Canonical'}]};}));
 const many=await Promise.all(Array.from({length:50},read));assert.equal(computations,1);assert(many.every(r=>r.units===4));many[0].rows[0].name='Changed locally';assert.equal((await read()).rows[0].name,'Canonical');
 await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:3,unitCost:'1',idempotencyKey:'cached-restock'});assert.equal((await read()).units,7);assert.equal(computations,2);
 await settleCommittedNotifications();await read();const settledComputations=computations;
 await assert.rejects(db.transaction(async c=>{await c.query('UPDATE balances SET on_hand=100 WHERE workspace_id=$1',[ctx.workspaceId]);throw Error('Roll back the fixture transaction');}),/Roll back/);await settleCommittedNotifications();assert.equal((await read()).units,7);assert.equal(computations,settledComputations,'A rolled-back source update must not invalidate a committed summary');
 const reports=require('../../src/reports/postgres-service'),spec={dataset:'stock',groups:['sku'],aggregate:'sum',measure:'on_hand'};await reports.run(db,ctx,{role:'owner'},spec);await assert.rejects(reports.run(db,ctx,{role:'viewer',permissions:'[]'},spec),/permission|allowed|access/i);
 const original=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);await db.query("UPDATE users SET role='viewer',permissions='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);const restricted=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);assert(restricted.every(r=>!['accounting','purchase','approval'].includes(r.kind)));await db.query('UPDATE users SET role=$3,permissions=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId,original.role,original.permissions]);
 const clock=await require('../../src/lib/business-time').today(db,ctx.workspaceId),money=require('../../src/accounting/customer-money');const first=await money.snapshot(db,ctx.workspaceId,{summary:true,from:clock,to:clock});first.revenueMinor=-1;const again=await money.snapshot(db,ctx.workspaceId,{summary:true,from:clock,to:clock});assert.notEqual(again.revenueMinor,-1);await require('../../src/accounting/postgres-ledger').post(db,ctx,{postingDate:clock,sourceKey:'cache-expense',sourceType:'manual_expense',description:'Test committed summary invalidation',currency:'USD',lines:[{accountKey:'RENT_EXPENSE',debitMinor:100},{accountKey:'CASH',creditMinor:100}]});const after=await money.snapshot(db,ctx.workspaceId,{summary:true,from:clock,to:clock});assert.equal(after.pnl.netIncomeMinor,again.pnl.netIncomeMinor-100);
 await t.test('separate max-one-connection readers see committed changes and recover their listener',async()=>{
  const reader=require('../../src/db/postgres').openPostgres(f.cluster.connectionString,{max:1,applicationName:'cache-notification-reader'});t.after(()=>reader.close());
  const skuId=f.item.skuIds[0];let computations=0;const value=()=>cache.read(reader,ctx.workspaceId,['other-process'],async()=>{computations++;return (await reader.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId])).rows[0].code;});
  assert(await value());assert(cache.status(reader).listenerConnected);
  await db.query("UPDATE skus SET code='CACHE-CROSS-PROCESS' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,skuId]);
  let observed;for(let n=0;n<100;n++){observed=await value();if(observed==='CACHE-CROSS-PROCESS')break;await new Promise(r=>setTimeout(r,10));}assert.equal(observed,'CACHE-CROSS-PROCESS');
  const before=computations;await assert.rejects(db.transaction(async c=>{await c.query("UPDATE skus SET code='CACHE-ROLLBACK' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,skuId]);throw Error('rollback notify');}),/rollback notify/);
  await new Promise(r=>setTimeout(r,30));assert.equal(await value(),'CACHE-CROSS-PROCESS');assert.equal(computations,before);
  const generation=cache.status(reader).listenerGeneration,killed=(await db.query("SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE datname=current_database() AND application_name='cache-notification-reader:listen' AND pid<>pg_backend_pid()")).rows;assert.equal(killed.length,1);assert(killed[0].stopped);
  await db.query("UPDATE skus SET code='CACHE-RECONNECTED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,skuId]);
  for(let n=0;n<500;n++){if(cache.status(reader).listenerConnected&&cache.status(reader).listenerGeneration>generation)break;await new Promise(r=>setTimeout(r,10));}assert(cache.status(reader).listenerConnected);assert(cache.status(reader).listenerGeneration>generation);assert.equal(await value(),'CACHE-RECONNECTED');
  assert.equal((await db.query("SELECT relkind FROM pg_class WHERE oid='stockchief_runtime.read_model_changes'::regclass")).rows[0].relkind,'v','The physical pending-change queue is gone');
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.read_model_changes')).rows[0].n,0);
  assert.equal((await db.query(`WITH chosen AS MATERIALIZED(SELECT id FROM stockchief_runtime.read_model_changes ORDER BY id LIMIT 5000 FOR UPDATE SKIP LOCKED),folded AS(DELETE FROM stockchief_runtime.read_model_changes c USING chosen WHERE c.id=chosen.id RETURNING c.workspace_id,c.business)
   INSERT INTO stockchief_runtime.read_model_versions AS v(workspace_id,revision,business_revision) SELECT workspace_id,count(*),count(*) FILTER(WHERE business) FROM folded GROUP BY workspace_id ON CONFLICT(workspace_id) DO UPDATE SET revision=v.revision+EXCLUDED.revision,business_revision=v.business_revision+EXCLUDED.business_revision RETURNING workspace_id`)).rowCount,0,'A draining old fold remains harmless');
  assert((await require('../../src/lib/retire-read-model-compatibility').retire(db)).retired);assert((await require('../../src/lib/retire-read-model-compatibility').retire(db)).alreadyRemoved);assert.equal(await value(),'CACHE-RECONNECTED');
 });
 await t.test('business writes do not wait for the workspace cache revision row',async()=>{
  await db.query('INSERT INTO stockchief_runtime.read_model_versions(workspace_id,revision,business_revision) VALUES($1,0,0) ON CONFLICT DO NOTHING',[ctx.workspaceId]);let unlock,ready;
  const release=new Promise(r=>unlock=r),locked=new Promise(r=>ready=r);
  const holder=db.transaction(async c=>{await c.query('SELECT workspace_id FROM stockchief_runtime.read_model_versions WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId]);ready();await release;},{isolation:'READ COMMITTED'});
  await locked;try{await db.transaction(c=>c.query('UPDATE skus SET code=code WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.skuIds[0]]),{isolation:'READ COMMITTED',lockTimeoutMs:500});}finally{unlock();await holder;}
 });
 await t.test('a late commit invalidates after another independent writer commits without any fold',async()=>{
  const other=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Independent cache writer',baseCode:'CACHE-OTHER',trackingMode:'quantity'});
  let unlock,ready;
  const release=new Promise(r=>unlock=r),pending=new Promise(r=>ready=r),skuId=f.item.skuIds[0];
  const value=()=>requestCache.run(()=>cache.read(db,ctx.workspaceId,['late-commit'],async()=>(await db.query('SELECT code FROM skus WHERE id=$1 AND workspace_id=$2',[skuId,ctx.workspaceId])).rows[0].code));
  const before=await value();
  const late=db.transaction(async c=>{await c.query('UPDATE skus SET code=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId,'CACHE-LATE']);ready();await release;},{isolation:'READ COMMITTED'});
  await pending;try{
   await db.transaction(c=>c.query('UPDATE skus SET code=code WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,other.skuIds[0]]),{isolation:'READ COMMITTED'});
   assert.equal(await value(),before);
  }finally{unlock();await late;}
  assert.equal(await value(),'CACHE-LATE');
 });
});
