'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('payment evidence applies the accepted date scope and preserves independently posted invoice allocations',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Scope owner',businessName:'Payment scope',email:randomUUID()+'@example.test',password:'Scope!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{startDate:'2000-01-01',currency:'USD'});
 const customer=await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'Scope customer'}),now=new Date(),day=d=>d.toISOString().slice(0,10),today=day(now),yesterday=day(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-1))),lastMonth=day(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,10)));
 const posted=[];
 for(const [date,amount]of [[yesterday,50],[today,30],[lastMonth,20]]){
  const invoice=await require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{customerId:customer.id,description:'Recorded invoice '+date,quantity:1,unitAmount:String(amount),issueDate:date,idempotencyKey:randomUUID()});
  const payment=await require('../../src/operations/postgres-business-workflows').recordCustomerPayment(db,ctx,{customerId:customer.id,customerInvoiceId:invoice.id,amountMinor:amount*100,paymentDate:date,currency:'USD',method:'cash',idempotencyKey:randomUUID()});posted.push({invoice,payment,date,amount});
 }
 const assistant=require('../../src/assistant/postgres-service'),before=Number((await db.query('SELECT count(*) AS n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 const current=await assistant.lookup(db,ctx,{view:'payments',timeframe:'today'});
 assert.equal(current.rows.length,1,'Recorded live failure: read.payments accepted today but returned yesterday too');assert.equal(current.rows[0].date,today);assert.equal(current.rows[0].amountMinor,3000);assert.equal(current.rows[0].currency,'USD');
 assert.deepEqual(current.rows[0].allocations,[{document:posted[1].invoice.invoice_number,kind:'customer_invoice',amountMinor:3000,currency:'USD'}]);assert.equal(current.scope.basis,'payment_date');assert.equal(current.scope.from,today);assert.equal(current.scope.to,today);
 const all=await assistant.lookup(db,ctx,{view:'payments',timeframe:'all_time'});assert.equal(all.rows.length,3);
 for(const timeframe of ['month_to_date','previous_month','last_30_days']){const r=await assistant.lookup(db,ctx,{view:'payments',timeframe});assert(r.rows.every(row=>row.date>=r.scope.from&&row.date<=r.scope.to));}
 const invalid=await assistant.lookup(db,ctx,{view:'payments',timeframe:'unsupported'});assert.equal(invalid.status,'CLARIFY');assert.deepEqual(invalid.rows,[]);
 const foreign=await auth.createBusiness(db,{name:'Foreign',businessName:'Other payments',email:randomUUID()+'@example.test',password:'Scope!'+randomUUID()});assert.equal((await assistant.lookup(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},{view:'payments',timeframe:'all_time'})).rows.length,0);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),before);
 t.diagnostic(JSON.stringify({recordedTemporalScopeFailureReproduced:true,canonicalPostingAndAllocations:true,tenantIsolation:true,paidCalls:0}));
});
