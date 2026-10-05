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
 await t.test('resource statements accrue over overlapping service periods without duplicate ledger postings',async()=>{
  const control=require('../../src/commercial/control-service');
  await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,current_period_start,current_period_end,source)
    VALUES('period-cost-sub',$1,'starter','ACTIVE','MONTHLY','2026-10-01T00:00:00Z','2026-11-01T00:00:00Z','TEST')`,[first.accountId]);
  const crossPeriod={...input,externalLineId:'cross-period',amountMinor:3000,periodStart:'2026-09-16',periodEnd:'2026-10-16',
    allocations:[{accountId:first.accountId,weight:1}]};
  await costs.ingest(db,crossPeriod,first.accountId);
  await costs.ingest(db,crossPeriod,first.accountId);
  const october=await control.economics(db,{accountId:first.accountId},{now:'2026-10-05'});
  assert.equal(october.knownCostSubtotalMinor,1534); // 15/30 days of 3000 + original October share 34
  assert.equal(october.costEventCount,2);assert.equal(october.estimatedCostMinor,null);
  assert.equal(october.costCoverage,'MISSING');assert.equal(october.contributionMarginPercent,null);
  await db.query("UPDATE account_subscriptions SET current_period_start='2026-09-01T00:00:00Z',current_period_end='2026-10-01T00:00:00Z' WHERE id='period-cost-sub'");
  const september=await control.economics(db,{accountId:first.accountId},{now:'2026-09-20'});
  assert.equal(september.knownCostSubtotalMinor,1500);assert.equal(september.costEventCount,1);
  assert.equal(september.knownCostSubtotalMinor+october.knownCostSubtotalMinor,3034);
  await db.query("UPDATE account_subscriptions SET current_period_start='2026-11-01T00:00:00Z',current_period_end='2026-12-01T00:00:00Z' WHERE id='period-cost-sub'");
  const november=await control.economics(db,{accountId:first.accountId},{now:'2026-11-05'});
  assert.equal(november.knownCostSubtotalMinor,0);assert.equal(november.costEventCount,0);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM commercial_cost_events WHERE detail->>'statementId' IN (SELECT id FROM commercial_provider_cost_statements WHERE external_line_id='cross-period')")).rows[0].n),1);
 });
 await t.test('explicit numeric zero is permitted but missing rate input is rejected',async()=>{
  const control=require('../../src/commercial/control-service');
  const rate=await control.saveCostRate(db,{provider:'fixture-free',operation:'request',unit:'request',costPerUnitMinor:'0',source:'Explicit fixture-only free contract'});
  assert.equal(Number(rate.cost_per_unit_minor),0);
  const missing=await control.recordCost(db,{accountId:first.accountId},{provider:'fixture-unknown',operation:'request',unit:'request',quantity:1,amountMinor:null,idempotencyKey:'still-unknown'});
  assert.equal(missing.event.amount_minor,null);
  const zero=await control.recordCost(db,{accountId:first.accountId},{provider:'fixture-explicit',operation:'request',unit:'request',quantity:1,amountMinor:0,idempotencyKey:'explicit-zero'});
  assert.equal(Number(zero.event.amount_minor),0);
 });
});
