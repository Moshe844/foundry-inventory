'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');const auth=require('../../src/domain/postgres-auth-service');
const costs=require('../../src/commercial/provider-costs');
test('actual provider invoices allocate every cent once with administrator attestation and immutable evidence',{timeout:120000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const first=await auth.createBusiness(db,{name:'Cost Admin',businessName:'Costs',email:'cost-admin@example.test',password:'Cost-admin-password!'});
 const second=await auth.createBusiness(db,{name:'Other',businessName:'Other',email:'cost-other@example.test',password:'Cost-other-password!'});
 const input={provider:'render',externalLineId:'invoice-fixture:line1',resourceId:'srv_fixture',amountMinor:101,currency:'USD',
  evidenceReference:'provider-invoice:fixture',evidenceSha256:'a'.repeat(64),periodStart:'2026-10-01',periodEnd:'2026-11-01',
  allocationBasis:'Fixture measured account request-seconds; no unmeasured accounts',excludesAlreadyMeteredDirectCosts:true,
  allocations:[{accountId:first.accountId,weight:1},{accountId:second.accountId,weight:2}]};
 await assert.rejects(()=>costs.ingest(db,input,first.accountId),/administrator/);
 await db.query("INSERT INTO commercial_admin_accounts(account_id,granted_by) VALUES($1,'certification-fixture')",[first.accountId]);
 const results=await Promise.all(Array.from({length:5},()=>costs.ingest(db,input,first.accountId)));
 assert.equal(results.filter(x=>x.created).length,1);
 const allocations=(await db.query('SELECT amount_minor FROM commercial_provider_cost_allocations ORDER BY amount_minor')).rows;
 assert.deepEqual(allocations.map(x=>Number(x.amount_minor)),[34,67]);
 const ledger=(await db.query("SELECT count(*) AS n,SUM(amount_minor) AS total FROM commercial_cost_events WHERE provider='render'")).rows[0];
 assert.equal(Number(ledger.n),2);assert.equal(Number(ledger.total),101);
 await assert.rejects(()=>costs.ingest(db,{...input,amountMinor:102},first.accountId),/different evidence/);
 await assert.rejects(()=>costs.ingest(db,{...input,externalLineId:'bad-owner',allocations:[{accountId:'foreign-missing',weight:1}]},first.accountId),/unknown/);
 await assert.rejects(()=>costs.ingest(db,{...input,externalLineId:'missing-evidence',evidenceSha256:''},first.accountId),/evidence/);
 assert.equal((await db.query("SELECT status FROM commercial_critical_warnings WHERE fingerprint='infrastructure-cost-contracts'")).rows[0].status,'OPEN');
 assert.equal(costs.allocate(0,[{accountId:first.accountId,weight:1}])[0].amountMinor,0);
 assert.throws(()=>costs.normalize({...input,excludesAlreadyMeteredDirectCosts:false}),/evidence/);
 for(const amountMinor of [null,undefined,'',false])assert.throws(()=>costs.normalize({...input,amountMinor}),/actual amount/);
});
