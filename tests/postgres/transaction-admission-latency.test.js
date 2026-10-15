'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('batched transaction admission preserves server-enforced isolation, timeouts, rollback and retry safety',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:6});
 t.after(async()=>{await db.close();await cluster.stop();});
 await db.query('CREATE TABLE admission_check(id integer PRIMARY KEY, quantity integer NOT NULL)');
 await db.query('INSERT INTO admission_check VALUES(1,0)');
 for(const isolation of ['SERIALIZABLE','REPEATABLE READ','READ COMMITTED']){
  const actual=await db.transaction(async client=>(await client.query(`SELECT
   current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
   current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout`)).rows[0],
   {isolation,readOnly:true,statementTimeoutMs:321,lockTimeoutMs:123});
  assert.deepEqual(actual,{isolation:isolation.toLowerCase(),read_only:'on',statement_timeout:'321ms',lock_timeout:'123ms'});
 }
 await assert.rejects(db.transaction(client=>client.query('UPDATE admission_check SET quantity=99 WHERE id=1'),{readOnly:true}),{code:'25006'});
 await assert.rejects(db.transaction(async client=>{await client.query('UPDATE admission_check SET quantity=99');throw Error('INTERRUPTED');}),/INTERRUPTED/);
 assert.equal((await db.query('SELECT quantity FROM admission_check')).rows[0].quantity,0);
 await assert.rejects(db.transaction(client=>client.query('SELECT pg_sleep(0.15)'),{statementTimeoutMs:30}),{code:'57014'});
 let unlock,locked;const ready=new Promise(resolve=>{locked=resolve;}),release=new Promise(resolve=>{unlock=resolve;});
 const holding=db.transaction(async client=>{await client.query('SELECT id FROM admission_check WHERE id=1 FOR UPDATE');locked();await release;});
 try{await ready;await assert.rejects(db.transaction(client=>client.query('UPDATE admission_check SET quantity=99 WHERE id=1'),{lockTimeoutMs:30}),{code:'55P03'});}
 finally{unlock();await holding;}
 await Promise.all(Array.from({length:8},()=>db.transaction(client=>client.query('UPDATE admission_check SET quantity=quantity+1 WHERE id=1'),{retrySafe:true})));
 assert.equal((await db.query('SELECT quantity FROM admission_check')).rows[0].quantity,8,'Serialization retries do not duplicate committed effects');
 const outside=(await db.query("SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout")).rows[0];
 assert.deepEqual(outside,{statement_timeout:'0',lock_timeout:'0'},'Transaction-local protections do not leak into pooled connections');
 for(const value of ['1; SELECT 1',-1,0,1.5,Infinity])await assert.rejects(db.transaction(()=>{}, {statementTimeoutMs:value}),/timeouts must be positive integer/);
 let reads=0;await db.transaction(client=>client.query('SELECT 1'),{get statementTimeoutMs(){return ++reads===1?30000:'0; COMMIT';}});
 assert.equal(reads,1,'Only the validated timeout value reaches SQL');
});
