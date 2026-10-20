'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded banking evidence separates statement states and permissions while empty collections remain discoverable',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),ledger=require('../../src/accounting/postgres-ledger'),banking=require('../../src/accounting/postgres-banking'),assistant=require('../../src/assistant/postgres-service');
 const create=async()=>{const o=await auth.createBusiness(db,{name:'Reviewer',businessName:randomUUID(),email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});const ctx={workspaceId:o.workspaceId,actorId:o.userId};await ledger.configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});return ctx;};
 const ctx=await create(),foreign=await create(),empty=await banking.inspect(db,ctx);
 assert(empty.available&&empty.complete);assert.deepEqual(empty.accounts,{total:0,active:0});assert.equal(empty.transactions.total,0);assert.deepEqual(empty.transactions.states,{});assert.equal(empty.statements.total,0);assert.match(empty.interpretation,/unestablished, not that balances match/);
 for(const [view,href]of [['customer_returns','/returns'],['transfers','/transfers'],['sales_orders','/orders'],['purchase_orders','/purchasing']]){
  const result=await assistant.lookup(db,ctx,{view});assert.equal(result.rows.length,0);assert.equal(result.handoff.href,href);
 }
 const store=require('../../src/assistant/postgres-goal-store'),goal=await store.claim(db,ctx,(await store.create(db,ctx,'Inspect an unfamiliar application area without changes.')).id);
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token});
 const named=await gateway.interfaces({names:['read.customer_returns','read.transfers','navigate.record.sales_order']});
 for(const c of named.operations){assert(c.collection?.href);assert(!c.collection.href.includes('://'));assert(!Object.hasOwn(c.collection,'authority'));}
 const addBank=async(scope,active)=>{const id=randomUUID(),account=(await db.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='CASH'",[scope.workspaceId])).rows[0];await db.query(`INSERT INTO accounting_bank_accounts(id,workspace_id,name,account_kind,currency,ledger_account_id,active,created_by_user_id,created_at,updated_at) VALUES($1,$2,$1,'BANK','USD',$3,$4,$5,$6,$6)`,[id,scope.workspaceId,account.id,active,scope.actorId,new Date().toISOString()]);return id;};
 const bank=await addBank(ctx,1);await addBank(ctx,0);await addBank(foreign,1);
 for(let n=0;n<205;n++)await banking.importOne(db,ctx,bank,{transactionDate:'2026-01-02',amount:'1.00',description:'Recorded fixture '+n,externalId:String(n)});
 // Disposable fixtures represent all recorded lifecycle states; no bank call,
 // payment, journal posting or reconciliation transition is bypassed in production.
 const lines=(await db.query('SELECT id FROM accounting_bank_transactions WHERE workspace_id=$1 ORDER BY id',[ctx.workspaceId])).rows;
 for(const [n,status]of ['MATCHED','EXCLUDED','RECONCILED'].entries())await db.query('UPDATE accounting_bank_transactions SET status=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,lines[n].id,status]);
 for(const[n,status]of ['COMPLETED','IN_PROGRESS','VOID'].entries())await db.query(`INSERT INTO accounting_reconciliations(id,workspace_id,bank_account_id,statement_end_date,statement_ending_balance_minor,ledger_ending_balance_minor,difference_minor,status,created_at,completed_at) VALUES($1,$2,$3,$4,$5,0,$5,$6,$7,$8)`,[randomUUID(),ctx.workspaceId,bank,'2026-01-0'+(n+2),n===1?100:0,status,'2026-01-05T10:00:00.000Z',n===0?'2026-01-05T11:00:00.000Z':null]);
 const read=await assistant.lookup(db,ctx,{view:'accounting',timeframe:'today'}),e=read.bankReconciliation;
 assert(e.available&&e.complete);assert.deepEqual(e.accounts,{total:2,active:1});assert.equal(e.transactions.total,205);assert.deepEqual(e.transactions.states,{EXCLUDED:1,MATCHED:1,RECONCILED:1,UNMATCHED:202});assert.equal(e.statements.total,3);assert.deepEqual(e.statements.states,{COMPLETED:1,IN_PROGRESS:1,VOID:1});assert.equal(e.statements.withRecordedDifference,1);assert.equal(e.statements.lastCompletedAt,'2026-01-05T11:00:00.000Z');assert.equal(read.entryStates.total,0);assert.match(e.scope,/independent of the journal/);assert.match(e.interpretation,/only to its saved statement date/);
 assert.equal((await banking.inspect(db,foreign)).transactions.total,0);
 // Explicitly revoke accounting visibility on the same membership. The read
 // cannot release banking state, and direct engine inspection also rejects it.
 await db.query("UPDATE users SET role='member',permissions='[\"VIEW\"]'::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 const restrictedCollections=await gateway.collections();
 assert(restrictedCollections['navigate.record.product']);
 for(const kind of ['customer_return','supplier_return','journal_entry','connection'])assert(!restrictedCollections['navigate.record.'+kind],kind+' must not leak through initial navigation metadata');
 await assert.rejects(banking.inspect(db,ctx),{code:'forbidden'});const denied=await assistant.lookup(db,ctx,{view:'accounting'});assert.equal(denied.bankReconciliation.available,false);assert.equal(denied.bankReconciliation.accounts,undefined);
 await assert.rejects(banking.inspect(db,{...ctx,actorId:foreign.actorId}),{code:'forbidden'});
});
