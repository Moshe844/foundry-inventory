'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('bulk journals use bounded locks while preserving concurrent idempotency and balanced entries',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Bulk books',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},ledger=require('../../src/accounting/postgres-ledger');
 await ledger.configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
 const input=sourceKey=>({postingDate:'2026-10-01',sourceKey,sourceType:'fixture',lines:[{accountKey:'CASH',debitMinor:1},{accountKey:'SALES_REVENUE',creditMinor:1}]});
 await db.transaction(async c=>{
  const locks=async()=>Number((await c.query("SELECT count(*) AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n),before=await locks();
  for(let i=0;i<128;i++)await ledger.postInTransaction(c,ctx,input('bulk-'+i));
  assert((await locks())-before<=1,'bulk journal sources must not accumulate transaction locks');
  assert((await ledger.postInTransaction(c,ctx,input('bulk-63'))).replayed);
 },{isolation:'SERIALIZABLE',retrySafe:true});
 const same=await Promise.all(Array.from({length:8},()=>ledger.post(db,ctx,input('same-source'))));
 assert.equal(same.filter(r=>!r.replayed).length,1);
 await Promise.all(Array.from({length:8},(_,i)=>ledger.post(db,ctx,input('parallel-'+i))));
 const entries=(await db.query('SELECT entry_number,source_key FROM accounting_journal_entries WHERE workspace_id=$1 ORDER BY entry_number',[ctx.workspaceId])).rows;
 assert.equal(entries.length,137);assert.deepEqual(entries.map(r=>Number(r.entry_number)),Array.from({length:137},(_,i)=>i+1));assert.equal(new Set(entries.map(r=>r.source_key)).size,137);
 assert.equal((await db.query('SELECT sum(debit_minor)-sum(credit_minor) AS net FROM accounting_journal_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].net,'0');
 await assert.rejects(db.transaction(async c=>{await ledger.postInTransaction(c,ctx,input('rollback'));throw new Error('fixture rollback');}),/fixture rollback/);
 assert.equal((await db.query('SELECT count(*) AS n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'137');
 await assert.rejects(db.query('UPDATE accounting_journal_entries SET description=$1 WHERE workspace_id=$2',['rewrite',ctx.workspaceId]),/immutable/i);
});
