'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('open balances cover all documents beyond the detail page without mixing currency, disputed records or tenants',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),commerce=require('../../src/operations/postgres-commerce'),lookup=require('../../src/assistant/postgres-service').lookup;
 const create=async()=>{const o=await auth.createBusiness(db,{name:'Owner',businessName:randomUUID(),email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});const c={workspaceId:o.workspaceId,actorId:o.userId};await require('../../src/accounting/postgres-ledger').configure(db,c,{currency:'USD',startDate:'2026-01-01'});return c;};
 const ctx=await create(),foreign=await create();
 const customer=await commerce.createCustomer(db,ctx,{name:'Recorded buyer'}),supplier=await commerce.createSupplier(db,ctx,{name:'Recorded supplier',currency:'USD'});
 // These are read-only evidence fixtures, including retained foreign-currency
 // and disputed documents. No canonical posting or payment is bypassed in app code.
 for(const [table,number,key,party]of [['accounting_customer_invoices','invoice_number','customer_id',customer.id],['accounting_supplier_bills','bill_number','supplier_id',supplier.id]]){
  await db.query(`INSERT INTO ${table}(id,workspace_id,${number},${key},issue_date,due_date,status,currency,total_minor,balance_minor,source_key,created_at,updated_at)
   SELECT $1||n,$2,'DOC-'||n,$3,'2026-01-01',CASE WHEN n=102 THEN '2026-12-31' ELSE NULL END,
    CASE n WHEN 103 THEN 'PAID' WHEN 104 THEN 'VOID' WHEN 105 THEN 'DRAFT' ELSE 'OPEN' END,
    CASE WHEN n=102 THEN 'JPY' ELSE 'USD' END,CASE WHEN n=102 THEN 199 ELSE 101 END,
    CASE WHEN n=103 THEN 0 WHEN n=102 THEN 199 ELSE 101 END,$1||n,'2026-01-01','2026-01-01' FROM generate_series(1,105) n`,[randomUUID(),ctx.workspaceId,party]);
 }
 await db.query(`INSERT INTO accounting_supplier_bills(id,workspace_id,bill_number,supplier_id,issue_date,status,currency,total_minor,balance_minor,source_key,created_at,updated_at)
  SELECT $1||n,$2,'DISPUTE-'||n,$3,'2026-01-01','DISPUTED','USD',999,999,$1||n,'2026-01-01','2026-01-01' FROM generate_series(1,101) n`,[randomUUID(),ctx.workspaceId,supplier.id]);
 const fp=await commerce.createCustomer(db,foreign,{name:'FOREIGN RECORD'});
 await db.query(`INSERT INTO accounting_customer_invoices(id,workspace_id,invoice_number,customer_id,issue_date,status,currency,total_minor,balance_minor,source_key,created_at,updated_at) VALUES($1,$2,$1,$3,'2026-01-01','OPEN','USD',999999,999999,$1,'2026-01-01','2026-01-01')`,[randomUUID(),foreign.workspaceId,fp.id]);
 for(const view of ['receivables','payables']){const r=await lookup(db,ctx,{view});assert(r.totalsComplete);assert.equal(r.extent.postedDocuments,102);assert.equal(r.extent.complete,false);assert.equal(r.extent.disputedDocuments,view==='payables'?101:0);assert.equal(r.rows.filter(row=>row.balanceMinor!==null).length,100);
  assert.deepEqual(r.totalsByCurrency.map(({currency,documents,balanceMinor})=>({currency,documents,balanceMinor})),[{currency:'JPY',documents:1,balanceMinor:199},{currency:'USD',documents:101,balanceMinor:10201}]);assert.match(r.answer,/102 open/);assert(!JSON.stringify(r).includes('FOREIGN RECORD'));assert(r.rows.every(row=>row.status!=='VOID'&&row.status!=='DRAFT'&&row.status!=='PAID'));
  const one=await lookup(db,ctx,{view,search:'DOC-102'});assert.equal(one.extent.complete,true);assert.equal(one.rows.length,1);assert.equal(one.rows[0].currency,'JPY');assert.equal(one.rows[0].balanceMinor,199);assert.equal(one.rows[0].due,'2026-12-31');
  const none=await lookup(db,ctx,{view,search:randomUUID()});assert.equal(none.extent.complete,true);assert.equal(none.extent.totalRows,0);assert.deepEqual(none.totalsByCurrency,[]);
 }
 const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 const report=await require('../../src/reports/postgres-service').run(db,ctx,actor,{dataset:'customer_invoices',columns:['invoice_number','currency','balance_minor','due_date'],filters:[{field:'invoice_number',operator:'equals',value:'DOC-102'},{field:'currency',operator:'equals',value:'JPY'}]});
 assert.equal(report.columnLabels.balance_minor,'Balance');assert.equal(report.columnLabels.invoice_number,'Invoice number');assert.equal(report.columnLabels.due_date,'Due date');assert.equal(Number(report.rows[0].balance_minor),199);assert.match(report.displayRows[0].balance_minor,/199/);assert(!report.displayRows[0].balance_minor.includes('1.99'));
 await db.query(`INSERT INTO accounting_customer_invoices(id,workspace_id,invoice_number,customer_id,issue_date,status,currency,total_minor,balance_minor,source_key,created_at,updated_at)
  SELECT $1||n,$2,'OVERFLOW-'||n,$3,'2026-01-01','OPEN','USD',9007199254740991,9007199254740991,$1||n,'2026-01-01','2026-01-01' FROM generate_series(1,2) n`,[randomUUID(),ctx.workspaceId,customer.id]);
 await assert.rejects(lookup(db,ctx,{view:'receivables',search:'OVERFLOW-'}),/exceeds exact supported precision/,'An unsafe combined amount must never be rounded into a verified balance');
 const before=(await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;assert.equal(before,0);
});
