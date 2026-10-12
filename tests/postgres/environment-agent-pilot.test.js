'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixtures=require('../../scripts/environment-agent-demo/pilot-fixtures');
test('six held-out pilot fixtures have independent PostgreSQL predicates and paired state changes',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 for(const task of fixtures.TASKS){
  const f=await fixtures.seed(db,task);const before=await fixtures.verify(db,f,'');assert.equal(before.achieved,false);
  assert.ok(Object.values(before.checks).every(Boolean),JSON.stringify(before.checks));
  if(task.id==='changing-stock'){
   assert.equal(await fixtures.perturb(db,f,{sku:'CEDAR-63'}),true);f.expectedReadState=await fixtures.snapshot(db,f);
   assert.equal(await fixtures.perturb(db,f,{sku:'CEDAR-63'}),false);
   assert.equal((await fixtures.verify(db,f,'Draft order requests 16, North warehouse has 13, shortage 3.')).achieved,true);
  }
 }
});
