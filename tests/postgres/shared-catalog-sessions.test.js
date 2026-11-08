'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('shared catalogue sessions retain one import owner across parallel commits, rollback and coordinator loss',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:5});
 t.after(async()=>{await db.close();await cluster.stop();});
 await db.query('CREATE TABLE stock_lane_probe(lane integer PRIMARY KEY,value integer NOT NULL)');
 const key='catalog:shared-session-'+randomUUID();
 await t.test('independent sessions overlap while every exclusive contender remains excluded',async()=>{
  const together=deferred();let entered=0;
  await db.withSessionLock(key,async owner=>{
   await assert.rejects(owner.withSharedSession(()=>{}),e=>e.code==='55P03');
   await owner.shareLock();
   await Promise.all([1,2].map(lane=>owner.withSharedSession(async session=>{
    if(++entered===2)together.resolve();await together.promise;
    await session.transaction(c=>c.query('INSERT INTO stock_lane_probe VALUES($1,1)',[lane]),{isolation:'READ COMMITTED'});
    assert.deepEqual(await db.withSessionLock(key,()=>{throw Error('Another import entered');}),{busy:true});
   })));
   assert.equal(entered,2);assert.equal((await owner.query('SELECT count(*)::int n FROM stock_lane_probe')).rows[0].n,2);
  });
  assert.equal(await db.withSessionLock(key,async()=>true),true);
 });
 await t.test('a failing batch rolls back and releases every session lease',async()=>{
  await assert.rejects(db.withSessionLock(key,async owner=>{await owner.shareLock();await owner.withSharedSession(session=>session.transaction(async c=>{
   await c.query('INSERT INTO stock_lane_probe VALUES(3,1)');throw Error('Abort stock lane');
  },{isolation:'READ COMMITTED'}));}),/Abort stock lane/);
  assert.equal((await db.query('SELECT count(*)::int n FROM stock_lane_probe WHERE lane=3')).rows[0].n,0);
  assert.equal(await db.withSessionLock(key,async()=>true),true);
 });
 await t.test('existing lane ownership survives coordinator loss; no new lane joins a lost coordinator',async()=>{
  const ready=deferred(),finish=deferred();
  await db.withSessionLock(key,async owner=>{
   await owner.shareLock();const pid=(await owner.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const lane=owner.withSharedSession(async session=>{ready.resolve();await finish.promise;return session.transaction(c=>c.query('INSERT INTO stock_lane_probe VALUES(4,1)'),{isolation:'READ COMMITTED'});});
   try{
    await ready.promise;assert((await db.query('SELECT pg_terminate_backend($1) stopped',[pid])).rows[0].stopped);await new Promise(setImmediate);
    assert.deepEqual(await db.withSessionLock(key,()=>{throw Error('Coordinator loss admitted a second import');}),{busy:true});
    await assert.rejects(owner.withSharedSession(()=>{throw Error('Lost coordinator created a new lane');}),e=>e.code==='55P03');
   }finally{finish.resolve();await lane;}
  });
  assert.equal((await db.query('SELECT count(*)::int n FROM stock_lane_probe WHERE lane=4')).rows[0].n,1);
  assert.equal(await db.withSessionLock(key,async()=>true),true);
  assert(db.connectionErrors.some(e=>e.code==='57P01'));
 });
 await t.test('a terminated transaction connection fails its query and rolls back without an uncaught process error',async()=>{
  await assert.rejects(db.transaction(async c=>{
   await c.query('INSERT INTO stock_lane_probe VALUES(5,1)');const pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   await db.query('SELECT pg_terminate_backend($1)',[pid]);await new Promise(setImmediate);await c.query('SELECT 1');
  },{isolation:'READ COMMITTED'}),/terminat|connection|queryable/i);
  assert.equal((await db.query('SELECT count(*)::int n FROM stock_lane_probe WHERE lane=5')).rows[0].n,0);
  assert.equal((await db.query('SELECT 7 n')).rows[0].n,7);
 });
});
