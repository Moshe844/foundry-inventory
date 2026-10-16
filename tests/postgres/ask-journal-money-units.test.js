'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded journal read preserves money units, posted scope, currency separation and tenant isolation',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),ledger=require('../../src/accounting/postgres-ledger');
 const create=async()=>{const u=await auth.createBusiness(db,{name:'Owner',businessName:'Books',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});const ctx={workspaceId:u.workspaceId,actorId:u.userId};await ledger.configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});return ctx;};
 const ctx=await create(),foreign=await create(),today=new Date().toISOString().slice(0,10);
 const post=(scope,key,amount,currency,date=today)=>ledger.post(db,scope,{postingDate:date,sourceKey:key,description:'Unit evidence',currency,lines:[{accountKey:'CASH',debitMinor:amount},{accountKey:'SALES_REVENUE',creditMinor:amount}]});
 const usd=await post(ctx,'recorded-minor-unit-total',15250,'USD');await post(ctx,'independent-currency',4300,'EUR','2026-01-02');await post(foreign,'foreign-tenant',40000,'USD');
 const draft='draft-'+randomUUID();
 await db.query(`INSERT INTO accounting_journal_entries(id,workspace_id,entry_number,posting_date,period_id,description,status,source_type,source_key,created_by_type,engine_version,created_at)
 SELECT $1,workspace_id,99,posting_date,period_id,'Unposted draft','DRAFT',source_type,$1,created_by_type,engine_version,created_at FROM accounting_journal_entries WHERE id=$2`,[draft,usd.entry.id]);
 await db.query(`INSERT INTO accounting_journal_lines(id,workspace_id,entry_id,line_number,account_id,debit_minor,credit_minor,currency,created_at)
 SELECT $1||line_number,workspace_id,$1,line_number,account_id,CASE WHEN debit_minor>0 THEN 99900 ELSE 0 END,CASE WHEN credit_minor>0 THEN 99900 ELSE 0 END,currency,created_at FROM accounting_journal_lines WHERE entry_id=$2`,[draft,usd.entry.id]);
 const lookup=request=>require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'accounting',...request});
 const all=await lookup({timeframe:'all_time'});assert.equal(all.rows[0].value,2);assert.equal(all.rows[0].unit,'entries');
 assert.deepEqual(all.entryStates.counts,{DRAFT:1,POSTED:2});assert.equal(all.entryStates.total,3);assert.equal(all.entryStates.complete,true);
 assert.equal(all.rows.find(r=>r.state==='DRAFT').value,1);assert.equal(all.rows.find(r=>r.state==='DRAFT').amountMinor,null);
 const dollars=all.rows.find(r=>r.measure==='Debits'&&r.currency==='USD');assert.deepEqual(dollars,{measure:'Debits',value:'$152.50',unit:'money',amountMinor:15250,currency:'USD'});
 assert.equal(all.rows.find(r=>r.measure==='Credits'&&r.currency==='EUR').value,'€43.00');assert.match(all.answer,/USD: debits \$152\.50, credits \$152\.50/);assert(!all.answer.includes('$15,250'));
 const current=await lookup({timeframe:'today'});assert.equal(current.rows[0].value,1);assert.equal(current.rows.length,4);assert.equal(current.rows.find(r=>r.measure==='Debits').value,'$152.50');
 assert.deepEqual(current.entryStates.counts,{DRAFT:1,POSTED:1});assert.equal(current.entryStates.total,2);
 assert.equal((await lookup({timeframe:'unsupported'})).status,'CLARIFY');
 const another=await create(),empty=await require('../../src/assistant/postgres-service').lookup(db,another,{view:'accounting',timeframe:'all_time'});assert.equal(empty.rows[0].value,0);assert.equal(empty.rows.length,1);
 assert.deepEqual(empty.entryStates.counts,{});assert.equal(empty.entryStates.total,0);assert.equal(empty.entryStates.complete,true);
 // Absence from exhaustive scoped counts establishes zero recorded entries,
 // not a new supported journal state or permission to change its lifecycle.
 assert(!Object.hasOwn(all.entryStates.counts,'VOID'));assert.match(all.answer,/does not establish.*states.*supports/);
});
