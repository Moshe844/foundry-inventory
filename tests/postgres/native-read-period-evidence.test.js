'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded nine-round daily-profit investigation gets complete dated canonical evidence and never a silently unfiltered order list',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Period owner',businessName:'Period evidence',email:randomUUID()+'@example.test',password:'Period!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const ledger=require('../../src/accounting/postgres-ledger'),assistant=require('../../src/assistant/postgres-service');await ledger.configure(db,ctx,{startDate:'2000-01-01',currency:'USD'});
 const today=new Date().toISOString().slice(0,10),prior=new Date(Date.now()-86400000).toISOString().slice(0,10);
 for(const [date,revenue,cost]of [[prior,7500,125],[today,4200,1700]])await ledger.post(db,ctx,{postingDate:date,sourceKey:'period-'+randomUUID(),sourceType:'sale_fulfillment',description:'Dated independent journal fixture',lines:[{accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:revenue},{accountKey:'SALES_REVENUE',creditMinor:revenue},{accountKey:'COST_OF_GOODS_SOLD',debitMinor:cost},{accountKey:'INVENTORY_ASSET',creditMinor:cost}]});
 const before=(await db.query('SELECT count(*) AS n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const current=await assistant.lookup(db,ctx,{view:'sales_activity',timeframe:'today'}),metrics=new Map(current.rows.map(r=>[r.measure,r]));
 assert.equal(metrics.get('Posted revenue').amountMinor,4200);
 assert.equal(metrics.get('Posted cost of sales')?.amountMinor,1700,'Recorded live trace lost cost of sales even though its canonical report had already computed it');
 assert.equal(metrics.get('Posted gross profit')?.amountMinor,2500);for(const key of ['Posted revenue','Posted cost of sales','Posted gross profit'])assert.equal(metrics.get(key).currency,'USD');
 assert.deepEqual(current.scope,{from:today,to:today,financialBasis:'posting_date',orderBasis:'order_date'});
 const all=await assistant.lookup(db,ctx,{view:'sales_activity',timeframe:'all_time'});assert.equal(all.rows.find(r=>r.measure==='Posted gross profit').amountMinor,9875);
 for(const view of ['sales_orders','purchase_orders','inventory','connections']){const result=await assistant.lookup(db,ctx,{view,timeframe:'today'});assert.equal(result.status,'UNSUPPORTED_PERIOD',view+' must not return all-time/current rows as if today were applied');assert.deepEqual(result.rows,[]);}
 const catalogue=require('../../src/assistant/postgres-capability-registry').registry;
 assert.deepEqual(catalogue.get('read.sales_orders').argumentSchemas.timeframe().enum,['all_time']);assert(catalogue.get('read.sales_activity').argumentSchemas.timeframe().enum.includes('today'));
 const foreign=await auth.createBusiness(db,{name:'Other owner',businessName:'Other period',email:randomUUID()+'@example.test',password:'Period!'+randomUUID()});await ledger.configure(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},{startDate:'2000-01-01',currency:'USD'});const empty=await assistant.lookup(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},{view:'sales_activity',timeframe:'today'});assert(empty.rows.filter(r=>r.amountMinor!==undefined).every(r=>r.amountMinor===0));
 assert.equal((await db.query('SELECT count(*) AS n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before);
 t.diagnostic(JSON.stringify({recordedFailure:'facts-017, 2026-10-16, nine actual SDK model requests',completeCanonicalFinancialEvidence:true,unsupportedScopesFailClosed:true,tenantIsolation:true,modelCalls:0}));
});
