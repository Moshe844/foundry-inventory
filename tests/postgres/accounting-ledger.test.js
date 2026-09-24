'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const ledger=require('../../src/accounting/postgres-ledger');

test('native PostgreSQL accounting posts balanced immutable idempotent journals', {timeout:120000}, async(context)=>{
  const cluster=await startCluster(); const database=openPostgres(cluster.connectionString);
  context.after(async()=>{await database.close();cluster.stop();});
  await migratePostgres(database); const at='2026-09-23T00:00:00.000Z';
  await database.query(`INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES('a','books@example.test','Owner','x',$1)`,[at]);
  await database.query(`INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES('w','Books','a',$1)`,[at]);
  await database.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES('u','w','a','Owner','owner',$1)`,[at]);
  const ctx={workspaceId:'w',actorId:'u'};
  await ledger.configure(database,ctx,{startDate:'2026-01-01',currency:'USD'});
  const input={postingDate:'2026-09-23',sourceKey:'sale:one',description:'One sale',sourceType:'sale',
    lines:[{accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:1500},{accountKey:'SALES_REVENUE',creditMinor:1500}]};
  const results=await Promise.all([ledger.post(database,ctx,input),ledger.post(database,ctx,input)]);
  assert.equal(results.filter((entry)=>!entry.replayed).length,1);
  assert.equal((await database.query(`SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE workspace_id='w'`)).rows[0].count,'1');
  const totals=await database.query(`SELECT SUM(debit_minor) AS debit,SUM(credit_minor) AS credit FROM accounting_journal_lines WHERE workspace_id='w'`);
  assert.equal(totals.rows[0].debit,totals.rows[0].credit);
  await assert.rejects(ledger.post(database,ctx,{...input,sourceKey:'bad',lines:[{accountKey:'CASH',debitMinor:100},{accountKey:'SALES_REVENUE',creditMinor:99}]}),/not balanced/i);
  await assert.rejects(database.query(`UPDATE accounting_journal_entries SET description='rewritten' WHERE workspace_id='w'`),/immutable/i);
  await assert.rejects(database.query(`UPDATE accounting_journal_lines SET debit_minor=1 WHERE workspace_id='w'`),/immutable/i);
});
