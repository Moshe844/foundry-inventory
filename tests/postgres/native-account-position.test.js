'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('native accounting exposes canonical as-of account balances without confusing gross postings, future cash or report authority',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),create=()=>auth.createBusiness(db,{name:'Account reader',businessName:randomUUID(),email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),owner=await create(),other=await create(),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},foreign={workspaceId:other.workspaceId,actorId:other.userId},ledger=require('../../src/accounting/postgres-ledger'),assistant=require('../../src/assistant/postgres-service'),today=new Date().toISOString().slice(0,10),tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
 await ledger.configure(db,ctx,{startDate:today,currency:'USD'});await ledger.configure(db,foreign,{startDate:today,currency:'USD'});
 const cash2=await ledger.createAccount(db,ctx,{code:randomUUID().slice(0,20),name:randomUUID(),type:'ASSET',subtype:'CASH'});
 const post=(scope,date,lines)=>ledger.post(db,scope,{sourceKey:randomUUID(),postingDate:date,description:'Disposable canonical balance fixture',sourceType:'opening_balances',lines});
 await post(ctx,today,[{accountKey:'CASH',debitMinor:10000},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:10000}]);
 await post(ctx,today,[{accountKey:'OPENING_BALANCE_EQUITY',debitMinor:1000},{accountId:cash2.id,creditMinor:1000}]);
 await post(ctx,tomorrow,[{accountKey:'CASH',debitMinor:50000},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:50000}]);
 await post(foreign,today,[{accountKey:'CASH',debitMinor:99999},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:99999}]);
 const result=await assistant.lookup(db,ctx,{view:'accounting'});assert(result.position.available);assert.equal(result.position.cashMinor,9000);assert.equal(result.position.cash,'$90.00');assert.equal(result.position.asOf,today);assert.equal(result.position.currency,'USD');assert.equal(result.position.assetMinor,9000);assert.equal(result.position.equityMinor,9000);assert.equal(result.position.balanced,true);assert.equal(result.position.accounts.find(a=>a.code===cash2.code).netMinor,-1000);assert(!JSON.stringify(result.position).includes('99999'));
 assert.equal(result.entryStates.counts.POSTED,3,'All-time journal counts retain their prior scope, separate from the as-of balance');
 const historical=await assistant.lookup(db,ctx,{view:'accounting',timeframe:'previous_month'});assert.equal(historical.position.cashMinor,0);assert(historical.position.asOf<today);assert.equal(historical.entryStates.total,0);
 await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,current_period_start,current_period_end,source)
  VALUES($1,$2,'growth','ACTIVE','MONTHLY',$3,$4,'TEST') ON CONFLICT(account_id) DO UPDATE SET plan_id='growth',plan_version_id=NULL,status='ACTIVE'`,[randomUUID(),owner.accountId,new Date(Date.now()-60000).toISOString(),new Date(Date.now()+30*86400000).toISOString()]);
 assert.equal((await require('../../src/commercial/entitlements').capabilityState(db,{accountId:owner.accountId,workspaceId:ctx.workspaceId},'accounting.reports')).enabled,true);
 const reportCapability=require('../../src/commercial/catalog').canonicalCapability('accounting.reports');
 await db.query('INSERT INTO commercial_entitlement_overrides(id,workspace_id,capability,enabled,reason,starts_at) VALUES($1,$2,$3,0,$4,$5)',[randomUUID(),ctx.workspaceId,reportCapability,'Disposable permission-revocation check',new Date(Date.now()-60000).toISOString()]);
 assert.equal((await require('../../src/commercial/entitlements').capabilityState(db,{accountId:owner.accountId,workspaceId:ctx.workspaceId},'accounting.reports')).enabled,false);
 const restricted=await assistant.lookup(db,ctx,{view:'accounting'});assert.equal(restricted.position.available,false);assert.equal(restricted.position.accounts,undefined);assert.equal(restricted.entryStates.counts.POSTED,3);
 t.diagnostic(JSON.stringify({canonicalAsOfBalances:true,negativeCashPreserved:true,futurePostingsExcludedFromCurrentBalance:true,postingCountsUnchanged:true,reportEntitlementFreshlyEnforced:true,tenantIsolation:true,paidCalls:0}));
});
