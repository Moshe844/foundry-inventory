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
  const estimate=await control.saveCostRate(db,{provider:'fixture-unknown',operation:'request',unit:'request',
   costPerUnitMinor:.25,effectiveFrom:'2026-01-01T00:00:00Z',source:'Conservative fixture estimate; not an invoice',
   pricingBasis:'CONSERVATIVE_ESTIMATE',confidence:'LOW'});
  const repriced=(await db.query('SELECT amount_minor,rate_id,detail FROM commercial_cost_events WHERE id=$1',[missing.event.id])).rows[0];
  assert.equal(Number(repriced.amount_minor),.25);assert.equal(repriced.rate_id,estimate.id);
  assert.equal(repriced.detail.costRateMissing,false);
  assert.equal(repriced.detail.costBasis,'CONSERVATIVE_ESTIMATE');
  assert.equal((await db.query("SELECT status FROM commercial_critical_warnings WHERE fingerprint=$1",
   [`cost-rate:${first.accountId}:fixture-unknown:request:request::`])).rows[0].status,'RESOLVED');
  const zero=await control.recordCost(db,{accountId:first.accountId},{provider:'fixture-explicit',operation:'request',unit:'request',quantity:1,amountMinor:0,idempotencyKey:'explicit-zero'});
  assert.equal(Number(zero.event.amount_minor),0);
  await db.query("UPDATE account_subscriptions SET current_period_start='2026-10-01T00:00:00Z',current_period_end='2026-11-01T00:00:00Z' WHERE id='period-cost-sub'");
  await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE status='OPEN'");
  const economics=await control.economics(db,{accountId:first.accountId},{now:'2026-10-05'});
  assert.equal(economics.costCoverage,'ESTIMATED');assert.equal(economics.contributionMarginPercent,null);
  assert.ok(economics.conservativeEstimatedCostSubtotalMinor>=.25);
  assert.ok(economics.measuredCostSubtotalMinor>0);
 });
 await t.test('known pinned Stripe request warning is backfilled with evidence without creating a zero rate',async()=>{
  const control=require('../../src/commercial/control-service');
  const fs=require('node:fs'),path=require('node:path');
  const old=await control.recordCost(db,{accountId:first.accountId},{provider:'stripe_billing',operation:'http_request',
   unit:'request',quantity:1,providerVersion:'2026-09-30.endive',idempotencyKey:'old-stripe-http',
   detail:{hostname:'api.stripe.com',httpStatus:200}});
  assert.equal(old.event.amount_minor,null);
  const migration=fs.readFileSync(path.join(__dirname,'../../src/db/postgres-migrations/034-commercial-stripe-request-evidence.sql'),'utf8');
  await db.query(migration);
  const repaired=(await db.query('SELECT amount_minor,rate_id,detail FROM commercial_cost_events WHERE id=$1',[old.event.id])).rows[0];
  assert.equal(Number(repaired.amount_minor),0);assert.equal(repaired.rate_id,null);
  assert.equal(repaired.detail.costBasis,'VERIFIED_NO_INCREMENTAL_REQUEST_FEE');
  assert.equal((await db.query('SELECT status FROM commercial_critical_warnings WHERE fingerprint=$1',
   [`cost-rate:${first.accountId}:stripe_billing:http_request:request::2026-09-30.endive`])).rows[0].status,'RESOLVED');
 });
 await t.test('Gmail quota attempts are sourced no-fee, while OAuth and alert delivery carry bounded estimates',async()=>{
  const network=require('../../src/commercial/network');const control=require('../../src/commercial/control-service');
  const scope={accountId:first.accountId,workspaceId:first.workspaceId};
  await network.after({database:db,scope,requestId:'gmail-quota-fixture'},
   {def:{provider:'gmail',version:'v1',host:'gmail.googleapis.com'},key:'gmail-quota-fixture',funded:true,
    url:'https://gmail.googleapis.com/gmail/v1/users/me/messages',method:'GET'},true,{status:200});
  const gmail=(await db.query("SELECT * FROM commercial_cost_events WHERE provider='gmail' AND idempotency_key='gmail-quota-fixture'")).rows[0];
  assert.equal(gmail.operation,'gmail_api_quota');assert.equal(gmail.unit,'quota_unit');
  assert.equal(Number(gmail.quantity),5);assert.equal(Number(gmail.amount_minor),0);
  assert.equal(gmail.detail.providerOperation,'messages.list');
  assert.equal(gmail.detail.costBasis,'VERIFIED_NO_INCREMENTAL_GMAIL_API_FEE_BELOW_RESERVED_DAILY_THRESHOLD');
  const oauth=network.definition('https://oauth2.googleapis.com/token');
  assert.equal(oauth.provider,'google_oauth');assert.equal(oauth.version,'oauth2-v1');
  const token=await control.recordCost(db,scope,{provider:oauth.provider,operation:'http_request',
   providerVersion:oauth.version,unit:'request',quantity:1,idempotencyKey:'oauth-estimate'});
  assert.equal(Number(token.event.amount_minor),.1);
  assert.equal(token.event.detail.costConfidence,'LOW');
  const alert=await control.recordCost(db,scope,{provider:'stockchief-alert-responder.mysolutionstesting.workers.dev',
   operation:'operational_alert',providerVersion:'webhook-v1',unit:'request',quantity:1,
   idempotencyKey:'alert-estimate'});
  assert.equal(Number(alert.event.amount_minor),.1);
  const novel=await control.recordCost(db,scope,{provider:'gmail',operation:'unclassified_future_method',
   providerVersion:'v2',unit:'request',quantity:1,idempotencyKey:'novel-gmail'});
  assert.equal(novel.event.amount_minor,null);
  assert.equal((await db.query("SELECT status FROM commercial_critical_warnings WHERE fingerprint=$1",
   [`cost-rate:${first.accountId}:gmail:unclassified_future_method:request::v2`])).rows[0].status,'OPEN');
 });
 await t.test('Stripe REST attempts are evidenced non-incremental; novel paid endpoints still fail cost coverage',async()=>{
  const network=require('../../src/commercial/network');
  const context={database:db,scope:{accountId:first.accountId,workspaceId:first.workspaceId},requestId:'stripe-cost-fixture'};
  await network.after(context,{billing:true,def:{provider:'stripe',version:'2026-09-30.endive',host:'api.stripe.com'},
   key:'stripe-http-known',url:'https://api.stripe.com/v1/invoices/in_fixture',method:'GET'},true,{httpStatus:200});
  const known=(await db.query("SELECT * FROM commercial_cost_events WHERE idempotency_key='stripe-http-known'")).rows[0];
  assert.equal(Number(known.amount_minor),0);assert.equal(known.rate_id,null);
  assert.equal(known.detail.costBasis,'VERIFIED_NO_INCREMENTAL_REQUEST_FEE');
  assert.equal(known.detail.feeResponsibility,'NO_INCREMENTAL_HTTP_REQUEST_FEE');
  await network.after(context,{billing:true,def:{provider:'stripe',version:'2026-09-30.endive',host:'api.stripe.com'},
   key:'stripe-http-unknown',url:'https://api.stripe.com/v1/tax/calculations',method:'POST'},true,{httpStatus:200});
  const unknown=(await db.query("SELECT amount_minor FROM commercial_cost_events WHERE idempotency_key='stripe-http-unknown'")).rows[0];
  assert.equal(unknown.amount_minor,null);
  assert.equal((await db.query("SELECT status FROM commercial_critical_warnings WHERE fingerprint=$1",
   [`cost-rate:${first.accountId}:stripe_billing:http_request:request::2026-09-30.endive`])).rows[0].status,'OPEN');
 });
});
